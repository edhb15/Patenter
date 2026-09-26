import "express";
import type { AuthenticatedUser } from "../users/types";

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}