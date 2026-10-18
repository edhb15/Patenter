// Stripe billing: checkout, the customer portal and webhooks. Stripe's API
// is faked; webhook signatures are real (made with Stripe's own helper).
// Needs the same PostgreSQL database as auth.test.ts.
process.env.NODE_ENV = "test";
process.env.JWT_ACCESS_SECRET ||= "test-access-secret-0123456789abcdef";
process.env.INTERNAL_API_SECRET ||= "test-internal-secret-0123456789abcdef";

const WEBHOOK_SECRET = "whsec_test_secret";

Object.assign(process.env, {
  STRIPE_SECRET_KEY: "sk_test_fake",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_PRO: "price_pro, price_pro_old",
  STRIPE_PRICE_MAX: "price_max",
  PUBLIC_URL: "https://patenter.test/",
});

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import Stripe from "stripe";
import app from "../src/app";
import { prisma } from "../src/lib/prisma";
import { setStripe } from "../src/billing/stripe";
import { resetBilling } from "../src/scripts/resetBilling";

// ---- fake Stripe -------------------------------------------------------------

// Points at a closed port, so any API call that isn't faked below fails
// instead of reaching Stripe.
const stripe = new Stripe("sk_test_fake", {
  host: "127.0.0.1",
  port: 1,
  protocol: "http",
  maxNetworkRetries: 0,
});

type Params = Record<string, any>;

const fake = {
  customers: [] as Params[],
  checkouts: [] as Params[],
  portals: [] as Params[],
  // What stripe.subscriptions.retrieve() returns: Stripe's current state.
  subscriptions: new Map<string, Params>(),
};

Object.assign(stripe.customers, {
  create: async (params: Params) => {
    fake.customers.push(params);
    return { id: `cus_${fake.customers.length}`, object: "customer" };
  },
  // Like Stripe, unknown customers (e.g. made with test keys) are missing.
  retrieve: async (id: string) => {
    if (!/^cus_\d+$/.test(id) || Number(id.slice(4)) > fake.customers.length) {
      throw new Stripe.errors.StripeInvalidRequestError({ message: `No such customer: '${id}'`, code: "resource_missing" });
    }
    return { id, object: "customer" };
  },
});

Object.assign(stripe.checkout.sessions, {
  create: async (params: Params) => {
    fake.checkouts.push(params);
    return { id: "cs_test", url: "https://checkout.stripe.test/cs_test" };
  },
});

Object.assign(stripe.billingPortal.sessions, {
  create: async (params: Params) => {
    fake.portals.push(params);
    return { url: "https://billing.stripe.test/session" };
  },
});

Object.assign(stripe.subscriptions, {
  retrieve: async (id: string) => {
    const subscription = fake.subscriptions.get(id);
    if (!subscription) throw new Error(`No such subscription: ${id}`);
    return subscription;
  },
});

const PERIOD_END = Math.floor(Date.UTC(2026, 10, 18) / 1000);

function subscription(
  id: string,
  customer: string,
  options: { status?: string; price?: string; cancelAtPeriodEnd?: boolean; endedAt?: number; userId?: string } = {}
) {
  const value = {
    id,
    object: "subscription",
    customer,
    status: options.status ?? "active",
    cancel_at: null,
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    ended_at: options.endedAt ?? null,
    metadata: options.userId ? { userId: options.userId } : {},
    items: { data: [{ price: { id: options.price ?? "price_pro" }, current_period_end: PERIOD_END }] },
  };
  fake.subscriptions.set(id, value);
  return value;
}

// ---- helpers -----------------------------------------------------------------

let server: Server;
let baseUrl: string;

before(async () => {
  setStripe(stripe);
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
  fake.customers = [];
  fake.checkouts = [];
  fake.portals = [];
  fake.subscriptions.clear();
});

async function call(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(opts.body !== undefined && { "Content-Type": "application/json" }),
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function signUp(email = "payer@example.com") {
  const password = "correct horse battery";
  await call("POST", "/auth/register", { body: { email, password } });
  const login = await call("POST", "/auth/login", { body: { email, password } });
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { id: user.id, token: login.body.accessToken as string };
}

let eventCount = 0;

async function sendEvent(type: string, object: object, secret = WEBHOOK_SECRET) {
  const payload = JSON.stringify({ id: `evt_${++eventCount}`, object: "event", type, data: { object } });
  const res = await fetch(baseUrl + "/auth/billing/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": stripe.webhooks.generateTestHeaderString({ payload, secret }),
    },
    body: payload,
  });
  return res.status;
}

async function me(token: string) {
  return (await call("GET", "/auth/me", { token })).body;
}

// ---- tests -------------------------------------------------------------------

test("plans say online payment is available", async () => {
  const res = await call("GET", "/auth/plans");
  assert.equal(res.body.billingEnabled, true);
});

