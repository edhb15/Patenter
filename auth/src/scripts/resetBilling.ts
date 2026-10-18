import "dotenv/config";
import { prisma } from "../lib/prisma";

// Run once when moving Stripe from test keys to live keys, while the test
// key is still configured. Customers and subscriptions made in test mode
// don't exist in live mode, so this removes those links and moves people
// who had a test subscription back to Free:
//   docker compose exec auth node dist/scripts/resetBilling.js --confirm
// Plans given by hand (setPlan.js, no subscription) are left alone.

export async function resetBilling() {
  const [downgraded, unlinked] = await prisma.$transaction([
    prisma.user.updateMany({
      where: { stripeSubscriptionId: { not: null } },
      data: { plan: "FREE" },
    }),
    prisma.user.updateMany({
      where: { OR: [{ stripeCustomerId: { not: null } }, { stripeSubscriptionId: { not: null } }] },
      data: {
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        subscriptionStatus: null,
        subscriptionPeriodEnd: null,
        subscriptionEndsAt: null,
      },
    }),
  ]);

  return { downgraded: downgraded.count, unlinked: unlinked.count };
}

async function main() {
  // With live keys these links are real customers' subscriptions.
  if (/^[sr]k_live_/.test(process.env.STRIPE_SECRET_KEY || "")) {
    throw new Error(
      "STRIPE_SECRET_KEY is a live key, so these are real subscriptions. Nothing was changed.\n" +
        "Run this before switching .env to the live key."
    );
  }

  if (!process.argv.includes("--confirm")) {
    const linked = await prisma.user.count({
      where: { OR: [{ stripeCustomerId: { not: null } }, { stripeSubscriptionId: { not: null } }] },
    });
    console.log(
      `${linked} account(s) are linked to Stripe test data. Nothing was changed.\n` +
        "Run again with --confirm to unlink them and move test subscribers back to Free."
    );
    return;
  }

  const { downgraded, unlinked } = await resetBilling();
  console.log(`✅ Unlinked ${unlinked} account(s) from Stripe; ${downgraded} moved back to Free.`);
}

if (require.main === module) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
