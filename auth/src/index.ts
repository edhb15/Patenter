import app from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";
import "dotenv/config";

app.listen(env.port, () => {
    logger.info(
        { port: env.port },
        "Server started successfully"
    );
});