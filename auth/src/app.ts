import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";
import authRouter from "./routes/auth";
import internalRouter from "./routes/internal";
import billingRouter, { stripeWebhook } from "./routes/billing";
import cookieParser from "cookie-parser";
import cors from "cors";

const app = express();

if (env.trustProxy) {
  const hops = Number(env.trustProxy);
  app.set("trust proxy", Number.isNaN(hops) ? env.trustProxy : hops);
}

app.use(helmet());
app.use(
  cors({
    origin: env.allowedOrigins,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(
  pinoHttp({
    logger,
    // Never write access tokens or refresh cookies to the logs.
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
    ],
  })
);

// Before express.json(): Stripe's signature covers the raw request body.
app.post(
  "/auth/billing/webhook",
  express.raw({ type: "application/json", limit: "1mb" }),
  stripeWebhook
);

app.use(express.json({ limit: "10kb" }));

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth/billing", billingRouter);
app.use("/auth", authRouter);
app.use("/internal", internalRouter);

// error handler must be last
app.use(errorHandler);

export default app;
