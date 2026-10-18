import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/AppError";
import { env } from "../config/env";

// Hashing both sides first gives equal-length inputs, so the comparison
// takes the same time whatever was sent.
function secretMatches(given: string) {
  const hash = (value: string) => crypto.createHash("sha256").update(value).digest();
  return crypto.timingSafeEqual(hash(given), hash(env.internalApiSecret));
}

// For service-to-service routes. The reverse proxy never routes these
// from the internet; the shared secret is a second line of defence.
export function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ") || !secretMatches(authHeader.slice(7))) {
    throw new AppError("Unauthorized", 401);
  }

  next();
}
