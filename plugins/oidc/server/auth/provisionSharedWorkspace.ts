import { Op, type Transaction } from "sequelize";
import { CollectionPermission, UserRole } from "@shared/types";
import accountProvisioner from "@server/commands/accountProvisioner";
import groupsSyncer from "@server/commands/groupsSyncer";
import { createContext } from "@server/context";
import {
  AuthenticationProvider,
  Collection,
  Group,
  GroupMembership,
  User,
} from "@server/models";
import { sequelize } from "@server/storage/database";
import type { APIContext } from "@server/types";
import type { ExternalGroupData } from "@server/utils/GroupSyncProvider";
import config from "../../plugin.json";
import env from "../env";

/**
 * Reserved group token used to namespace the shared workspace's authentication
 * provider, mirroring the `${hostname}#${group}` scheme used for the per-group
 * isolation workspaces so the shared provider never collides with a real group.
 */
const SHARED_PROVIDER_KEY = "__shared__";

function sharedProviderId(oidcHostname: string): string {
  return `${oidcHostname}#${SHARED_PROVIDER_KEY}`;
}

type Props = {
  /** Details of the user logging in from the SSO provider. */
  user: {
    name: string;
    email: string;
    emailVerified?: boolean;
    avatarUrl?: string | null;
  };
  /** Details of the authentication from the SSO provider. */
  authentication: {
    providerId: string;
    scopes: string[];
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
  };
  /** The hostname of the OIDC provider, used to namespace the provider id. */
  oidcHostname: string;
  /** The department groups (already filtered) the user belongs to. */
  departmentGroups: string[];
  /** Whether the user is a shared-workspace admin (e.g. party-admin). */
  isAdmin: boolean;
};

/**
 * Provisions the user into a single shared Outline workspace that sits
 * alongside the per-group isolation workspaces. Within it, every user is a
 * read-only member by default; each department the user belongs to is synced to
 * an internal Group that is granted write access to a matching, otherwise
 * read-only collection; and shared-workspace admins are promoted to the Outline
 * admin role with write access to every collection.
 *
 * Membership sync reuses {@link groupsSyncer} directly (rather than the
 * PluginManager GroupSyncProvider hook) so it is scoped to this team and does
 * not depend on the provider's `groupSyncEnabled` setting existing on first
 * login. Failures are the caller's responsibility to isolate from the primary
 * login.
 *
 * @param ctx - the API context of the current login.
 * @param props - the user, authentication, and group details.
 */
export async function provisionSharedWorkspace(
  ctx: APIContext,
  { user, authentication, oidcHostname, departmentGroups, isAdmin }: Props
): Promise<void> {
  const providerId = sharedProviderId(oidcHostname);

  // Provision (or join) the shared team, reusing the standard flow. This runs
  // its own transactions, so it must complete before the reconciliation below.
  const result = await accountProvisioner(ctx, {
    team: {
      name: env.OIDC_SHARED_TEAM_NAME ?? env.APP_NAME,
      subdomain: env.OIDC_SHARED_TEAM_NAME ?? env.APP_NAME,
    },
    user,
    authenticationProvider: { name: config.id, providerId },
    authentication,
  });
  const { team } = result;
  const member = result.user;

  // A member who previously left every group and is now back must be
  // reactivated explicitly; userProvisioner's update path does not clear it.
  if (member.suspendedAt) {
    await member.updateWithCtx(
      ctx,
      { suspendedAt: null, suspendedById: null },
      { name: "activate" }
    );
  }

  const authenticationProvider = await AuthenticationProvider.findOne({
    where: { name: config.id, teamId: team.id, providerId },
  });
  if (!authenticationProvider) {
    throw new Error(
      `Shared workspace authentication provider ${providerId} not found after provisioning`
    );
  }

  // The admin group is only synced (and granted) for actual admins, so a
  // non-admin never gains its write-everywhere access.
  const externalGroups: ExternalGroupData[] = departmentGroups.map((name) => ({
    id: name,
    name,
  }));
  if (isAdmin) {
    externalGroups.push({
      id: env.OIDC_SHARED_ADMIN_GROUP,
      name: env.OIDC_SHARED_ADMIN_GROUP,
    });
  }

  await sequelize.transaction(async (transaction) => {
    const txCtx = createContext({
      user: member,
      ip: ctx.context?.ip,
      transaction,
    });

    // Sync the user's department (+ admin) groups to internal Outline Groups,
    // creating any that don't yet exist and removing stale memberships.
    await groupsSyncer(txCtx, {
      user: member,
      team,
      authenticationProvider,
      externalGroups,
    });

    // Only admins may create top-level collections in the shared workspace.
    if (team.memberCollectionCreate) {
      await team.update({ memberCollectionCreate: false }, { transaction });
    }

    await reconcileCollections(txCtx, {
      team,
      member,
      departmentGroups,
      isAdmin,
      transaction,
    });

    await reconcileRole(txCtx, { team, member, isAdmin, transaction });
  });
}

