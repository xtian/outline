import { Op } from "sequelize";
import { toError } from "@shared/utils/error";
import type { AccountProvisionerResult } from "@server/commands/accountProvisioner";
import accountProvisioner from "@server/commands/accountProvisioner";
import { AuthenticationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import { AuthenticationProvider, User } from "@server/models";
import type { APIContext } from "@server/types";
import config from "../../plugin.json";

type Props = {
  /** The normalized list of groups the user belongs to in the provider. */
  groups: string[];
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
  /** The hostname of the OIDC provider, used to namespace group providerIds. */
  oidcHostname: string;
  /**
   * The internal ID of the team the request originated from (based on the
   * subdomain), used to prefer that team as the landing workspace if the user
   * belongs to it.
   */
  requestTeamId?: string;
};

/**
 * Builds the AuthenticationProvider providerId for a group-isolated workspace.
 * The group identifier is namespaced by the OIDC hostname so that each group
 * maps to a distinct provider (and therefore a distinct Team), while remaining
 * distinguishable from providers belonging to other OIDC deployments.
 */
function providerIdForGroup(oidcHostname: string, group: string): string {
  return `${oidcHostname}#${group}`;
}

/**
 * Provisions a user into one Outline workspace (Team) per OIDC group they
 * belong to, reusing the standard account provisioning flow for each. Groups
 * the user has since left are reconciled by suspending their membership in the
 * corresponding workspace, and a previously suspended membership is reactivated
 * when the group reappears. Isolation between groups is provided by Outline's
 * existing per-team tenant boundary.
 *
 * @param ctx - the API context of the current login.
 * @param props - the groups, user, and authentication details.
 * @returns the account provisioner result for the landing workspace.
 * @throws {AuthenticationError} if no workspace could be provisioned.
 */
export async function provisionGroupTeams(
  ctx: APIContext,
  { groups, user, authentication, oidcHostname, requestTeamId }: Props
): Promise<AccountProvisionerResult> {
  // Defensive: ensure a stable, de-duplicated ordering for landing selection.
  const sortedGroups = Array.from(new Set(groups)).sort();

  const provisioned: Array<{ group: string; result: AccountProvisionerResult }> =
    [];

  for (const group of sortedGroups) {
    try {
      const result = await accountProvisioner(ctx, {
        team: {
          name: group,
          // teamCreator resolves subdomain collisions, so a best-effort slug is
          // sufficient here. Intentionally omit `domain` so group workspaces are
          // not constrained to a single email domain — a group may span domains.
          subdomain: group,
        },
        user,
        authenticationProvider: {
          name: config.id,
          providerId: providerIdForGroup(oidcHostname, group),
        },
        authentication,
      });

      // userProvisioner's update path does not clear suspension, so a member who
      // was previously removed from this group and is now back must be
      // reactivated explicitly.
      if (result.user.suspendedAt) {
        await result.user.updateWithCtx(
          ctx,
          {
            suspendedAt: null,
            suspendedById: null,
          },
          {
            name: "activate",
          }
        );
      }

      provisioned.push({ group, result });
    } catch (err) {
      // A single group failing to provision should not block access to the
      // user's other workspaces; it will be retried on the next login.
      Logger.error(
        "Failed to provision group workspace during OIDC login",
        toError(err),
        {
          email: user.email,
          group,
        }
      );
    }
  }

  if (provisioned.length === 0) {
    throw AuthenticationError(
      "Unable to provision a workspace for any of your groups."
    );
  }

  await reconcileStaleMemberships(ctx, {
    email: user.email,
    oidcHostname,
    activeGroups: new Set(sortedGroups),
  });

  // Prefer the workspace the request originated from, otherwise land on the
  // first group deterministically.
  const landing =
    (requestTeamId &&
      provisioned.find((entry) => entry.result.team.id === requestTeamId)) ||
    provisioned[0];

  return landing.result;
}

/**
 * Suspends this user's membership in any group workspace whose group is no
 * longer present in the provider's claim, enforcing isolation over time.
 */
async function reconcileStaleMemberships(
  ctx: APIContext,
  {
    email,
    oidcHostname,
    activeGroups,
  }: { email: string; oidcHostname: string; activeGroups: Set<string> }
): Promise<void> {
  const prefix = `${oidcHostname}#`;
  const providers = await AuthenticationProvider.findAll({
    where: {
      name: config.id,
      providerId: {
        [Op.like]: `${prefix}%`,
      },
    },
  });

  const staleTeamIds = providers
    .filter((provider) => !activeGroups.has(provider.providerId.slice(prefix.length)))
    .map((provider) => provider.teamId);

  if (staleTeamIds.length === 0) {
    return;
  }

  const staleUsers = await User.findAll({
    where: {
      email: {
        [Op.iLike]: email,
      },
      teamId: {
        [Op.in]: staleTeamIds,
      },
      suspendedAt: {
        [Op.eq]: null,
      },
    },
  });

  for (const staleUser of staleUsers) {
    await staleUser.updateWithCtx(
      ctx,
      {
        suspendedAt: new Date(),
        suspendedById: null,
      },
      {
        name: "suspend",
      }
    );
  }
}
