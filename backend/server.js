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

// Public address of the site, e.g. "https://patenter.example". Sent to
// OpenRouter so requests are attributed to Patenter.
const PUBLIC_URL = process.env.PUBLIC_URL || "https://patenter.app";

// The frontend is normally served from the same origin (via the reverse
// proxy), so no cross-origin access is needed. List extra browser origins
// here only if the frontend is hosted elsewhere (comma-separated).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
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

// Fallback list used for both chat and summarization, tried in order.
//
// Users send unpublished inventions to these models, and disclosing an
// invention before filing can destroy its novelty. In production, set
// AI_MODELS to paid models from providers that do not log or train on
// prompts (and enable zero-data-retention in the OpenRouter account).
// The free models below are only suitable for testing.
const DEFAULT_AI_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/owl-alpha",
  "inclusionai/ring-2.6-1t:free",
  "poolside/laguna-m.1:free",
  "openai/gpt-oss-120b:free",
  "z-ai/glm-4.5-air:free"
];

const AI_MODELS = process.env.AI_MODELS
  ? process.env.AI_MODELS.split(",").map(model => model.trim()).filter(Boolean)
  : DEFAULT_AI_MODELS;

// How many top results get full enrichment (biblio + summary).
// Each one costs 2 EPO calls + 1 AI call, so keep this modest.
const ENRICH_COUNT = 5;

// How many patents are enriched at the same time.
const ENRICH_CONCURRENCY = 3;

// Search results are cached so repeat searches don't spend quota again.
const SEARCH_CACHE_TTL_MS = 60 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 100;

const MAX_CHAT_MESSAGE_LENGTH = 8000;

// Earlier turns sent with a chat message, so the AI can follow up.
const MAX_CHAT_HISTORY_MESSAGES = 20;
const MAX_CHAT_HISTORY_CHARS = 40000;

// Prior-art comparison: how many references are compared with the claim.
const COMPARE_COUNT = 5;
const MAX_CLAIM_LENGTH = 6000;

const MAX_ASSIST_INSTRUCTION_LENGTH = 1000;

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
// Room for a chat message plus its conversation history.
app.use(express.json({ limit: "100kb" }));

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
    // "$" holds attributes (lang, data-format...), not text.
    return Object.entries(node)
      .filter(([key]) => key !== "$")
      .map(([, value]) => flattenXmlText(value))
      .join(" ");
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

  // APPLICANT(S) — the "epodoc" form, e.g. "ACME CORP [US]"
  const applicantNodes =
    exchangeDoc?.["bibliographic-data"]?.[0]
      ?.["parties"]?.[0]
      ?.["applicants"]?.[0]
      ?.["applicant"] || [];

  const epodocApplicants = applicantNodes.filter(app => app?.$?.["data-format"] !== "original");

  const applicants = [...new Set(
    (epodocApplicants.length > 0 ? epodocApplicants : applicantNodes)
      .map(app => {
        const name = app?.["applicant-name"]?.[0]?.["name"]?.[0];
        return name ? cleanWhitespace(flattenXmlText(name)) : null;
      })
      .filter(Boolean)
  )];

  // ABSTRACT — prefer English
  const abstractNodes = exchangeDoc?.["abstract"] || [];

  const abstractNode =
    abstractNodes.find(a => a?.$?.lang === "en") || abstractNodes[0];

  return {
    title: title || "Untitled",
    inventor,
    applicant: applicants.length > 0 ? applicants.join(", ") : "Not available",
    publicationDate: publicationDate || "Unknown",
    abstract: abstractNode ? cleanWhitespace(flattenXmlText(abstractNode)) : ""
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
            "HTTP-Referer": PUBLIC_URL,
            "X-Title": "Patenter",
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
    patent.applicant = biblio.applicant;
    patent.publicationDate = biblio.publicationDate;
    patent.abstract = biblio.abstract;

    // Description + summary — isolated so a failure here
    // doesn't wipe out the biblio data we already got.
    try {

      const descriptionText = await fetchDescription(token, patent.patentNumber);

      patent.summary = await summarizeText(descriptionText || biblio.abstract, biblio.title);

    } catch (descError) {

      console.error(`⚠️ Description/summary failed for ${patent.patentNumber}`);
      console.error(descError.response?.data || descError.message);

      // Many offices publish no full text on OPS; the abstract still helps.
      patent.summary = biblio.abstract
        ? await summarizeText(biblio.abstract, biblio.title)
        : "Summary unavailable for this patent.";
    }

    console.log(`✅ Enriched ${patent.patentNumber}`);

  } catch (enrichError) {

    console.error(`❌ Enrichment failed for ${patent.patentNumber}`);
    console.error(enrichError.response?.data || enrichError.message);

    // Fall back to placeholders so the frontend still
    // has fields to render, just marked unavailable.
    patent.title = patent.title || "Details unavailable";
    patent.inventor = patent.inventor || "Not available";
    patent.applicant = patent.applicant || "Not available";
    patent.publicationDate = patent.publicationDate || "Unknown";
    patent.summary = patent.summary || "Details unavailable for this patent.";
  }
}