/**
 * Ensures a read-only-by-default collection exists for each of the user's
 * departments with the department group granted write, and — for an admin —
 * that the admin group has write on every collection in the workspace.
 */
async function reconcileCollections(
  ctx: APIContext,
  {
    team,
    member,
    departmentGroups,
    isAdmin,
    transaction,
  }: {
    team: { id: string };
    member: User;
    departmentGroups: string[];
    isAdmin: boolean;
    transaction: Transaction;
  }
): Promise<void> {
  for (const name of departmentGroups) {
    const group = await Group.findOne({
      where: { teamId: team.id, name },
      transaction,
    });
    // groupsSyncer just created/linked it; skip defensively if missing.
    if (!group) {
      continue;
    }

    const collection = await ensureCollection(ctx, {
      teamId: team.id,
      member,
      name,
      transaction,
    });
    await ensureGroupMembership(ctx, {
      collectionId: collection.id,
      group,
      member,
      transaction,
    });
  }

  // Extend the admin group's write access to every existing collection,
  // covering collections created before this admin (or their group) existed.
  if (isAdmin) {
    const adminGroup = await Group.findOne({
      where: { teamId: team.id, name: env.OIDC_SHARED_ADMIN_GROUP },
      transaction,
    });
    if (adminGroup) {
      const collections = await Collection.findAll({
        where: { teamId: team.id },
        transaction,
      });
      for (const collection of collections) {
        await ensureGroupMembership(ctx, {
          collectionId: collection.id,
          group: adminGroup,
          member,
          transaction,
        });
      }
    }
  }
}

/**
 * Finds the department collection by its (stable, machine) name or creates it as
 * read-only for the whole workspace. A newly created collection immediately
 * inherits the admin group's write access if that group already exists.
 */
async function ensureCollection(
  ctx: APIContext,
  {
    teamId,
    member,
    name,
    transaction,
  }: {
    teamId: string;
    member: User;
    name: string;
    transaction: Transaction;
  }
): Promise<Collection> {
  const existing = await Collection.findOne({
    where: { teamId, name },
    transaction,
  });
  if (existing) {
    return existing;
  }

  const collection = await Collection.createWithCtx(ctx, {
    name,
    teamId,
    createdById: member.id,
    permission: CollectionPermission.Read,
    sort: Collection.DEFAULT_SORT,
  });

  const adminGroup = await Group.findOne({
    where: { teamId, name: env.OIDC_SHARED_ADMIN_GROUP },
    transaction,
  });
  if (adminGroup) {
    await ensureGroupMembership(ctx, {
      collectionId: collection.id,
      group: adminGroup,
      member,
      transaction,
    });
  }

  return collection;
}

/**
 * Idempotently grants a group read_write access to a collection.
 */
async function ensureGroupMembership(
  ctx: APIContext,
  {
    collectionId,
    group,
    member,
    transaction,
  }: {
    collectionId: string;
    group: Group;
    member: User;
    transaction: Transaction;
  }
): Promise<void> {
  const existing = await GroupMembership.findOne({
    where: { collectionId, groupId: group.id },
    transaction,
  });
  if (existing) {
    if (existing.permission !== CollectionPermission.ReadWrite) {
      existing.permission = CollectionPermission.ReadWrite;
      await existing.save({ transaction });
    }
    return;
  }

  await GroupMembership.createWithCtx(ctx, {
    collectionId,
    groupId: group.id,
    permission: CollectionPermission.ReadWrite,
    createdById: member.id,
  });
}

/**
 * Promotes shared-workspace admins to the Outline admin role and demotes users
 * who are no longer admins back to member — guarding against demoting the team's
 * last remaining admin, which would leave the workspace unmanageable.
 */
async function reconcileRole(
  ctx: APIContext,
  {
    team,
    member,
    isAdmin,
    transaction,
  }: {
    team: { id: string };
    member: User;
    isAdmin: boolean;
    transaction: Transaction;
  }
): Promise<void> {
  const desired = isAdmin ? UserRole.Admin : UserRole.Member;
  if (member.role === desired) {
    return;
  }

  if (desired === UserRole.Member && member.role === UserRole.Admin) {
    const otherAdmins = await User.count({
      where: {
        teamId: team.id,
        role: UserRole.Admin,
        id: { [Op.ne]: member.id },
        suspendedAt: { [Op.eq]: null },
      },
      transaction,
    });
    if (otherAdmins === 0) {
      return;
    }
  }

  await member.update({ role: desired }, { transaction });
}
