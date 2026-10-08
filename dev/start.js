#!/usr/bin/env node
// Runs the whole Patenter site on this computer without Docker:
// auth service, API and a small web server that does Caddy's job
// (serves the pages and forwards /auth and /api). For local testing only.
//
//   1. Start PostgreSQL (e.g. Postgres.app).
//   2. Fill in .env in the repository root (see dev/README.md).
//   3. node dev/start.js
//   4. Open http://localhost:8080

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const AUTH_DIR = path.join(ROOT, "auth");
const BACKEND_DIR = path.join(ROOT, "backend");

const WEB_PORT = Number(process.env.WEB_PORT) || 8080;
const AUTH_PORT = 3000;
const API_PORT = 3001;

// ============================================
// SETTINGS (from .env in the repository root)
// ============================================

function readEnvFile(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

const ENV_FILE = path.join(ROOT, ".env");

// First run: create .env with a fresh signing secret, so only the
// EPO and OpenRouter keys have to be filled in by hand.
if (!fs.existsSync(ENV_FILE)) {
  const secret = require("crypto").randomBytes(48).toString("base64");
  fs.writeFileSync(ENV_FILE, [
    "# Patenter settings for local testing (dev/start.js). Never commit this file.",
    "",
    "# EPO Open Patent Services credentials (https://developers.epo.org).",
    "CONSUMER_KEY=",
    "CONSUMER_SECRET=",
    "",
    "# OpenRouter key for Patenter AI and patent summaries (https://openrouter.ai/keys).",
    "OPENROUTER_API_KEY=",
    "",
    "# Created automatically. Signs login tokens.",
    `JWT_ACCESS_SECRET=${secret}`,
    "",
    "# Leave empty to use the free testing models built into the backend.",
    "AI_MODELS=",
    "",
  ].join("\n"), { mode: 0o600 });
  console.log(`\n📝 Created ${ENV_FILE}`);
  console.log("   Open it with:  open -e .env");
  console.log("   Fill in CONSUMER_KEY, CONSUMER_SECRET and OPENROUTER_API_KEY, save, then run this again.\n");
  process.exit(0);
}

const settings = { ...readEnvFile(ENV_FILE), ...process.env };

const missing = ["JWT_ACCESS_SECRET", "CONSUMER_KEY", "CONSUMER_SECRET", "OPENROUTER_API_KEY"]
  .filter(name => !settings[name]);
if (missing.length) {
  fail(`Fill in ${missing.join(", ")} in .env (open it with: open -e .env), then run this again.`);
}

// Postgres.app accepts the Mac user name without a password.
const DATABASE_URL = settings.DATABASE_URL
  || `postgresql://${encodeURIComponent(require("os").userInfo().username)}@localhost:5432/patenter`;

const childEnv = {
  ...settings,
  DATABASE_URL,
  NODE_ENV: "development",
  // Plain http on localhost, so the refresh cookie must not be HTTPS-only.
  COOKIE_SECURE: "false",
  PUBLIC_URL: `http://localhost:${WEB_PORT}`,
  // Requests reach the services through this script, not a real proxy.
  TRUST_PROXY: "",
  ALLOWED_ORIGINS: "",
};

// ============================================
// SETUP: dependencies and database
// ============================================

function run(command, args, cwd, label) {
  console.log(`▶ ${label}`);
  const result = spawnSync(command, args, { cwd, env: childEnv, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) fail(`${label} failed (see the messages above).`);
}

// Check that PostgreSQL is running before anything else, for a clear message.
{
  const db = new URL(DATABASE_URL);
  const probe = spawnSync(process.execPath, ["-e", `
    const s = require("net").connect(${Number(db.port) || 5432}, ${JSON.stringify(db.hostname || "localhost")});
    s.setTimeout(3000);
    s.on("connect", () => process.exit(0));
    s.on("error", () => process.exit(1));
    s.on("timeout", () => process.exit(1));
  `]);
  if (probe.status !== 0) {
    fail("PostgreSQL is not running. Open Postgres.app and click Start, then run this again.");
  }
}

for (const dir of [AUTH_DIR, BACKEND_DIR]) {
  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    run("npm", ["ci"], dir, `Installing packages in ${path.basename(dir)}/ (first run only)`);
  }
}

run("npx", ["prisma", "generate"], AUTH_DIR, "Preparing database client");
run("npx", ["prisma", "migrate", "deploy"], AUTH_DIR, "Updating database (" + DATABASE_URL.replace(/\/\/[^@]*@/, "//") + ")");

// ============================================
// SERVICES
// ============================================

const children = [];

// The auth service logs one JSON object per line (see AUTH_ENV below).
// Turn each into one short line; full request dumps hide what matters.
function formatAuthLog(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return line;
  }

  if (entry.msg === "request completed" && entry.req && entry.res) {
    const status = entry.res.statusCode;
    const note = entry.req.url === "/auth/refresh" && status === 401 ? "  (not signed in yet, normal)" : "";
    return `${entry.req.method} ${entry.req.url} → ${status}${note}`;
  }
  if (Array.isArray(entry.issues)) {
    const details = entry.issues.map(issue => `${(issue.path || []).join(".")}: ${issue.message}`).join("; ");
    return `⚠ ${entry.msg}: ${details}`;
  }
  // Expected 4xx errors; the request line that follows shows the status.
  if (entry.level < 50 && entry.statusCode && entry.statusCode < 500) return null;

  const extra = entry.port ? ` (port ${entry.port})` : "";
  const error = entry.err ? `\n${entry.err.stack || entry.err.message}` : "";
  return `${entry.level >= 50 ? "❌ " : ""}${entry.msg}${extra}${error}`;
}

