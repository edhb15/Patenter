import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { passwordUtils } from "../src/utils/password";

const prisma = new PrismaClient();

// Creates a first admin account for local development.
// Credentials come from the environment so none are committed to the repo.
async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to seed an admin user"
    );
  }

  if (password.length < 12) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 12 characters");
  }

  const existing = await prisma.user.findUnique({ where: { email } });

  // Never overwrite the password of an existing account.
  if (existing) {
    console.log(`ℹ️  ${email} already exists, leaving it unchanged`);
    return;
  }

  await prisma.user.create({
    data: {
      email,
      passwordHash: await passwordUtils.hash(password),
    },
  });

  console.log(`✅ Seeded admin user ${email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
