import { rateLimit } from "express-rate-limit";
import { env } from "../config/env";

// The integration tests make many requests from one IP.
const skip = () => env.nodeEnv === "test";

// Slows down password guessing and stops argon2 hashing from being
// used to exhaust the server's CPU.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip,
  // Successful logins don't count against the limit.
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts, please try again later" },
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip,
  message: { error: "Too many accounts created, please try again later" },
});

// Pages refresh on load, so allow plenty, but stop token guessing.
export const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip,
  message: { error: "Too many requests, please try again later" },
});
