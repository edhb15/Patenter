import { z } from "zod";

// Emails are compared case-insensitively, so store them lower-case.
const email = z.string().trim().toLowerCase().pipe(z.email());

export const registerSchema = z.object({
  email,
  // Upper bound stops very long inputs being fed to argon2.
  password: z.string().min(8).max(128),
});

// Don't enforce the sign-up policy at login: a wrong password should get
// the same 401 as any other, not a validation error revealing the rules.
export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
});
