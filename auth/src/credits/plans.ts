import type { Plan } from "@prisma/client";

// Every plan gets a fresh credit allowance each day (UTC). What each
// action costs is decided by the API that runs it (backend/server.js).
export const PLANS: Record<Plan, { name: string; dailyCredits: number; monthlyPriceUsd: number }> = {
  FREE: { name: "Free", dailyCredits: 100, monthlyPriceUsd: 0 },
  PRO: { name: "Pro", dailyCredits: 500, monthlyPriceUsd: 10 },
  MAX: { name: "Max", dailyCredits: 1000, monthlyPriceUsd: 20 },
};

export const PLAN_IDS = Object.keys(PLANS) as Plan[];

// The API uses lower-case ids ("free", "pro", "max").
export function planToApi(plan: Plan) {
  return {
    id: plan.toLowerCase(),
    ...PLANS[plan],
  };
}

export function planFromApi(id: string): Plan | null {
  const plan = id.toUpperCase() as Plan;
  return PLAN_IDS.includes(plan) ? plan : null;
}
