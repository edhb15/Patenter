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

  // Client errors raised by Express itself, e.g. malformed JSON (400)
  // or a body over the size limit (413).
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    return res.status(status).json({
      error: status === 413 ? "Request body too large" : "Invalid request",
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