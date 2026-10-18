// Integration tests for the auth API. They need a PostgreSQL database
// (DATABASE_URL) with migrations applied; every run starts from empty tables.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-0123456789abcdef";
process.env.INTERNAL_API_SECRET ||= "test-internal-secret-0123456789abcdef";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import app from "../src/app";
import { prisma } from "../src/lib/prisma";

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.session.deleteMany();
  await prisma.user.deleteMany();
});

type Options = { body?: unknown; token?: string; cookie?: string; raw?: string };

async function call(method: string, path: string, opts: Options = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined || opts.raw !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.cookie) headers["Cookie"] = `refreshToken=${opts.cookie}`;

  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });

  const setCookie = res.headers.get("set-cookie") || "";
  const cookie = /refreshToken=([^;]*)/.exec(setCookie)?.[1];
  const text = await res.text();

  return { status: res.status, body: text ? JSON.parse(text) : null, cookie, setCookie };
}

const PASSWORD = "correct horse battery";

async function registerAndLogin(email = "user@example.com") {
  await call("POST", "/auth/register", { body: { email, password: PASSWORD } });
  const login = await call("POST", "/auth/login", { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { accessToken: login.body.accessToken as string, refresh: login.cookie! };
}

test("register stores a normalized email and rejects duplicates", async () => {
  const first = await call("POST", "/auth/register", {
    body: { email: "  Alice@Example.COM ", password: PASSWORD },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.email, "alice@example.com");
  assert.equal(first.body.passwordHash, undefined);

  const dup = await call("POST", "/auth/register", {
    body: { email: "alice@example.com", password: PASSWORD },
  });
  assert.equal(dup.status, 409);
});

test("register validates input", async () => {
  const short = await call("POST", "/auth/register", { body: { email: "a@b.io", password: "short" } });
  assert.equal(short.status, 400);

  const long = await call("POST", "/auth/register", {
    body: { email: "a@b.io", password: "x".repeat(129) },
  });
  assert.equal(long.status, 400);
});

test("login rejects non-string input with 400 and bad JSON with 400", async () => {
  const injected = await call("POST", "/auth/login", {
    body: { email: { contains: "" }, password: PASSWORD },
  });
  assert.equal(injected.status, 400);

  const malformed = await call("POST", "/auth/login", { raw: "{not json" });
  assert.equal(malformed.status, 400);
});

test("login gives the same 401 for unknown email and wrong password", async () => {
  await registerAndLogin();

  const wrongPassword = await call("POST", "/auth/login", {
    body: { email: "user@example.com", password: "wrong password" },
  });
  const unknownEmail = await call("POST", "/auth/login", {
    body: { email: "nobody@example.com", password: PASSWORD },
  });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, 401);
  assert.deepEqual(wrongPassword.body, unknownEmail.body);
});

test("login sets an HttpOnly, SameSite=Strict refresh cookie scoped to /auth", async () => {
  await call("POST", "/auth/register", { body: { email: "c@example.com", password: PASSWORD } });
  const login = await call("POST", "/auth/login", {
    body: { email: "C@Example.com", password: PASSWORD },
  });

  assert.equal(login.status, 200);
  assert.match(login.setCookie, /HttpOnly/i);
  assert.match(login.setCookie, /SameSite=Strict/i);
  assert.match(login.setCookie, /Path=\/auth/i);
});

test("/auth/me accepts a valid access token and rejects a forged one", async () => {
  const { accessToken } = await registerAndLogin();

  const me = await call("GET", "/auth/me", { token: accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.email, "user@example.com");

  const [header, payload] = accessToken.split(".");
  const forged = await call("GET", "/auth/me", { token: `${header}.${payload}.invalidsignature` });
  assert.equal(forged.status, 401);

  const none = await call("GET", "/auth/me");
  assert.equal(none.status, 401);
});

test("refresh rotates the token and keeps the original expiry", async () => {
  const { refresh } = await registerAndLogin();
  const before = await prisma.session.findFirstOrThrow();

  const res = await call("POST", "/auth/refresh", { cookie: refresh });
  assert.equal(res.status, 200);
  assert.ok(res.body.accessToken);
  assert.ok(res.cookie);
  assert.notEqual(res.cookie, refresh);

  const active = await prisma.session.findMany({ where: { revokedAt: null } });
  assert.equal(active.length, 1);
  assert.equal(active[0].expiresAt.getTime(), before.expiresAt.getTime());
  assert.equal(active[0].familyId, before.familyId);

  const again = await call("POST", "/auth/refresh", { cookie: res.cookie });
  assert.equal(again.status, 200);
});

test("concurrent refreshes with one token issue exactly one new token", async () => {
  const { refresh } = await registerAndLogin();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => call("POST", "/auth/refresh", { cookie: refresh }))
  );

  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 401).length, 4);

  // A race inside the grace window must not log the user out.
  const winner = results.find((r) => r.status === 200)!;
  const next = await call("POST", "/auth/refresh", { cookie: winner.cookie });
  assert.equal(next.status, 200);
});

