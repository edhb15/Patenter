import { Router, Request, Response } from "express";
import Stripe from "stripe";
import { AppError } from "../errors/AppError";
import { logger } from "../config/logger";
import { authenticate } from "../middleware/auth";
import { billingLimiter } from "../middleware/rateLimit";
import { checkoutSchema } from "../schemas/billing";
import { billingService } from "../services/billingService";

const router = Router();

// Stripe being down or misconfigured isn't the user's fault: log the
// details and tell them plainly.
async function viaStripe<T>(request: () => Promise<T>) {
  try {
    return await request();
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      logger.error({ err }, "Stripe request failed");
      throw new AppError("The payment service could not be reached. Please try again in a moment.", 502);
    }
    throw err;
  }
}

router.post("/checkout", authenticate, billingLimiter, async (req, res) => {
  const { plan } = checkoutSchema.parse(req.body);

  const { url } = await viaStripe(() =>
    billingService.startCheckout(req.user!.id, plan === "pro" ? "PRO" : "MAX")
  );

  return res.json({ url });
});

router.post("/portal", authenticate, billingLimiter, async (req, res) => {
  const { url } = await viaStripe(() => billingService.openPortal(req.user!.id));

  return res.json({ url });
});

// Stripe calls this for subscription changes. It is mounted with a raw
// body parser in app.ts, because the signature covers the exact bytes.
export async function stripeWebhook(req: Request, res: Response) {
  const signature = req.get("stripe-signature");

  if (!signature || !Buffer.isBuffer(req.body)) {
    throw new AppError("Missing Stripe signature", 400);
  }

  await billingService.handleWebhook(req.body, signature);

  return res.json({ received: true });
}

export default router;
