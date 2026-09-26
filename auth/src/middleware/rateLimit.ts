import { rateLimit } from "express-rate-limit";

// Slows down password guessing and stops argon2 hashing from being
// used to exhaust the server's CPU.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  // Successful logins don't count against the limit.
  skipSuccessfulRequests: true,
  message: { error: "Too many login attempts, please try again later" },
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many accounts created, please try again later" },
});
