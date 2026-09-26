import { Request, Response, NextFunction } from "express";
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

  const token = authHeader.slice(7);

  try {
    const payload = jwtUtils.verifyAccessToken(token) as {
      sub: string;
      email: string;
    };

    const user = await userRepository.findById(payload.sub);

    if (!user) {
        throw new AppError("Unauthorized", 401);
    }

    req.user = {
        id: user.id,
        email: user.email,
      };

    next();
  } catch {
    throw new AppError("Invalid or expired token", 401);
  }
}