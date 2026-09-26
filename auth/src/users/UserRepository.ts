import { prisma } from "../lib/prisma";

export const userRepository = {
  async findByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
    });
  },

  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
    });
  },

  async create(data: {
    email: string;
    passwordHash: string;
  }) {
    return prisma.user.create({
      data,
    });
  },
};