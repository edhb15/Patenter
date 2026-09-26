// /patenter/backend/server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const axios = require("axios");
const xml2js = require("xml2js");
const jwt = require("jsonwebtoken");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

// ============================================
// CONFIG
// ============================================

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.log(`❌ Missing ${name} in .env`);
    process.exit(1);
  }
  return value;
}

// The auth service runs on 3000, so this one defaults to 3001.
const PORT = Number(process.env.PORT) || 3001;

// Only the Patenter frontend may call this API from a browser.
// Comma-separated list, e.g. "http://localhost:5500,https://patenter.example"
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || "http://localhost:5500,http://127.0.0.1:5500"
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

// EPO OPS API credentials
const CONSUMER_KEY = requireEnv("CONSUMER_KEY");
const CONSUMER_SECRET = requireEnv("CONSUMER_SECRET");

// OpenRouter (AI) key. Server-side only: never put it in frontend JS,
// it's visible to anyone who views source.
const OPENROUTER_API_KEY = requireEnv("OPENROUTER_API_KEY");

// Access tokens are issued by the auth service; the secret must match.
const JWT_ACCESS_SECRET = requireEnv("JWT_ACCESS_SECRET");

// Fallback list used for both chat and summarization
const AI_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/owl-alpha",
  "inclusionai/ring-2.6-1t:free",
  "poolside/laguna-m.1:free",
  "openai/gpt-oss-120b:free",
  "z-ai/glm-4.5-air:free"
];

// How many top results get full enrichment (biblio + summary).
// Each one costs 2 EPO calls + 1 AI call, so keep this modest.
const ENRICH_COUNT = 5;

// How many patents are enriched at the same time.
const ENRICH_CONCURRENCY = 3;

// Search results are cached so repeat searches don't spend quota again.
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 100;

const MAX_CHAT_MESSAGE_LENGTH = 8000;

const EPO_BASE_URL = "https://ops.epo.org/3.2";

// ============================================
// APP
// ============================================

const app = express();

// Set when running behind a reverse proxy so rate limits see the real
// client IP (e.g. "1" for one proxy hop).
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "20kb" }));

// ============================================
// AUTHENTICATION
// ============================================
// Every endpoint here spends paid EPO / OpenRouter quota, so only
// signed-in users may call them.

function requireAuth(req, res, next) {

  const authHeader = req.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in required" });
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: "patenter-auth",
      audience: "patenter"
    });

    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Per-user limit (falls back to IP) so one account can't drain the quota.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  keyGenerator: (req, res) => req.userId || ipKeyGenerator(req.ip),
  message: { error: "Too many requests, please try again later" }
});

// ============================================
// EPO ACCESS TOKEN (cached until shortly before it expires)
// ============================================

const epo = axios.create({
  baseURL: EPO_BASE_URL,
  timeout: 20000
});

let cachedEpoToken = null;
let cachedEpoTokenExpiresAt = 0;
let pendingEpoToken = null;

async function fetchAccessToken() {

  try {

    const response = await epo.post(
      "/auth/accesstoken",
      new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    // EPO tokens live ~20 minutes; refresh a minute early.
    const lifetimeSeconds = Number(response.data.expires_in) || 1200;
    cachedEpoToken = response.data.access_token;
    cachedEpoTokenExpiresAt = Date.now() + (lifetimeSeconds - 60) * 1000;

    return cachedEpoToken;

  } catch (error) {

    console.error("❌ Failed to get access token:");
    console.error(error.response?.data || error.message);

    throw error;
  }
}

async function getAccessToken() {

  if (cachedEpoToken && Date.now() < cachedEpoTokenExpiresAt) {
    return cachedEpoToken;
  }

  // Concurrent searches share one token request.
  if (!pendingEpoToken) {
    pendingEpoToken = fetchAccessToken().finally(() => {
      pendingEpoToken = null;
    });
  }

  return pendingEpoToken;
}

function epoGet(token, path) {
  return epo.get(path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml"
    }
  });
}

// ============================================
// TEXT HELPERS
// ============================================

// EPO XML text nodes often come back as either a plain string
// or an array of strings/objects (e.g. multiple <p> per paragraph).
// This flattens whatever we get into one plain string.
function flattenXmlText(node) {

  if (!node) return "";

  if (typeof node === "string") return node;

  if (Array.isArray(node)) {
    return node.map(flattenXmlText).join(" ");
  }

  if (typeof node === "object") {
    // xml2js sometimes puts text content under "_"
    if (node._) return flattenXmlText(node._);
    return Object.values(node).map(flattenXmlText).join(" ");
  }

  return String(node);
}

function cleanWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

// ============================================
// FETCH BIBLIOGRAPHIC DATA (title, inventor, date)
// ============================================

