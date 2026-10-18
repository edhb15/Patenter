import { Router } from "express";
import { creditService } from "../services/creditService";
import { requireInternalSecret } from "../middleware/internalAuth";
import { spendSchema, refundSchema } from "../schemas/credits";

// Called by the backend (backend/server.js), never by browsers: it lives
// outside /auth, which is the only path the reverse proxy forwards here.
const router = Router();

router.use(requireInternalSecret);

router.post("/credits/spend", async (req, res) => {
  const { userId, amount, partial } = spendSchema.parse(req.body);

  const result = await creditService.spend(userId, amount, partial ?? false);

  if (!result.ok) {
    return res.status(402).json({
      error: "Not enough credits",
      credits: result.credits,
    });
  }

  return res.json({
    spent: result.spent,
    day: result.day,
    credits: result.credits,
  });
});

router.post("/credits/refund", async (req, res) => {
  const { userId, amount, day } = refundSchema.parse(req.body);

  const credits = await creditService.refund(userId, amount, day);

  return res.json({ credits });
});

export default router;
