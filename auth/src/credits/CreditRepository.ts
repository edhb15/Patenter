import type { Plan } from "@prisma/client";
import { prisma } from "../lib/prisma";

export type CreditState = {
  plan: Plan;
  creditsUsed: number;
  creditsDay: Date | null;
};

type CreditChange<T> = {
  // New values to store, or null to leave the row unchanged.
  save: { creditsUsed: number; creditsDay: Date } | null;
  result: T;
};

export const creditRepository = {
  async find(userId: string): Promise<CreditState | null> {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, creditsUsed: true, creditsDay: true },
    });
  },

  // Runs `change` while the user's row is locked, so two concurrent
  // requests can't both spend the same credits. Returns null if there is
  // no such user.
  async update<T>(
    userId: string,
    change: (state: CreditState) => CreditChange<T>
  ): Promise<T | null> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<CreditState[]>`
        SELECT "plan", "creditsUsed", "creditsDay"
        FROM "User"
        WHERE "id" = ${userId}
        FOR UPDATE`;

      if (rows.length === 0) {
        return null;
      }

      const { save, result } = change(rows[0]);

      if (save) {
        await tx.user.update({
          where: { id: userId },
          data: save,
        });
      }

      return result;
    });
  },
};