// ============================================
// HEALTH CHECK (used by Docker / uptime monitoring)
// ============================================

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================
// SEARCH QUERY (form fields -> EPO CQL)
// ============================================

class InvalidInputError extends Error {}

// Free-text values end up inside a quoted CQL phrase; quotes or
// backslashes would let the value break out of it.
function readText(value, label, maxLength = 200) {

  if (value === undefined || value === null || value === "") return "";

  if (typeof value !== "string" || value.length > maxLength || /["\\]/.test(value)) {
    throw new InvalidInputError(`Invalid ${label}`);
  }

  return cleanWhitespace(value);
}

// "H04L 9/32" -> "H04L9/32"; a subclass on its own ("A61K") is fine too.
function readCpc(value) {

  const text = readText(value, "CPC class", 40).replace(/\s+/g, "").toUpperCase();

  if (text && !/^[A-HY]\d{2}[A-Z](\d{1,4}\/\d{1,6})?$/.test(text)) {
    throw new InvalidInputError("Invalid CPC class");
  }

  return text;
}

// "EP 1 000 001 A1" -> "EP1000001". Kind codes are dropped so every
// publication stage of the number is found.
function readPublicationNumber(value) {

  const text = readText(value, "publication number", 40)
    .replace(/[\s.,/-]/g, "")
    .toUpperCase();

  if (!text) return "";

  const match = /^([A-Z]{2}\d{1,13})([A-Z]\d?)?$/.exec(text);

  if (!match) {
    throw new InvalidInputError("Invalid publication number");
  }

  return match[1];
}

// "2024", "2024-05-01" or "20240501" -> "2024" / "20240501".
function readDate(value, label) {

  const text = readText(value, label, 10).replace(/-/g, "");

  if (text && !/^(\d{4}|\d{8})$/.test(text)) {
    throw new InvalidInputError(`Invalid ${label}`);
  }

  return text;
}

function buildSearchQuery(input) {

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidInputError("Search fields required");
  }

  const keywords = readText(input.keywords, "keywords");
  const applicant = readText(input.applicant, "applicant");
  const inventor = readText(input.inventor, "inventor");
  const cpc = readCpc(input.cpc);
  const publicationNumber = readPublicationNumber(input.publicationNumber);
  const dateFrom = readDate(input.dateFrom, "start date");
  const dateTo = readDate(input.dateTo, "end date");

  const parts = [];

  if (publicationNumber) parts.push(`pn=${publicationNumber}`);
  // "ta" = title or abstract; "all" = every word must appear.
  if (keywords) parts.push(`ta all "${keywords}"`);
  if (applicant) parts.push(`pa="${applicant}"`);
  if (inventor) parts.push(`in="${inventor}"`);
  if (cpc) parts.push(`cpc="${cpc}"`);

  if (dateFrom || dateTo) {
    const to = dateTo || String(new Date().getUTCFullYear());
    parts.push(`pd within "${dateFrom || "1900"} ${to}"`);
  }

  if (parts.length === 0 || (parts.length === 1 && /^pd /.test(parts[0]))) {
    throw new InvalidInputError("Enter at least one search term besides the date");
  }

  return parts.join(" and ");
}

