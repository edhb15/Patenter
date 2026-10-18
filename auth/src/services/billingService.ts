import Stripe from "stripe";
import type { Plan } from "@prisma/client";
import { env } from "../config/env";
import { logger } from "../config/logger";
import { AppError } from "../errors/AppError";
import { getStripe } from "../billing/stripe";
import { billingRepository } from "../billing/BillingRepository";

// Subscriptions in these states keep their paid plan. `past_due` means a
// renewal payment failed and Stripe is still retrying it; once Stripe
// gives up, the subscription is cancelled (or unpaid) and the plan ends.
const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

const PAID_PLANS = ["PRO", "MAX"] as const;

const ACCOUNT_PAGE = "/app/account/index.html";

function requireBilling() {
  const stripe = getStripe();

  if (!stripe || !env.billing) {
    throw new AppError("Online payment isn't available yet", 503);
  }

  return { stripe, billing: env.billing };
}

function planForPrice(priceId: string | undefined): Plan | null {
  return PAID_PLANS.find((plan) => priceId && env.billing?.prices[plan].includes(priceId)) ?? null;
}

function idOf(value: string | { id: string }) {
  return typeof value === "string" ? value : value.id;
}

function toDate(seconds: number | null | undefined) {
  return seconds ? new Date(seconds * 1000) : null;
}

function isPaid(status: string | null | undefined) {
  return !!status && PAID_STATUSES.has(status);
}

// The stored customer, or null if Stripe doesn't have it: customers made
// with test keys don't exist in live mode, and one can be deleted in the
// dashboard.
async function liveCustomer(stripe: Stripe, customerId: string | null) {
  if (!customerId) {
    return null;
  }

  try {
    const customer = await stripe.customers.retrieve(customerId);
    return customer.deleted ? null : customer.id;
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError && err.code === "resource_missing") {
      return null;
    }
    throw err;
  }
}

