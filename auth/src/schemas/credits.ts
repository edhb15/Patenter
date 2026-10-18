import { z } from "zod";

const userId = z.string().min(1).max(100);

// No action costs anywhere near this; it only rejects nonsense.
const amount = z.number().int().positive().max(10000);

export const spendSchema = z.object({
  userId,
  amount,
  partial: z.boolean().optional(),
});

export const refundSchema = z.object({
  userId,
  amount,
  day: z.iso.date(),
});
