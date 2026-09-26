import { prisma } from "../lib/prisma";

export const sessionRepository = {
  async create(data: {
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }) {
    return prisma.session.create({
      data,
    });
  },

  async findByRefreshTokenHash(refreshTokenHash: string) {
    return prisma.session.findFirst({
      where: {
        refreshTokenHash,
      },
      include: {
        user: true,
      },
    });
  },
  async delete(id: string) {
    return prisma.session.delete({
      where: {
        id,
      },
    });
  },

  async deleteIfExists(id: string) {
    return prisma.session.deleteMany({
      where: {
        id,
      },
    });
  },

  // Deletes the old session and creates its replacement atomically.
  // Returns null if the old session was already gone (token reused
  // or a concurrent refresh won the race).
  async rotate(data: {
    oldSessionId: string;
    userId: string;
    refreshTokenHash: string;
    expiresAt: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      const { count } = await tx.session.deleteMany({
        where: {
          id: data.oldSessionId,
        },
      });

      if (count === 0) {
        return null;
      }

      return tx.session.create({
        data: {
          userId: data.userId,
          refreshTokenHash: data.refreshTokenHash,
          expiresAt: data.expiresAt,
        },
      });
    });
  },
};