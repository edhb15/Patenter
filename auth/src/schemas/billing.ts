import { z } from "zod";

// Only paid plans can be bought; going back to Free is a cancellation
// in the customer portal.
export const checkoutSchema = z.object({
  plan: z.enum(["pro", "max"]),
});