async function fetchBiblio(token, patentNumber) {

  const response = await epoGet(
    token,
    `/rest-services/published-data/publication/epodoc/${encodeURIComponent(patentNumber)}/biblio`
  );

  const parsed = await xml2js.parseStringPromise(response.data);

  const exchangeDoc =
    parsed["ops:world-patent-data"]
      ?.["exchange-documents"]?.[0]
      ?.["exchange-document"]?.[0];

  // TITLE — prefer English, fall back to first available
  const titleNodes =
    exchangeDoc?.["bibliographic-data"]?.[0]
      ?.["invention-title"] || [];

  let title = "";

  const englishTitle = titleNodes.find(
    t => t?.$?.lang === "en"
  );

  if (englishTitle) {
    title = flattenXmlText(englishTitle);
  } else if (titleNodes[0]) {
    title = flattenXmlText(titleNodes[0]);
  }

  // INVENTOR(S)
  const inventorNodes =
    exchangeDoc?.["bibliographic-data"]?.[0]
      ?.["parties"]?.[0]
      ?.["inventors"]?.[0]
      ?.["inventor"] || [];

  const inventors = inventorNodes
    .map(inv => {
      const name =
        inv?.["inventor-name"]?.[0]?.["name"]?.[0];
      return name ? flattenXmlText(name) : null;
    })
    .filter(Boolean);

  const inventor =
    inventors.length > 0
      ? inventors.join(", ")
      : "Not available";

  // PUBLICATION DATE (from the main publication reference)
  const pubRefs =
    exchangeDoc?.["bibliographic-data"]?.[0]
      ?.["publication-reference"]?.[0]
      ?.["document-id"] || [];

  let publicationDate = "";

  for (const docId of pubRefs) {
    const dateNode = docId?.date?.[0];
    if (dateNode) {
      publicationDate = flattenXmlText(dateNode);
      break;
    }
  }

  return {
    title: title || "Untitled",
    inventor,
    publicationDate: publicationDate || "Unknown"
  };
}

// ============================================
// FETCH DESCRIPTION TEXT (summarization source)
// ============================================

async function fetchDescription(token, patentNumber) {

  const response = await epoGet(
    token,
    `/rest-services/published-data/publication/epodoc/${encodeURIComponent(patentNumber)}/description`
  );

  const parsed = await xml2js.parseStringPromise(response.data);

  const description =
    parsed["ops:world-patent-data"]
      ?.["ftxt:fulltext-documents"]?.[0]
      ?.["ftxt:fulltext-document"]?.[0]
      ?.["description"]?.[0];

  const text = cleanWhitespace(flattenXmlText(description));

  // Cap length sent to the AI — descriptions can be very long
  // and we only need enough context for a 10-line summary.
  return text.slice(0, 6000);
}

// ============================================
// AI (server-side, OpenRouter)
// ============================================

// Tries each model in turn; returns { model, message } or null.
async function callOpenRouter(messages) {

  for (const model of AI_MODELS) {

    try {

      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "http://localhost",
            "X-Title": "Patenter AI",
            "Content-Type": "application/json"
          },
          timeout: 60000
        }
      );

      const message =
        response.data?.choices?.[0]?.message?.content;

      if (message) {
        return { model, message: message.trim() };
      }

    } catch (error) {

      console.log(`⚠️ AI model failed: ${model}`);
      console.error(error.response?.data || error.message);
    }
  }

  return null;
}

async function summarizeText(sourceText, title) {

  if (!sourceText) {
    return "No description text was available to summarize.";
  }

  const prompt =
    `Summarize the following patent description in plain English, ` +
    `maximum 10 lines, no markdown headings, no preamble:\n\n` +
    `Title: ${title}\n\n${sourceText}`;

  const result = await callOpenRouter([
    {
      role: "system",
      content: "You summarize patents clearly and concisely, max 10 lines, plain text only."
    },
    {
      role: "user",
      content: prompt
    }
  ]);

  return result
    ? result.message
    : "Summary unavailable — all AI models failed.";
}

// ============================================
// ESPACENET LINK (no API call needed)
// ============================================

function buildEspacenetLink(patentNumber) {
  return `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(`pn=${patentNumber}`)}`;
}

// ============================================
// SMALL HELPERS
// ============================================

