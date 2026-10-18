import Stripe from "stripe";
import { PLANS } from "../credits/plans";

// Creates what Patenter needs in a Stripe account and prints the lines to
// add to .env:
//   STRIPE_SECRET_KEY=sk_test_... node dist/scripts/stripeSetup.js https://patenter.example
// (in development: npm run stripe:setup -- https://patenter.example)
//
// Run it once with a test key and once with the live key: Stripe keeps
// test and live data apart. Running it again is safe: products, prices,
// the portal settings and the webhook are reused or updated, and a price
// is only added when the amount in src/credits/plans.ts has changed.

const PAID_PLANS = ["PRO", "MAX"] as const;
type PaidPlan = (typeof PAID_PLANS)[number];

export const WEBHOOK_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
];

const PORTAL_TAG = { patenter: "plans" };

function idOf(value: string | { id: string }) {
  return typeof value === "string" ? value : value.id;
}

// The monthly price for a plan, found by its lookup key. Returns the
// price to sell from now on, plus the older price it replaced (if the
// amount changed), whose subscribers must keep their plan.
export async function findOrCreatePrice(stripe: Stripe, plan: PaidPlan) {
  const { name, dailyCredits, monthlyPriceUsd } = PLANS[plan];
  const lookupKey = `patenter_${plan.toLowerCase()}_monthly`;
  const amount = monthlyPriceUsd * 100;

  const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1 })).data[0];

  if (
    existing &&
    existing.active &&
    existing.unit_amount === amount &&
    existing.currency === "usd" &&
    existing.recurring?.interval === "month"
  ) {
    return { price: existing, replaced: null };
  }

  const productId = existing
    ? idOf(existing.product)
    : (
        await stripe.products.create({
          name: `Patenter ${name}`,
          description: `${dailyCredits} credits a day`,
          metadata: { patenterPlan: plan },
        })
      ).id;

  const price = await stripe.prices.create({
    product: productId,
    currency: "usd",
    unit_amount: amount,
    recurring: { interval: "month" },
    nickname: `${name} monthly`,
    lookup_key: lookupKey,
    // Moves the lookup key over from the old price, if there is one.
    transfer_lookup_key: true,
  });

  return { price, replaced: existing ?? null };
}

// Customer portal: switch between Pro and Max, cancel (at the end of the
// paid period), update the card and see invoices.
export async function upsertPortal(stripe: Stripe, publicUrl: string, prices: Record<PaidPlan, Stripe.Price>) {
  const params = {
    business_profile: { headline: "Manage your Patenter plan" },
    default_return_url: `${publicUrl}/app/account/index.html`,
    features: {
      customer_update: {
        enabled: true,
        allowed_updates: ["email", "address", "name", "tax_id"] as Stripe.BillingPortal.ConfigurationCreateParams.Features.CustomerUpdate.AllowedUpdate[],
      },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" as const },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"] as Stripe.BillingPortal.ConfigurationCreateParams.Features.SubscriptionUpdate.DefaultAllowedUpdate[],
        proration_behavior: "create_prorations" as const,
        products: PAID_PLANS.map((plan) => ({
          product: idOf(prices[plan].product),
          prices: [prices[plan].id],
        })),
      },
    },
    metadata: PORTAL_TAG,
  };

  const existing = (await stripe.billingPortal.configurations.list({ limit: 100 })).data.find(
    (config) => config.metadata?.patenter === PORTAL_TAG.patenter
  );

  return existing
    ? stripe.billingPortal.configurations.update(existing.id, { ...params, active: true })
    : stripe.billingPortal.configurations.create(params);
}

// The endpoint Stripe sends subscription changes to. Stripe shows a
// signing secret only when the endpoint is created, so for an existing
// endpoint `secret` is null.
export async function ensureWebhook(stripe: Stripe, url: string) {
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(
    (endpoint) => endpoint.url === url
  );

  if (existing) {
    await stripe.webhookEndpoints.update(existing.id, { enabled_events: WEBHOOK_EVENTS, disabled: false });
    return { id: existing.id, secret: null };
  }

  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: WEBHOOK_EVENTS,
    description: "Patenter plans and subscriptions",
  });

  return { id: created.id, secret: created.secret ?? null };
}

export async function setUpStripe(stripe: Stripe, publicUrl: string) {
  const pro = await findOrCreatePrice(stripe, "PRO");
  const max = await findOrCreatePrice(stripe, "MAX");
  const portal = await upsertPortal(stripe, publicUrl, { PRO: pro.price, MAX: max.price });
  const webhook = await ensureWebhook(stripe, `${publicUrl}/auth/billing/webhook`);

  return { pro, max, portal, webhook };
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  const publicUrl = (process.argv[2] || "").trim().replace(/\/+$/, "");

  if (!key || !/^https:\/\/[^/]+$/.test(publicUrl)) {
    throw new Error(
      "Usage: STRIPE_SECRET_KEY=sk_... stripeSetup https://your-domain\n" +
        "The address must be the site's public https:// address, e.g. https://patenter.example"
    );
  }

  const live = /^[sr]k_live_/.test(key);
  const { pro, max, portal, webhook } = await setUpStripe(new Stripe(key), publicUrl);

  // Subscribers on a replaced price keep their plan if it stays listed.
  const priceIds = ({ price, replaced }: { price: Stripe.Price; replaced: Stripe.Price | null }) =>
    [price.id, replaced?.id].filter(Boolean).join(",");

  console.log(`
✅ Stripe is set up in ${live ? "LIVE" : "TEST"} mode.

Put these lines in .env (next to docker-compose.yml), then run
"docker compose up -d" to restart with billing switched on:

STRIPE_SECRET_KEY=<the key you just used>
STRIPE_WEBHOOK_SECRET=${webhook.secret ?? "<keep your current value>"}
STRIPE_PRICE_PRO=${priceIds(pro)}
STRIPE_PRICE_MAX=${priceIds(max)}
STRIPE_PORTAL_CONFIGURATION=${portal.id}
`);

  if (!webhook.secret) {
    console.log(
      "The webhook endpoint already existed and Stripe only shows its signing secret once.\n" +
        "Keep your current STRIPE_WEBHOOK_SECRET, or get a new one in the Stripe dashboard:\n" +
        "Developers → Webhooks → the endpoint → Signing secret → Roll secret.\n"
    );
  }

  if (pro.replaced || max.replaced) {
    console.log(
      "A plan's price changed, so a new Stripe price was created. Existing subscribers stay on\n" +
        "their old price (listed second above) until you move them in the Stripe dashboard.\n"
    );
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
