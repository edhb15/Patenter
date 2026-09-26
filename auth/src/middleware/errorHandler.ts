import { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/AppError";
import { logger } from "../config/logger";
import { ZodError } from "zod";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction
) {
  
  if (err instanceof ZodError) {
    logger.warn(
      {
        msg: "Validation failed",
        issues: err.issues,
        path: req.path,
        method: req.method,
      },
      "Validation error"
    );
  
    return res.status(400).json({
      error: "Validation failed",
      details: err.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  // If it's one of our expected operational errors
  if (err instanceof AppError) {
    logger.warn(
      {
        msg: err.message,
        statusCode: err.statusCode,
        path: req.path,
        method: req.method,
      },
      "Operational error"
    );

    return res.status(err.statusCode).json({
      error: err.message,
    });
  }

  // Unexpected / programmer errors
  logger.error(
    {
      err,
      path: req.path,
      method: req.method,
    },
    "Unexpected error"
  );

  return res.status(500).json({
    error: "Internal Server Error",
  });
}