import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "../errors/AppError";
import { jwtUtils } from "../utils/jwt";
import { userRepository } from "../users/UserRepository";

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.get("Authorization");

  if (!authHeader) {
    throw new AppError("Authorization header is required", 401);
  }

  if (!authHeader.startsWith("Bearer ")) {
    throw new AppError("Invalid authorization header", 401);
  }

  let payload;

  try {
    payload = jwtUtils.verifyAccessToken(authHeader.slice(7));
  } catch (err) {
    if (err instanceof jwt.JsonWebTokenError) {
      // Also covers TokenExpiredError / NotBeforeError (subclasses).
      throw new AppError("Invalid or expired token", 401);
    }
    throw err;
  }

  // Database errors are deliberately not caught here: they should surface
  // as a 500 (and be logged), not look like the user's token was bad.
  const user = await userRepository.findById(payload.sub);

  if (!user) {
    throw new AppError("Unauthorized", 401);
  }

  req.user = {
    id: user.id,
    email: user.email,
  };

  next();
}