test("reusing an old refresh token revokes the whole session family", async () => {
  const { refresh: stolen } = await registerAndLogin();
  const rotated = await call("POST", "/auth/refresh", { cookie: stolen });
  assert.equal(rotated.status, 200);

  // Pretend the rotation happened a minute ago (outside the grace window).
  await prisma.session.updateMany({
    where: { revokedAt: { not: null } },
    data: { revokedAt: new Date(Date.now() - 60_000) },
  });

  const reuse = await call("POST", "/auth/refresh", { cookie: stolen });
  assert.equal(reuse.status, 401);

  // The legitimate user's newer token is now dead too.
  const legit = await call("POST", "/auth/refresh", { cookie: rotated.cookie });
  assert.equal(legit.status, 401);
  assert.equal(await prisma.session.count(), 0);
});

test("expired refresh tokens are rejected", async () => {
  const { refresh } = await registerAndLogin();
  await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

  const res = await call("POST", "/auth/refresh", { cookie: refresh });
  assert.equal(res.status, 401);
});

test("logout ends only that session; logout-all ends every session", async () => {
  const a = await registerAndLogin();
  const loginB = await call("POST", "/auth/login", {
    body: { email: "user@example.com", password: PASSWORD },
  });
  const loginC = await call("POST", "/auth/login", {
    body: { email: "user@example.com", password: PASSWORD },
  });

  const logout = await call("POST", "/auth/logout", { cookie: a.refresh });
  assert.equal(logout.status, 204);
  assert.equal((await call("POST", "/auth/refresh", { cookie: a.refresh })).status, 401);
  assert.equal(await prisma.session.count(), 2);

  const all = await call("POST", "/auth/logout-all", { token: loginB.body.accessToken });
  assert.equal(all.status, 204);
  assert.equal((await call("POST", "/auth/refresh", { cookie: loginB.cookie })).status, 401);
  assert.equal((await call("POST", "/auth/refresh", { cookie: loginC.cookie })).status, 401);
});

test("deleting a user deletes their sessions", async () => {
  await registerAndLogin();
  await prisma.user.deleteMany();
  assert.equal(await prisma.session.count(), 0);
});

// ---- plans and credits ------------------------------------------------------

const INTERNAL = process.env.INTERNAL_API_SECRET!;

async function newUserId(email = "user@example.com") {
  const { accessToken } = await registerAndLogin(email);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, accessToken };
}

function spend(userId: string, amount: number, partial?: boolean) {
  return call("POST", "/internal/credits/spend", {
    token: INTERNAL,
    body: partial === undefined ? { userId, amount } : { userId, amount, partial },
  });
}

function utcDayOffset(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test("/auth/plans lists the plans without signing in", async () => {
  const res = await call("GET", "/auth/plans");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.plans, [
    { id: "free", name: "Free", dailyCredits: 100, monthlyPriceUsd: 0 },
    { id: "pro", name: "Pro", dailyCredits: 500, monthlyPriceUsd: 10 },
    { id: "max", name: "Max", dailyCredits: 1000, monthlyPriceUsd: 20 },
  ]);
});

