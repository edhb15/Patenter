import { PrismaClient } from "@prisma/client";
import { passwordUtils } from "../src/utils/password";

const prisma = new PrismaClient();

async function main() {
    const passwordHash = await passwordUtils.hash("Password123!");
  
    await prisma.user.upsert({
        where: {
          email: "admin@example.com",
        },
        update: {
          passwordHash,
        },
        create: {
          email: "admin@example.com",
          passwordHash,
        },
      });
  
    console.log("✅ Seeded admin user");
  }