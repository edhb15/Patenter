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
  }
}