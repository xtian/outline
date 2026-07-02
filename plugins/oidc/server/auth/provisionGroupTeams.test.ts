import { faker } from "@faker-js/faker";
import { randomUUID } from "node:crypto";
import { AuthenticationProvider, User } from "@server/models";
import { createContext } from "@server/context";
import { provisionGroupTeams } from "./provisionGroupTeams";

describe("provisionGroupTeams", () => {
  const ip = faker.internet.ip();
  const ctx = createContext({ ip });
  const oidcHostname = "idp.example.com";

  const buildAuthentication = () => ({
    providerId: randomUUID(),
    accessToken: "access-token",
    scopes: ["openid", "groups"],
  });

  const buildUserParams = (email: string) => ({
    name: "Jenny Tester",
    email,
    emailVerified: true,
    avatarUrl: faker.image.avatar(),
  });

  it("provisions one workspace per group, each with a namespaced provider", async () => {
    const email = faker.internet.email().toLowerCase();
    const groups = ["alpha", "beta"];

    await provisionGroupTeams(ctx, {
      groups,
      user: buildUserParams(email),
      authentication: buildAuthentication(),
      oidcHostname,
    });

    const users = await User.findAll({ where: { email } });
    expect(users.length).toEqual(2);

    for (const group of groups) {
      const provider = await AuthenticationProvider.findOne({
        where: { name: "oidc", providerId: `${oidcHostname}#${group}` },
      });
      expect(provider).not.toBeNull();
      const teamUser = users.find((u) => u.teamId === provider!.teamId);
      expect(teamUser).toBeDefined();
      expect(teamUser!.suspendedAt).toBeNull();
    }
  });

  it("surfaces all workspaces through availableTeams for a multi-group user", async () => {
    const email = faker.internet.email().toLowerCase();

    const landing = await provisionGroupTeams(ctx, {
      groups: ["one", "two", "three"],
      user: buildUserParams(email),
      authentication: buildAuthentication(),
      oidcHostname,
    });

    const available = await landing.user.availableTeams();
    expect(available.length).toEqual(3);
  });

  it("suspends membership when a group is dropped and reactivates when re-added", async () => {
    const email = faker.internet.email().toLowerCase();
    const authentication = buildAuthentication();

    await provisionGroupTeams(ctx, {
      groups: ["keep", "drop"],
      user: buildUserParams(email),
      authentication,
      oidcHostname,
    });

    const droppedProvider = await AuthenticationProvider.findOne({
      where: { name: "oidc", providerId: `${oidcHostname}#drop` },
    });

    // Second login without the "drop" group should suspend that membership.
    await provisionGroupTeams(ctx, {
      groups: ["keep"],
      user: buildUserParams(email),
      authentication,
      oidcHostname,
    });

    let droppedUser = await User.findOne({
      where: { email, teamId: droppedProvider!.teamId },
    });
    expect(droppedUser!.suspendedAt).not.toBeNull();

    // Third login with the group restored should reactivate the membership.
    await provisionGroupTeams(ctx, {
      groups: ["keep", "drop"],
      user: buildUserParams(email),
      authentication,
      oidcHostname,
    });

    droppedUser = await User.findOne({
      where: { email, teamId: droppedProvider!.teamId },
    });
    expect(droppedUser!.suspendedAt).toBeNull();
  });

  it("lands on the requested team when the user belongs to it", async () => {
    const email = faker.internet.email().toLowerCase();
    const authentication = buildAuthentication();

    await provisionGroupTeams(ctx, {
      groups: ["alpha", "zulu"],
      user: buildUserParams(email),
      authentication,
      oidcHostname,
    });

    const zuluProvider = await AuthenticationProvider.findOne({
      where: { name: "oidc", providerId: `${oidcHostname}#zulu` },
    });

    const landing = await provisionGroupTeams(ctx, {
      groups: ["alpha", "zulu"],
      user: buildUserParams(email),
      authentication,
      oidcHostname,
      requestTeamId: zuluProvider!.teamId,
    });

    expect(landing.team.id).toEqual(zuluProvider!.teamId);
  });

  it("defaults to the first group alphabetically when no team is requested", async () => {
    const email = faker.internet.email().toLowerCase();

    const landing = await provisionGroupTeams(ctx, {
      groups: ["zulu", "alpha"],
      user: buildUserParams(email),
      authentication: buildAuthentication(),
      oidcHostname,
    });

    const alphaProvider = await AuthenticationProvider.findOne({
      where: { name: "oidc", providerId: `${oidcHostname}#alpha` },
    });
    expect(landing.team.id).toEqual(alphaProvider!.teamId);
  });

  it("is idempotent across repeated logins", async () => {
    const email = faker.internet.email().toLowerCase();
    const authentication = buildAuthentication();
    const params = {
      groups: ["alpha", "beta"],
      user: buildUserParams(email),
      authentication,
      oidcHostname,
    };

    await provisionGroupTeams(ctx, params);
    await provisionGroupTeams(ctx, params);

    const users = await User.findAll({ where: { email } });
    expect(users.length).toEqual(2);

    const providers = await AuthenticationProvider.findAll({
      where: { name: "oidc" },
    });
    const namespaced = providers.filter((p) =>
      p.providerId.startsWith(`${oidcHostname}#`)
    );
    expect(namespaced.length).toEqual(2);
  });
});
