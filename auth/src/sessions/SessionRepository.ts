import { prisma } from "../lib/prisma";

export const sessionRepository = {
  async create(data: {
    userId: string;
    familyId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }) {
    return prisma.session.create({
      data,
    });
  },

  async findByRefreshTokenHash(refreshTokenHash: string) {
    return prisma.session.findUnique({
      where: {
        refreshTokenHash,
      },
      include: {
        user: true,
      },
    });
  },

  // Marks the old session as used and creates its replacement atomically.
  // Returns null if the old session was already used (a concurrent
  // refresh won the race), so only one caller gets a new token.
  async rotate(data: {
    oldSessionId: string;
    userId: string;
    familyId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.session.updateMany({
        where: {
          id: data.oldSessionId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
        },
      });

      if (count === 0) {
        return null;
      }

      return tx.session.create({
        data: {
          userId: data.userId,
          familyId: data.familyId,
          refreshTokenHash: data.refreshTokenHash,
          expiresAt: data.expiresAt,
        },
      });
    });
  },

  async deleteFamily(familyId: string) {
    return prisma.session.deleteMany({
      where: {
        familyId,
      },
    });
  },

  async deleteAllForUser(userId: string) {
    return prisma.session.deleteMany({
      where: {
        userId,
      },
    });
  },

  async deleteExpiredForUser(userId: string) {
    return prisma.session.deleteMany({
      where: {
        userId,
        expiresAt: {
          lt: new Date(),
        },
      },
    });
  },
};
