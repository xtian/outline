import { addMonths } from "date-fns";
import { faker } from "@faker-js/faker";
import { buildUser, buildTeam, buildCollection } from "@server/test/factories";
import { getTestServer, setSelfHosted } from "@server/test/support";
import { getJWTPayload } from "@server/utils/jwt";

const server = getTestServer();

describe("auth/redirect", () => {
  it("should redirect to home", async () => {
    const user = await buildUser();
    const res = await server.get(
      `/auth/redirect?token=${user.getTransferToken()}`,
      {
        redirect: "manual",
      }
    );
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).not.toBeNull();
    expect(res.headers.get("location")!.endsWith("/home")).toBeTruthy();
  });

  it("should redirect to first collection", async () => {
    const collection = await buildCollection();
    const user = await buildUser({
      teamId: collection.teamId,
    });
    const res = await server.get(
      `/auth/redirect?token=${user.getTransferToken()}`,
      {
        redirect: "manual",
      }
    );
    expect(res.status).toEqual(302);
    expect(res.headers.get("location")).not.toBeNull();
    expect(res.headers.get("location")!.includes(collection.path)).toBeTruthy();
  });

  it("should issue a session token with an expiry", async () => {
    const user = await buildUser();
    const before = Date.now();
    const res = await server.get(
      `/auth/redirect?token=${user.getTransferToken()}`,
      {
        redirect: "manual",
      }
    );
    expect(res.status).toEqual(302);

    const cookie = res.headers.get("set-cookie");
    expect(cookie).not.toBeNull();
    const match = cookie!.match(/accessToken=([^;]+)/);
    expect(match).not.toBeNull();

    const payload = getJWTPayload(match![1]);
    expect(payload.type).toEqual("session");
    expect(payload.expiresAt).toBeDefined();

    const expiresAt = new Date(payload.expiresAt as string).getTime();
    const expectedMin = addMonths(before, 3).getTime() - 1000;
    const expectedMax = addMonths(Date.now(), 3).getTime() + 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
    expect(expiresAt).toBeLessThanOrEqual(expectedMax);
  });

  it("should prevent token extension by rejecting JWT tokens", async () => {
    const user = await buildUser();
    const jwtToken = user.getSessionToken();

    const res = await server.get(`/auth/redirect?token=${jwtToken}`, {
      redirect: "manual",
    });

    expect(res.status).toEqual(401);
  });
});

describe("auth/switch", () => {
  it("should switch to another workspace with the same email", async () => {
    setSelfHosted();
    const email = faker.internet.email().toLowerCase();
    const teamA = await buildTeam();
    const teamB = await buildTeam();
    const userA = await buildUser({ teamId: teamA.id, email });
    const userB = await buildUser({ teamId: teamB.id, email });

    const res = await server.get(
      `/auth/switch?to=${teamB.id}&token=${userA.getSessionToken()}`,
      { redirect: "manual" }
    );

    expect(res.status).toEqual(302);
    expect(res.headers.get("location")!.endsWith("/home")).toBeTruthy();

    const cookie = res.headers.get("set-cookie");
    const match = cookie!.match(/accessToken=([^;]+)/);
    expect(match).not.toBeNull();
    const payload = getJWTPayload(match![1]);
    expect(payload.type).toEqual("session");
    expect(payload.id).toEqual(userB.id);
  });

  it("should no-op when switching to the current workspace", async () => {
    setSelfHosted();
    const user = await buildUser();

    const res = await server.get(
      `/auth/switch?to=${user.teamId}&token=${user.getSessionToken()}`,
      { redirect: "manual" }
    );

    expect(res.status).toEqual(302);
    expect(res.headers.get("location")!.endsWith("/home")).toBeTruthy();
  });

  it("should reject switching to a workspace without a matching email", async () => {
    setSelfHosted();
    const userA = await buildUser();
    const teamB = await buildTeam();
    await buildUser({ teamId: teamB.id });

    const res = await server.get(
      `/auth/switch?to=${teamB.id}&token=${userA.getSessionToken()}`,
      { redirect: "manual" }
    );

    expect(res.status).toEqual(401);
  });

  it("should reject switching to a suspended account", async () => {
    setSelfHosted();
    const email = faker.internet.email().toLowerCase();
    const teamA = await buildTeam();
    const teamB = await buildTeam();
    const userA = await buildUser({ teamId: teamA.id, email });
    await buildUser({
      teamId: teamB.id,
      email,
      suspendedAt: new Date(),
    });

    const res = await server.get(
      `/auth/switch?to=${teamB.id}&token=${userA.getSessionToken()}`,
      { redirect: "manual" }
    );

    expect(res.status).toEqual(401);
  });

  it("should be inert in cloud hosted mode", async () => {
    // Default test env URL is cloud hosted; do not call setSelfHosted().
    const email = faker.internet.email().toLowerCase();
    const teamA = await buildTeam();
    const teamB = await buildTeam();
    const userA = await buildUser({ teamId: teamA.id, email });
    await buildUser({ teamId: teamB.id, email });

    const res = await server.get(
      `/auth/switch?to=${teamB.id}&token=${userA.getSessionToken()}`,
      { redirect: "manual" }
    );

    expect(res.status).toEqual(302);
    expect(res.headers.get("location")!.endsWith("/")).toBeTruthy();
  });
});
