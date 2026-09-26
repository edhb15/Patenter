import pino from "pino";
import { env } from "./env";

export const logger = pino({
    level:
        env.nodeEnv === "test"
            ? "silent"
            : env.isProduction ? "info" : "debug",

    transport:
        env.nodeEnv === "development"
            ? {
                  target: "pino-pretty",
              }
            : undefined,
});