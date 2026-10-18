import type { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";

const billingColumns = {
  id: true,
  email: true,
  plan: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  subscriptionStatus: true,
  subscriptionPeriodEnd: true,
  subscriptionEndsAt: true,
} as const;

export const billingRepository = {
  async findById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: billingColumns,
    });
  },

  async findByCustomerId(stripeCustomerId: string) {
    return prisma.user.findUnique({
      where: { stripeCustomerId },
      select: billingColumns,
    });
  },

  // Links a Stripe customer to the user, in place of `replacing` (null: no
  // customer yet). If another request linked one first (two checkouts at
  // once), that one stays. Returns the customer that is linked, or null if
  // the user no longer exists.
  async attachCustomer(userId: string, stripeCustomerId: string, replacing: string | null = null) {
    await prisma.user.updateMany({
      where: { id: userId, stripeCustomerId: replacing },
      data: { stripeCustomerId },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { stripeCustomerId: true },
    });

    return user?.stripeCustomerId ?? null;
  },

  async saveSubscription(
    userId: string,
    data: {
      stripeCustomerId: string;
      stripeSubscriptionId: string;
      subscriptionStatus: string;
      subscriptionPeriodEnd: Date | null;
      subscriptionEndsAt: Date | null;
      plan: Plan;
    }
  ) {
    return prisma.user.update({
      where: { id: userId },
      data,
    });
  },
};