// Runs a CQL search and returns the matching publication numbers.
async function searchPublications(token, cql) {

  let searchResponse;

  try {

    searchResponse = await epoGet(
      token,
      `/rest-services/published-data/search?q=${encodeURIComponent(cql)}`
    );

  } catch (error) {

    // OPS answers "no results" with a 404.
    if (error.response?.status === 404) return [];

    throw error;
  }

  const parsedSearch = await xml2js.parseStringPromise(searchResponse.data);

  const publications =
    parsedSearch["ops:world-patent-data"]
      ?.["ops:biblio-search"]?.[0]
      ?.["ops:search-result"]?.[0]
      ?.["ops:publication-reference"] || [];

  return publications.map((pub, index) => {

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
}

// ============================================
// SEARCH PATENTS
// ============================================
// Body: { query: { keywords, applicant, inventor, cpc, publicationNumber,
// dateFrom, dateTo } } or the older { company }. { lite: true } returns
// only publication numbers (no EPO detail calls, no AI) — used by the
// watchlist to look for new publications cheaply.

app.post("/search", requireAuth, apiLimiter, async (req, res) => {

  const body = req.body || {};

  let cql;

  try {

    let fields = body.query;

    if (fields === undefined) {

      if (typeof body.company !== "string" || !body.company.trim()) {
        throw new InvalidInputError("Company name required");
      }

      fields = { applicant: body.company };
    }

    cql = buildSearchQuery(fields);

  } catch (error) {

    if (error instanceof InvalidInputError) {
      return res.status(400).json({ error: error.message });
    }

    throw error;
  }

  const lite = body.lite === true;

  try {

    const cacheKey = `${lite ? "lite" : "full"}:${cql.toLowerCase()}`;

    const cached = getCachedSearch(cacheKey);

    if (cached) {
      return res.json({
        success: true,
        query: cql,
        total: cached.length,
        patents: cached
      });
    }

    console.log(`🔎 Searching: ${cql}`);

    const token = await getAccessToken();

    const patents = await searchPublications(token, cql);

    console.log(`📄 Found ${patents.length} publications`);

    if (!lite) {

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
        patent.applicant = "Not loaded";
        patent.publicationDate = "Not loaded";
        patent.summary = "Not loaded — showing top results only.";
      }
    }

    setCachedSearch(cacheKey, patents);

    res.json({
      success: true,
      query: cql,
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

// Earlier turns of the conversation, oldest first. Only user/assistant
// roles are accepted, so a client can't inject its own system prompt.
function readChatHistory(history) {

  if (history === undefined) return [];

  if (!Array.isArray(history) || history.length > MAX_CHAT_HISTORY_MESSAGES) {
    throw new InvalidInputError("Invalid history");
  }

  let total = 0;

  return history.map(entry => {

    const role = entry?.role;
    const content = entry?.content;

    if (
      (role !== "user" && role !== "assistant") ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > MAX_CHAT_MESSAGE_LENGTH
    ) {
      throw new InvalidInputError("Invalid history");
    }

    total += content.length;

    if (total > MAX_CHAT_HISTORY_CHARS) {
      throw new InvalidInputError("Conversation is too long");
    }

    return { role, content };
  });
}

app.post("/chat", requireAuth, apiLimiter, async (req, res) => {

  const { message, history } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message required" });
  }

  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "Message is too long" });
  }

  let earlier;

  try {
    earlier = readChatHistory(history);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const result = await callOpenRouter([
    { role: "system", content: CHAT_SYSTEM_PROMPT },
    ...earlier,
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

// ============================================
// AI ACTIONS ON SELECTED TEXT (editor)
// ============================================

const ASSIST_SYSTEM_PROMPT =
  "You are an experienced patent attorney helping to draft a patent application. " +
  "Answer in plain text only: no markdown, no headings, no bold, no preamble " +
  "and no closing remarks. Keep claim numbering in the form '1.' at the start of a line. " +
  "Never invent reference signs that are not in the text.";

const ASSIST_ACTIONS = {
  broaden:
    "Rewrite this patent claim so that it is broader: remove limitations that are not " +
    "essential to the inventive concept and generalise specific terms, while keeping it " +
    "clear and supported. Return only the rewritten claim.",
  narrow:
    "Rewrite this patent claim so that it is narrower by adding one or two meaningful " +
    "technical limitations that would help distinguish it from prior art. Return only " +
    "the rewritten claim.",
  dependent:
    "Write three to five dependent claims for the following claim, each adding a useful " +
    "fallback feature. Return only the dependent claims, one per paragraph.",
  clarity:
    "Improve the clarity of this patent text: fix antecedent basis ('a'/'an' before " +
    "'the'/'said'), remove ambiguous or relative terms, and keep the meaning unchanged. " +
    "Return only the improved text.",
  ep:
    "Rewrite this claim in the European two-part form: a preamble with the features known " +
    "from the closest prior art, followed by 'characterised in that' and the " +
    "distinguishing features. Return only the rewritten claim.",
  us:
    "Rewrite this claim in United States style: a single sentence using 'comprising', " +
    "no reference signs, no 'characterised in that', and clear antecedent basis. " +
    "Return only the rewritten claim.",
  explain:
    "Explain in plain language what the following patent text covers, what it would " +
    "not cover, and any weaknesses you notice. Keep it short.",
  custom:
    "Apply the additional instructions to the following patent text. Return only the result."
};

app.post("/assist", requireAuth, apiLimiter, async (req, res) => {

  const { action, text, instruction } = req.body || {};

  if (typeof action !== "string" || !Object.hasOwn(ASSIST_ACTIONS, action)) {
    return res.status(400).json({ error: "Unknown action" });
  }

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Select some text first" });
  }

  if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(400).json({ error: "Selected text is too long" });
  }

  if (
    instruction !== undefined &&
    (typeof instruction !== "string" || instruction.length > MAX_ASSIST_INSTRUCTION_LENGTH)
  ) {
    return res.status(400).json({ error: "Invalid instruction" });
  }

  const extra = typeof instruction === "string" ? instruction.trim() : "";

  if (action === "custom" && !extra) {
    return res.status(400).json({ error: "Describe what the AI should do" });
  }

  const prompt =
    ASSIST_ACTIONS[action] +
    (extra ? `\n\nAdditional instructions: ${extra}` : "") +
    `\n\nText:\n${text}`;

  const result = await callOpenRouter([
    { role: "system", content: ASSIST_SYSTEM_PROMPT },
    { role: "user", content: prompt }
  ]);

  if (!result) {
    return res.status(502).json({ success: false, message: "All AI models failed." });
  }

  res.json({ success: true, model: result.model, message: result.message });
});

// ============================================
// PRIOR-ART COMPARISON (claim vs. closest search results)
// ============================================

// Asks the AI for search terms when the user gave none. The answer is
// untrusted, so only plain words survive into the CQL query.
async function suggestSearchTerms(claim) {

  const result = await callOpenRouter([
    {
      role: "system",
      content:
        "You pick patent search terms. Reply with 3 to 5 short English search terms " +
        "separated by commas and nothing else."
    },
    { role: "user", content: `Claim:\n${claim}` }
  ]);

  if (!result) return [];

  return result.message
    .split(/[,\n]/)
    .map(term => term.replace(/^[\s\-*\d.]+/, "").trim().toLowerCase())
    .filter(term => /^[\p{L}\p{N}][\p{L}\p{N} -]{1,39}$/u.test(term))
    .slice(0, 5);
}

const COMPARE_SYSTEM_PROMPT =
  "You are a patent examiner. Compare a claim with prior-art references using only the " +
  "information given. Format the answer in markdown.";

function buildComparePrompt(claim, references) {

  const list = references.map((ref, i) =>
    `D${i + 1}: ${ref.patentNumber} — ${ref.title}\n` +
    `Applicant: ${ref.applicant}\n` +
    `Abstract: ${ref.abstract || "(no abstract available)"}`
  ).join("\n\n");

  return (
    "1. Split the claim into its features, labelled F1, F2, ...\n" +
    "2. Give a markdown table with one row per feature and one column per reference " +
    "(D1, D2, ...). Mark each cell ✓ (disclosed), ~ (partly or implicitly) or ✗ (not found).\n" +
    "3. Name the closest prior art and briefly discuss novelty and inventive step.\n" +
    "4. Suggest features from the claim or likely fallback positions that could " +
    "distinguish the invention.\n" +
    "Only abstracts are available, so say where a full-text check is needed.\n\n" +
    `Claim:\n${claim}\n\nReferences:\n${list}`
  );
}

app.post("/compare", requireAuth, apiLimiter, async (req, res) => {

  const { claim } = req.body || {};

  if (typeof claim !== "string" || claim.trim().length < 20) {
    return res.status(400).json({ error: "Paste the claim to compare" });
  }

  if (claim.length > MAX_CLAIM_LENGTH) {
    return res.status(400).json({ error: "Claim is too long" });
  }

  let keywords;
  let cpc;

  try {
    keywords = readText(req.body.keywords, "keywords");
    cpc = readCpc(req.body.cpc);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {

    let terms = keywords
      ? keywords.split(/\s*,\s*|\s+/).filter(Boolean)
      : await suggestSearchTerms(claim);

    if (terms.length === 0) {
      return res.status(502).json({
        error: "Could not work out search terms. Please enter some keywords."
      });
    }

    const words = [...new Set(terms.join(" ").split(/\s+/))].slice(0, 10);
    const cpcFilter = cpc ? ` and cpc="${cpc}"` : "";

    const token = await getAccessToken();

    // Documents with all key words first; widen to any of them if that
    // finds nothing.
    let cql = `ta all "${words.slice(0, 4).join(" ")}"${cpcFilter}`;
    let found = await searchPublications(token, cql);

    if (found.length === 0) {
      cql = `ta any "${words.join(" ")}"${cpcFilter}`;
      found = await searchPublications(token, cql);
    }

    const references = found.slice(0, COMPARE_COUNT);

    if (references.length === 0) {
      return res.json({
        success: true,
        query: cql,
        keywords: words,
        references: [],
        analysis: "No references were found for these search terms. Try other keywords."
      });
    }

    await mapWithConcurrency(references, ENRICH_CONCURRENCY, async ref => {
      try {
        Object.assign(ref, await fetchBiblio(token, ref.patentNumber));
      } catch (error) {
        console.error(`⚠️ Biblio failed for ${ref.patentNumber}`);
        console.error(error.response?.data || error.message);
        ref.title = ref.patentNumber;
        ref.applicant = "Not available";
        ref.abstract = "";
      }
    });

    const result = await callOpenRouter([
      { role: "system", content: COMPARE_SYSTEM_PROMPT },
      { role: "user", content: buildComparePrompt(claim, references) }
    ]);

    res.json({
      success: true,
      query: cql,
      keywords: words,
      model: result?.model,
      references,
      analysis: result ? result.message : "Analysis unavailable — all AI models failed."
    });

  } catch (error) {

    console.error("❌ Comparison failed");
    console.error(error.response?.data || error.message);

    res.status(500).json({ error: "Prior-art comparison failed" });
  }
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
    console.log(`🌍 Listening on port ${PORT}`);
    console.log("=================================");
    console.log("");
  });
}

module.exports = { app, buildEspacenetLink, buildSearchQuery, flattenXmlText, mapWithConcurrency };