export const billingService = {
  isEnabled() {
    return getStripe() !== null && env.billing !== null;
  },

  // The user's subscription as /auth/me shows it, or null without a paid one.
  async getSubscription(userId: string) {
    const user = await billingRepository.findById(userId);

    if (!user || !isPaid(user.subscriptionStatus)) {
      return null;
    }

    return {
      status: user.subscriptionStatus,
      renewsAt: user.subscriptionEndsAt ? null : user.subscriptionPeriodEnd?.toISOString() ?? null,
      endsAt: user.subscriptionEndsAt?.toISOString() ?? null,
    };
  },

  // Starts a Stripe Checkout for a paid plan; the browser is sent to `url`.
  // The plan changes when Stripe confirms the subscription (handleWebhook).
  async startCheckout(userId: string, plan: (typeof PAID_PLANS)[number]) {
    const { stripe, billing } = requireBilling();

    const user = await billingRepository.findById(userId);

    if (!user) {
      throw new AppError("User not found", 404);
    }

    let customerId = await liveCustomer(stripe, user.stripeCustomerId);

    // Plan changes for subscribers go through the customer portal, so
    // nobody ends up paying for two subscriptions. (A subscription whose
    // customer Stripe no longer has is a leftover from test mode.)
    if (customerId && isPaid(user.subscriptionStatus)) {
      throw new AppError("You already have a subscription. Change it under Manage subscription.", 409);
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId },
      });
      customerId = await billingRepository.attachCustomer(userId, customer.id, user.stripeCustomerId);
    }

    if (!customerId) {
      throw new AppError("User not found", 404);
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      client_reference_id: userId,
      line_items: [{ price: billing.prices[plan][0], quantity: 1 }],
      subscription_data: { metadata: { userId } },
      allow_promotion_codes: true,
      success_url: `${billing.publicUrl}${ACCOUNT_PAGE}?checkout=success`,
      cancel_url: `${billing.publicUrl}${ACCOUNT_PAGE}?checkout=cancelled`,
      ...(billing.automaticTax && {
        automatic_tax: { enabled: true },
        tax_id_collection: { enabled: true },
        customer_update: { address: "auto", name: "auto" },
      }),
    });

    if (!session.url) {
      throw new Error("Stripe returned a checkout session without a URL");
    }

    return { url: session.url };
  },

  // Stripe's customer portal: change plan, cancel, update the card, invoices.
  async openPortal(userId: string) {
    const { stripe, billing } = requireBilling();

    const user = await billingRepository.findById(userId);
    const customerId = await liveCustomer(stripe, user?.stripeCustomerId ?? null);

    if (!customerId) {
      throw new AppError("You don't have a subscription to manage yet", 409);
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${billing.publicUrl}${ACCOUNT_PAGE}`,
      ...(billing.portalConfiguration && { configuration: billing.portalConfiguration }),
    });

    return { url: session.url };
  },

  // `payload` must be the request body exactly as received: Stripe's
  // signature covers those bytes.
  async handleWebhook(payload: Buffer, signature: string) {
    const { stripe, billing } = requireBilling();

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(payload, signature, billing.webhookSecret);
    } catch {
      throw new AppError("Invalid Stripe signature", 400);
    }

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;

        if (session.mode === "subscription" && session.subscription && session.customer) {
          if (session.client_reference_id) {
            await billingRepository.attachCustomer(session.client_reference_id, idOf(session.customer));
          }
          await billingService.syncSubscription(idOf(session.subscription));
        }
        break;
      }

      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        await billingService.syncSubscription(event.data.object.id);
        break;

      default:
        // Other events need nothing; answering 200 stops Stripe retrying.
        break;
    }
  },

  // Brings the user's plan in line with the subscription. Events can come
  // late, twice or out of order, so the subscription is always fetched
  // fresh from Stripe instead of trusting the event's copy.
  async syncSubscription(subscriptionId: string) {
    const { stripe } = requireBilling();

    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const customerId = idOf(subscription.customer);
    const metadataUserId = subscription.metadata?.userId;

    const user =
      (await billingRepository.findByCustomerId(customerId)) ??
      (metadataUserId ? await billingRepository.findById(metadataUserId) : null);

    if (!user) {
      logger.warn({ subscriptionId, customerId }, "Stripe subscription for an unknown customer, ignored");
      return;
    }

    const paid = isPaid(subscription.status);
    const isCurrent = !user.stripeSubscriptionId || user.stripeSubscriptionId === subscription.id;

    // An older subscription ending must not end the plan of a newer one.
    if (!isCurrent && !paid) {
      return;
    }

    if (!isCurrent && isPaid(user.subscriptionStatus)) {
      logger.warn(
        { userId: user.id, previous: user.stripeSubscriptionId, current: subscription.id },
        "User has two paid subscriptions; the newer one sets the plan. Refund the other in Stripe."
      );
    }

    let plan: Plan = "FREE";

    if (paid) {
      const priceId = subscription.items.data[0]?.price.id;
      const paidPlan = planForPrice(priceId);

      if (!paidPlan) {
        logger.error(
          { userId: user.id, subscriptionId, priceId },
          "Subscription price is not in STRIPE_PRICE_PRO or STRIPE_PRICE_MAX; plan left unchanged"
        );
      }

      plan = paidPlan ?? user.plan;
    }

    const periodEnds = subscription.items.data.map((item) => item.current_period_end);
    const periodEnd = toDate(periodEnds.length ? Math.max(...periodEnds) : null);

    const endsAt =
      toDate(subscription.ended_at) ??
      toDate(subscription.cancel_at) ??
      (subscription.cancel_at_period_end ? periodEnd : null);

    await billingRepository.saveSubscription(user.id, {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
      subscriptionStatus: subscription.status,
      subscriptionPeriodEnd: periodEnd,
      subscriptionEndsAt: endsAt,
      plan,
    });

    logger.info(
      { userId: user.id, subscriptionId, status: subscription.status, plan },
      "Subscription synced"
    );
  },
};