// Runs fn over items with at most `limit` running at once.
async function mapWithConcurrency(items, limit, fn) {

  let next = 0;

  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

// In-memory search cache, oldest entries evicted first.
const searchCache = new Map();

function getCachedSearch(key) {

  const entry = searchCache.get(key);

  if (!entry) return null;

  if (entry.expiresAt < Date.now()) {
    searchCache.delete(key);
    return null;
  }

  return entry.patents;
}

function setCachedSearch(key, patents) {

  searchCache.delete(key);
  searchCache.set(key, { patents, expiresAt: Date.now() + SEARCH_CACHE_TTL_MS });

  while (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
    searchCache.delete(searchCache.keys().next().value);
  }
}

// ============================================
// ENRICH ONE PATENT (biblio data + AI summary + Espacenet link)
// ============================================

async function enrichPatent(token, patent) {

  try {

    console.log(`🔬 Enriching ${patent.patentNumber}...`);

    const biblio = await fetchBiblio(token, patent.patentNumber);

    patent.title = biblio.title;
    patent.inventor = biblio.inventor;
    patent.publicationDate = biblio.publicationDate;

    // Description + summary — isolated so a failure here
    // doesn't wipe out the biblio data we already got.
    try {

      const descriptionText = await fetchDescription(token, patent.patentNumber);

      patent.summary = await summarizeText(descriptionText, biblio.title);

    } catch (descError) {

      console.error(`⚠️ Description/summary failed for ${patent.patentNumber}`);
      console.error(descError.response?.data || descError.message);

      patent.summary = "Summary unavailable for this patent.";
    }

    console.log(`✅ Enriched ${patent.patentNumber}`);

  } catch (enrichError) {

    console.error(`❌ Enrichment failed for ${patent.patentNumber}`);
    console.error(enrichError.response?.data || enrichError.message);

    // Fall back to placeholders so the frontend still
    // has fields to render, just marked unavailable.
    patent.title = patent.title || "Details unavailable";
    patent.inventor = patent.inventor || "Not available";
    patent.publicationDate = patent.publicationDate || "Unknown";
    patent.summary = patent.summary || "Details unavailable for this patent.";
  }
}

// ============================================
// SEARCH PATENTS
// ============================================

app.post("/search", requireAuth, apiLimiter, async (req, res) => {

  try {

    const { company } = req.body || {};

    if (typeof company !== "string" || !company.trim()) {
      return res.status(400).json({
        error: "Company name required"
      });
    }

    // Quotes/backslashes would break out of the pa="..." CQL phrase.
    if (company.length > 200 || /["\\]/.test(company)) {
      return res.status(400).json({
        error: "Invalid company name"
      });
    }

    const name = company.trim();
    const cacheKey = name.toLowerCase();

    const cached = getCachedSearch(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        company: name,
        total: cached.length,
        patents: cached
      });
    }

    console.log(`🔎 Searching for ${name}`);

    const token = await getAccessToken();

    const searchResponse = await epoGet(
      token,
      `/rest-services/published-data/search?q=${encodeURIComponent(`pa="${name}"`)}`
    );

    const parsedSearch = await xml2js.parseStringPromise(searchResponse.data);

    const publications =
      parsedSearch["ops:world-patent-data"]
        ?.["ops:biblio-search"]?.[0]
        ?.["ops:search-result"]?.[0]
        ?.["ops:publication-reference"] || [];

    console.log(`📄 Found ${publications.length} publications`);

    const patents = publications.map((pub, index) => {

      const documentId = pub["document-id"]?.[0];

      const country = documentId?.country?.[0] || "";
      const docNumber = documentId?.["doc-number"]?.[0] || "";
      const kind = documentId?.kind?.[0] || "";

      const patentNumber = `${country}${docNumber}${kind}`;

      return {
        index: index + 1,
        patentNumber,
        link: buildEspacenetLink(patentNumber)
      };
    });

    await mapWithConcurrency(
      patents.slice(0, ENRICH_COUNT),
      ENRICH_CONCURRENCY,
      patent => enrichPatent(token, patent)
    );

    // Patents beyond ENRICH_COUNT get a placeholder summary
    // so the frontend doesn't break on them.
    for (const patent of patents.slice(ENRICH_COUNT)) {
      patent.title = patent.patentNumber;
      patent.inventor = "Not loaded";
      patent.publicationDate = "Not loaded";
      patent.summary = "Not loaded — showing top results only.";
    }

    setCachedSearch(cacheKey, patents);

    res.json({
      success: true,
      company: name,
      total: patents.length,
      patents
    });

  } catch (error) {

    console.error("❌ Search failed");
    console.error(error.response?.data || error.message);

    res.status(500).json({
      error: "Patent search failed"
    });
  }
});

// ============================================
// PATENTER AI CHAT (proxied so the API key stays on the server)
// ============================================

const CHAT_SYSTEM_PROMPT = `
You are Patenter AI.

Always format responses using markdown.

Use:
# Headings
## Sections
- Bullet points
**Bold**
\`\`\`
Code blocks
\`\`\`

You help users:
- Create patent ideas
- Generate inventions
- Write patent claims
- Explain inventions
- Create technical summaries
- Improve product concepts
`;

app.post("/chat", requireAuth, apiLimiter, async (req, res) => {

  const { message } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "Message is too long" });
  }

  const result = await callOpenRouter([
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    { role: "user", content: message }
  ]);

  if (!result) {
    return res.status(502).json({
      success: false,
      message: "All AI models failed."
    });
  }

  res.json({
    success: true,
    model: result.model,
    message: result.message
  });
});

// Malformed JSON and oversized bodies are client errors, not 500s.
app.use((err, req, res, next) => {

  if (err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: "Invalid request" });
  }

  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

// ============================================
// START SERVER
// ============================================

if (require.main === module) {

  app.listen(PORT, () => {

    console.log("");
    console.log("=================================");
    console.log("🚀 Patenter Backend Running");
    console.log(`🌍 http://localhost:${PORT}`);
    console.log("=================================");
    console.log("");
  });
}

module.exports = { app, buildEspacenetLink, flattenXmlText, mapWithConcurrency };