test("/auth/me shows the plan and today's credits", async () => {
  const { accessToken } = await newUserId();

  const me = await call("GET", "/auth/me", { token: accessToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.plan.id, "free");
  assert.deepEqual(me.body.credits, {
    dailyAllowance: 100,
    used: 0,
    remaining: 100,
    resetsAt: `${utcDayOffset(1)}T00:00:00.000Z`,
  });
});

test("internal routes need the internal secret", async () => {
  const { id, accessToken } = await newUserId();
  const body = { userId: id, amount: 1 };

  assert.equal((await call("POST", "/internal/credits/spend", { body })).status, 401);
  assert.equal((await call("POST", "/internal/credits/spend", { body, token: accessToken })).status, 401);
  assert.equal((await call("POST", "/internal/credits/spend", { body, token: INTERNAL + "x" })).status, 401);
  assert.equal((await call("POST", "/internal/credits/spend", { body, token: INTERNAL })).status, 200);
});

test("a spend stops at the allowance; a partial spend uses what is left", async () => {
  const { id } = await newUserId();

  const first = await spend(id, 60);
  assert.equal(first.status, 200);
  assert.equal(first.body.spent, 60);
  assert.equal(first.body.day, utcDayOffset(0));
  assert.equal(first.body.credits.remaining, 40);

  const tooMuch = await spend(id, 50);
  assert.equal(tooMuch.status, 402);
  assert.equal(tooMuch.body.credits.remaining, 40);

  const partial = await spend(id, 50, true);
  assert.equal(partial.status, 200);
  assert.equal(partial.body.spent, 40);
  assert.equal(partial.body.credits.remaining, 0);

  assert.equal((await spend(id, 1)).status, 402);
  assert.equal((await spend(id, 1, true)).body.spent, 0);
});

test("credits refill on a new UTC day and follow the plan", async () => {
  const { id, accessToken } = await newUserId();
  await spend(id, 100);
  assert.equal((await spend(id, 1)).status, 402);

  // Upgrading mid-day adds the difference straight away.
  await prisma.user.update({ where: { id }, data: { plan: "PRO" } });
  let me = await call("GET", "/auth/me", { token: accessToken });
  assert.equal(me.body.plan.id, "pro");
  assert.equal(me.body.credits.remaining, 400);

  // Downgrading below what was used leaves nothing for today, not less than nothing.
  await spend(id, 300);
  await prisma.user.update({ where: { id }, data: { plan: "FREE" } });
  me = await call("GET", "/auth/me", { token: accessToken });
  assert.equal(me.body.credits.used, 400);
  assert.equal(me.body.credits.remaining, 0);

  // Usage from yesterday doesn't count today.
  await prisma.user.update({ where: { id }, data: { creditsDay: new Date(utcDayOffset(-1)) } });
  me = await call("GET", "/auth/me", { token: accessToken });
  assert.equal(me.body.credits.remaining, 100);

  const next = await spend(id, 5);
  assert.equal(next.status, 200);
  assert.equal(next.body.credits.used, 5);
});

test("refunds return today's credits but not an earlier day's", async () => {
  const { id } = await newUserId();
  const spent = await spend(id, 5);

  const refund = await call("POST", "/internal/credits/refund", {
    token: INTERNAL,
    body: { userId: id, amount: 5, day: spent.body.day },
  });
  assert.equal(refund.status, 200);
  assert.equal(refund.body.credits.remaining, 100);

  // Never below zero used, even if refunded twice.
  const again = await call("POST", "/internal/credits/refund", {
    token: INTERNAL,
    body: { userId: id, amount: 5, day: spent.body.day },
  });
  assert.equal(again.body.credits.used, 0);

  await spend(id, 10);
  const stale = await call("POST", "/internal/credits/refund", {
    token: INTERNAL,
    body: { userId: id, amount: 10, day: utcDayOffset(-1) },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.credits.remaining, 90);
});

test("concurrent spends never use more than the allowance", async () => {
  const { id } = await newUserId();

  const results = await Promise.all(Array.from({ length: 10 }, () => spend(id, 15)));

  assert.equal(results.filter((r) => r.status === 200).length, 6);
  assert.equal(results.filter((r) => r.status === 402).length, 4);

  const user = await prisma.user.findUniqueOrThrow({ where: { id } });
  assert.equal(user.creditsUsed, 90);
});

test("spend and refund validate their input", async () => {
  const { id } = await newUserId();

  for (const amount of [0, -1, 1.5, "5", 10001]) {
    assert.equal((await spend(id, amount as number)).status, 400, String(amount));
  }
  assert.equal((await spend("no-such-user", 1)).status, 404);

  const badDay = await call("POST", "/internal/credits/refund", {
    token: INTERNAL,
    body: { userId: id, amount: 1, day: "yesterday" },
  });
  assert.equal(badDay.status, 400);
});
