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

// Lets the backend spend users' credits (see routes/internal.ts).
const internalApiSecret = requireEnv("INTERNAL_API_SECRET");

if (isProduction && internalApiSecret.length < 32) {
  throw new Error("INTERNAL_API_SECRET must be at least 32 characters in production");
}

// A comma-separated list, e.g. "price_new,price_old". Checkout uses the
// first; all of them count, so subscribers on an older price keep their plan.
function priceList(name: string) {
  const ids = requireEnv(name)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    throw new Error(`${name} must list at least one Stripe price ID`);
  }

  return ids;
}

// Stripe billing is optional. Without STRIPE_SECRET_KEY, plans are only
// changed with the set-plan script; with it, the rest must be set too.
function readBilling() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  if (!secretKey) {
    return null;
  }

  const publicUrl = requireEnv("PUBLIC_URL").replace(/\/+$/, "");

  if (isProduction && !publicUrl.startsWith("https://")) {
    throw new Error("PUBLIC_URL must start with https:// in production");
  }

  return {
    secretKey,
    webhookSecret: requireEnv("STRIPE_WEBHOOK_SECRET"),
    prices: {
      PRO: priceList("STRIPE_PRICE_PRO"),
      MAX: priceList("STRIPE_PRICE_MAX"),
    },
    // From the setup script; Stripe's default portal settings otherwise.
    portalConfiguration: process.env.STRIPE_PORTAL_CONFIGURATION || undefined,
    // Needs Stripe Tax to be set up in the Stripe dashboard first.
    automaticTax: process.env.STRIPE_AUTOMATIC_TAX === "true",
    // Where Stripe sends people back to after checkout.
    publicUrl,
  };
}

export const env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv,
  isProduction,

  // The frontend is normally served from the same origin (via the reverse
  // proxy), so no cross-origin access is needed. List extra browser origins
  // here only if the frontend is hosted elsewhere (comma-separated). The page
  // and the API must share a site or the SameSite=Strict cookie is not sent.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "")
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

  internalApiSecret,

  billing: readBilling(),
};
