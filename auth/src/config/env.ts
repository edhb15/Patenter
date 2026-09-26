import dotenv from "dotenv";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

const accessSecret = requireEnv("JWT_ACCESS_SECRET");

// HS256 secrets shorter than 32 bytes can be brute-forced offline.
if (isProduction && accessSecret.length < 32) {
  throw new Error("JWT_ACCESS_SECRET must be at least 32 characters in production");
}

export const env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv,
  isProduction,

  // Browser origins allowed to call the API with credentials.
  // Comma-separated, e.g. "http://localhost:5500,https://app.patenter.example".
  // The page and the APIs must share a host name (localhost OR 127.0.0.1)
  // or the SameSite=Strict refresh cookie is not sent.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "http://localhost:5500,http://127.0.0.1:5500")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Set when running behind a reverse proxy so rate limits see the real
  // client IP (e.g. "1" for one proxy hop). Leave unset otherwise.
  trustProxy: process.env.TRUST_PROXY,

  // Cookies are HTTPS-only in production. COOKIE_SECURE=false is only
  // for local development over plain http.
  cookieSecure: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE === "true"
    : isProduction,

  jwt: {
    accessSecret,
    issuer: "patenter-auth",
    audience: "patenter",
  },
};