function start(label, command, args, cwd, port, extraEnv = {}, format = line => line) {
  const child = spawn(command, args, {
    cwd,
    env: { ...childEnv, ...extraEnv, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.on("data", data => {
      const lines = (pending + data.toString()).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const text = line && format(line);
        if (text) console.log(text.split("\n").map(part => `[${label}] ${part}`).join("\n"));
      }
    });
  }
  child.on("exit", code => {
    if (!shuttingDown) {
      console.error(`\n❌ ${label} stopped (exit code ${code}). Stopping everything.`);
      shutdown(1);
    }
  });
  children.push(child);
}

// Run ts-node with node directly: npx would not pass on the stop signal.
const TS_NODE = path.join(AUTH_DIR, "node_modules", "ts-node", "dist", "bin.js");
// NODE_ENV=production only switches the auth logger to compact JSON lines
// (formatted above). The cookie stays usable over http: COOKIE_SECURE=false.
const AUTH_ENV = { NODE_ENV: "production" };
start("auth", process.execPath, [TS_NODE, "src/index.ts"], AUTH_DIR, AUTH_PORT, AUTH_ENV, formatAuthLog);
start("api ", process.execPath, ["server.js"], BACKEND_DIR, API_PORT);

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ============================================
// WEB SERVER (what deploy/Caddyfile does in production)
// ============================================

// Only the public frontend files, same as deploy/web.Dockerfile.
const PUBLIC_FILES = new Set(["index.html", "login.html"]);
const PUBLIC_DIRS = new Set(["app", "shared", "images-and-other-branding"]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function serveFile(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, "Bad request");
  }

  const parts = urlPath.split("/").filter(Boolean);
  if (parts.some(part => part === ".." || part.startsWith("."))) return send(res, 404, "Not found");

  const allowed = parts.length === 0
    || (parts.length === 1 && PUBLIC_FILES.has(parts[0]))
    || PUBLIC_DIRS.has(parts[0]);
  if (!allowed) return send(res, 404, "Not found");

  let file = path.join(ROOT, ...parts);
  let stat = fs.statSync(file, { throwIfNoEntry: false });

  if (stat && stat.isDirectory()) {
    if (!urlPath.endsWith("/")) return send(res, 308, "", { Location: urlPath + "/" });
    file = path.join(file, "index.html");
    stat = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!stat || !stat.isFile()) return send(res, 404, "Not found");

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "Content-Length": stat.size,
    "Cache-Control": "no-cache",
  });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

function proxy(req, res, port, targetPath) {
  const upstream = http.request({
    host: "127.0.0.1",
    port,
    method: req.method,
    path: targetPath,
    headers: req.headers,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => send(res, 502, "Service is not running yet. Wait a moment and reload."));
  req.pipe(upstream);
}

http.createServer((req, res) => {
  if (req.url === "/auth" || req.url.startsWith("/auth/")) {
    return proxy(req, res, AUTH_PORT, req.url);
  }
  if (req.url.startsWith("/api/")) {
    // Like Caddy's handle_path: /api/search -> backend /search.
    return proxy(req, res, API_PORT, req.url.slice("/api".length));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  serveFile(req, res);
}).listen(WEB_PORT, "127.0.0.1", () => {
  console.log(`\n✅ Patenter is starting on http://localhost:${WEB_PORT}  (Ctrl+C to stop)\n`);
});