test("checkout makes one Stripe customer per user and a subscription session", async () => {
  const { id, token } = await signUp();

  const pro = await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });
  assert.equal(pro.status, 200);
  assert.equal(pro.body.url, "https://checkout.stripe.test/cs_test");

  assert.deepEqual(fake.customers, [{ email: "payer@example.com", metadata: { userId: id } }]);
  const session = fake.checkouts[0];
  assert.equal(session.mode, "subscription");
  assert.equal(session.customer, "cus_1");
  assert.equal(session.client_reference_id, id);
  assert.deepEqual(session.line_items, [{ price: "price_pro", quantity: 1 }]);
  assert.deepEqual(session.subscription_data, { metadata: { userId: id } });
  assert.equal(session.success_url, "https://patenter.test/app/account/index.html?checkout=success");
  assert.equal(session.cancel_url, "https://patenter.test/app/account/index.html?checkout=cancelled");
  assert.equal(session.automatic_tax, undefined);

  // Changing their mind reuses the same customer.
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "max" } });
  assert.equal(fake.customers.length, 1);
  assert.equal(fake.checkouts[1].customer, "cus_1");
  assert.deepEqual(fake.checkouts[1].line_items, [{ price: "price_max", quantity: 1 }]);

  // The plan only changes once Stripe confirms the payment.
  assert.equal((await me(token)).plan.id, "free");

  for (const plan of ["free", "gold", 1]) {
    assert.equal((await call("POST", "/auth/billing/checkout", { token, body: { plan } })).status, 400);
  }
  assert.equal((await call("POST", "/auth/billing/checkout", { body: { plan: "pro" } })).status, 401);
});

test("webhooks without a valid signature are rejected", async () => {
  const { id, token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "max" } });
  const sub = subscription("sub_1", "cus_1", { price: "price_max", userId: id });

  assert.equal(await sendEvent("customer.subscription.created", sub, "whsec_wrong"), 400);

  const unsigned = await fetch(baseUrl + "/auth/billing/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "customer.subscription.created", data: { object: sub } }),
  });
  assert.equal(unsigned.status, 400);

  assert.equal((await me(token)).plan.id, "free");
});

test("a paid subscription sets the plan, and cancelling ends it", async () => {
  const { token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "max" } });

  assert.equal(await sendEvent("customer.subscription.created", subscription("sub_1", "cus_1", { price: "price_max" })), 200);
  let account = await me(token);
  assert.equal(account.plan.id, "max");
  assert.equal(account.credits.dailyAllowance, 1000);
  assert.deepEqual(account.subscription, {
    status: "active",
    renewsAt: "2026-11-18T00:00:00.000Z",
    endsAt: null,
  });

  // Cancelled in the portal: still Max until the paid period ends.
  await sendEvent("customer.subscription.updated", subscription("sub_1", "cus_1", { price: "price_max", cancelAtPeriodEnd: true }));
  account = await me(token);
  assert.equal(account.plan.id, "max");
  assert.deepEqual(account.subscription, {
    status: "active",
    renewsAt: null,
    endsAt: "2026-11-18T00:00:00.000Z",
  });

  const ended = subscription("sub_1", "cus_1", { price: "price_max", status: "canceled", endedAt: PERIOD_END });
  await sendEvent("customer.subscription.deleted", ended);
  account = await me(token);
  assert.equal(account.plan.id, "free");
  assert.equal(account.subscription, null);
});

test("Stripe's current state wins over a stale event", async () => {
  const { token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });

  // The "updated" event still says active, but the subscription has
  // since been cancelled.
  const stale = { ...subscription("sub_1", "cus_1"), status: "active" };
  subscription("sub_1", "cus_1", { status: "canceled", endedAt: PERIOD_END });

  await sendEvent("customer.subscription.updated", stale);
  assert.equal((await me(token)).plan.id, "free");
});

test("a completed checkout links the customer and sets the plan", async () => {
  const { id, token } = await signUp();

  // An older Pro price still counts as Pro.
  subscription("sub_9", "cus_new", { price: "price_pro_old", userId: id });
  const status = await sendEvent("checkout.session.completed", {
    id: "cs_test",
    object: "checkout.session",
    mode: "subscription",
    customer: "cus_new",
    subscription: "sub_9",
    client_reference_id: id,
  });
  assert.equal(status, 200);

  assert.equal((await me(token)).plan.id, "pro");
  const user = await prisma.user.findUniqueOrThrow({ where: { id } });
  assert.equal(user.stripeCustomerId, "cus_new");
  assert.equal(user.stripeSubscriptionId, "sub_9");
});

test("an old subscription ending doesn't end a newer one", async () => {
  const { token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });

  await sendEvent("customer.subscription.created", subscription("sub_new", "cus_1"));
  await sendEvent("customer.subscription.deleted", subscription("sub_old", "cus_1", { status: "canceled", endedAt: PERIOD_END }));

  const account = await me(token);
  assert.equal(account.plan.id, "pro");
  assert.equal(account.subscription.status, "active");
});

