import "dotenv/config";
import { prisma } from "../lib/prisma";
import { PLANS, PLAN_IDS, planFromApi } from "../credits/plans";

// Moves an account to another plan, e.g. after a payment:
//   npm run set-plan -- user@example.com pro
// In the Docker image (compiled, no ts-node):
//   docker compose exec auth node dist/scripts/setPlan.js user@example.com pro
async function main() {
  const [emailArg, planArg] = process.argv.slice(2);

  const email = emailArg?.trim().toLowerCase();
  const plan = planArg ? planFromApi(planArg.trim()) : null;

  if (!email || !plan) {
    const ids = PLAN_IDS.map((id) => id.toLowerCase()).join("|");
    throw new Error(`Usage: set-plan <email> <${ids}>`);
  }

  const { count } = await prisma.user.updateMany({
    where: { email },
    data: { plan },
  });

  if (count === 0) {
    throw new Error(`No account with the email ${email}`);
  }

  const { name, dailyCredits } = PLANS[plan];
  console.log(`✅ ${email} is now on the ${name} plan (${dailyCredits} credits a day)`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
