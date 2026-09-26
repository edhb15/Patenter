import express from "express";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { errorHandler } from "./middleware/errorHandler";
import authRouter from "./routes/auth";
import cookieParser from "cookie-parser";
import cors from "cors";

const app = express();

app.use(
  cors({
    origin: [
      "http://127.0.0.1:5500",
      "http://localhost:5000",
    ],
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());
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

app.get("/", (req, res) => {
  res.json({ message: "Secure Authentication API" });
});

// NEW
app.use("/auth", authRouter);

// error handler must be last
app.use(errorHandler);

export default app;