test("a failed renewal keeps the plan while Stripe retries; unpaid ends it", async () => {
  const { token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });

  await sendEvent("customer.subscription.updated", subscription("sub_1", "cus_1", { status: "past_due" }));
  let account = await me(token);
  assert.equal(account.plan.id, "pro");
  assert.equal(account.subscription.status, "past_due");

  await sendEvent("customer.subscription.updated", subscription("sub_1", "cus_1", { status: "unpaid" }));
  account = await me(token);
  assert.equal(account.plan.id, "free");
  assert.equal(account.subscription, null);
});

test("unknown prices and customers change nothing", async () => {
  const { token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });

  assert.equal(await sendEvent("customer.subscription.created", subscription("sub_1", "cus_1", { price: "price_other" })), 200);
  assert.equal((await me(token)).plan.id, "free");

  assert.equal(await sendEvent("customer.subscription.created", subscription("sub_2", "cus_stranger")), 200);
  assert.equal(await sendEvent("invoice.paid", { id: "in_1", object: "invoice" }), 200);
});

test("subscribers manage their plan in the portal, not a second checkout", async () => {
  const newcomer = await signUp("new@example.com");
  assert.equal((await call("POST", "/auth/billing/portal", { token: newcomer.token })).status, 409);

  const { token } = await signUp();
  await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });
  await sendEvent("customer.subscription.created", subscription("sub_1", "cus_1"));

  const again = await call("POST", "/auth/billing/checkout", { token, body: { plan: "max" } });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Manage subscription/);

  const portal = await call("POST", "/auth/billing/portal", { token });
  assert.equal(portal.status, 200);
  assert.equal(portal.body.url, "https://billing.stripe.test/session");
  assert.deepEqual(fake.portals, [
    { customer: "cus_1", return_url: "https://patenter.test/app/account/index.html" },
  ]);
});

test("links left over from Stripe's test mode don't block live checkout", async () => {
  const { id, token } = await signUp();
  await prisma.user.update({
    where: { id },
    data: { plan: "PRO", stripeCustomerId: "cus_testmode", stripeSubscriptionId: "sub_testmode", subscriptionStatus: "active" },
  });

  // Nothing real to manage...
  assert.equal((await call("POST", "/auth/billing/portal", { token })).status, 409);

  // ...and checkout makes a new customer instead of failing.
  const res = await call("POST", "/auth/billing/checkout", { token, body: { plan: "max" } });
  assert.equal(res.status, 200);
  assert.equal(fake.checkouts[0].customer, "cus_1");
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id } })).stripeCustomerId, "cus_1");
});

test("resetting billing for live mode unlinks test data and ends test subscriptions", async () => {
  const subscriber = await signUp("subscriber@example.com");
  const tried = await signUp("tried@example.com");
  const comped = await signUp("comped@example.com");

  await prisma.user.update({
    where: { id: subscriber.id },
    data: { plan: "PRO", stripeCustomerId: "cus_a", stripeSubscriptionId: "sub_a", subscriptionStatus: "active" },
  });
  await prisma.user.update({ where: { id: tried.id }, data: { stripeCustomerId: "cus_b" } });
  await prisma.user.update({ where: { id: comped.id }, data: { plan: "MAX" } });

  assert.deepEqual(await resetBilling(), { downgraded: 1, unlinked: 2 });

  const users = await prisma.user.findMany({ orderBy: { email: "asc" } });
  assert.deepEqual(
    users.map((u) => [u.email, u.plan, u.stripeCustomerId, u.stripeSubscriptionId, u.subscriptionStatus]),
    [
      ["comped@example.com", "MAX", null, null, null],
      ["subscriber@example.com", "FREE", null, null, null],
      ["tried@example.com", "FREE", null, null, null],
    ]
  );
});

test("a Stripe outage gives a clear message, not a 500", async () => {
  const { token } = await signUp();
  const create = stripe.checkout.sessions.create;

  Object.assign(stripe.checkout.sessions, {
    create: async () => {
      throw new Stripe.errors.StripeConnectionError({ message: "connect ECONNREFUSED" });
    },
  });

  try {
    const res = await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } });
    assert.equal(res.status, 502);
    assert.match(res.body.error, /payment service could not be reached/);
  } finally {
    Object.assign(stripe.checkout.sessions, { create });
  }
});

test("without Stripe configured, billing is switched off", async () => {
  const { token } = await signUp();
  setStripe(null);

  try {
    assert.equal((await call("GET", "/auth/plans")).body.billingEnabled, false);
    assert.equal((await call("POST", "/auth/billing/checkout", { token, body: { plan: "pro" } })).status, 503);
    assert.equal(await sendEvent("customer.subscription.created", subscription("sub_1", "cus_1")), 503);
  } finally {
    setStripe(stripe);
  }
});
