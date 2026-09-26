// /patenter/backend/server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const xml2js = require("xml2js");
const qs = require("querystring");
const jwt = require("jsonwebtoken");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const app = express();

// Only the Patenter frontend may call this API from a browser.
// Comma-separated list, e.g. "http://127.0.0.1:5500,https://patenter.example"
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "http://127.0.0.1:5500,http://localhost:5500"
)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: "20kb" }));

// The auth service runs on 3000, so this one defaults to 3001.
const PORT = Number(process.env.PORT) || 3001;

const CACHE_DIR = path.join(__dirname, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "patents.xml");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR);
}

if (!fs.existsSync(CACHE_FILE)) {
  fs.writeFileSync(CACHE_FILE, `<patents></patents>`);
}

// ============================================
// EPO OPS API Credentials
// ============================================

const CONSUMER_KEY = process.env.CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET;

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.log("❌ Missing EPO API credentials in .env");
  process.exit(1);
}

// ============================================
// OpenRouter (AI summarization) credentials
// ============================================
// NOTE: moved server-side on purpose — never put this key
// in frontend JS, it's visible to anyone who views source.

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.log("❌ Missing OPENROUTER_API_KEY in .env");
  process.exit(1);
}

// ============================================
// Authentication (access tokens issued by /auth)
// ============================================
// Every endpoint here spends paid EPO / OpenRouter quota, so only
// signed-in users may call them. The secret must match the auth service.

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;

if (!JWT_ACCESS_SECRET) {
  console.log("❌ Missing JWT_ACCESS_SECRET in .env");
  process.exit(1);
}

function requireAuth(req, res, next) {

  const authHeader = req.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Sign in required" });
  }

  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_ACCESS_SECRET, {
      algorithms: ["HS256"]
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

// Fallback list used for both chat and summarization
const SUMMARY_MODELS = [
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

// ============================================
// GET ACCESS TOKEN
// ============================================

async function getAccessToken() {

  try {

    const response = await axios.post(
      "https://ops.epo.org/3.2/auth/accesstoken",

      qs.stringify({
        grant_type: "client_credentials"
      }),

      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        auth: {
          username: CONSUMER_KEY,
          password: CONSUMER_SECRET
        }
      }
    );

    return response.data.access_token;

  } catch (error) {

    console.error(
      "❌ Failed to get access token:"
    );

    console.error(
      error.response?.data || error.message
    );

    throw error;
  }
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

  const url =
    `https://ops.epo.org/3.2/rest-services/published-data/publication/epodoc/${encodeURIComponent(patentNumber)}/biblio`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml"
    }
  });

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

  const url =
    `https://ops.epo.org/3.2/rest-services/published-data/publication/epodoc/${encodeURIComponent(patentNumber)}/description`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml"
    }
  });

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
// AI SUMMARIZATION (server-side, OpenRouter)
// ============================================

// Tries each model in turn; returns { model, message } or null.
async function callOpenRouter(messages) {

  for (const model of SUMMARY_MODELS) {

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

const MAX_CHAT_MESSAGE_LENGTH = 8000;

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

// ============================================
// ESPACENET LINK (no API call needed)
// ============================================

function buildEspacenetLink(patentNumber) {
  return `https://worldwide.espacenet.com/patent/search/family/000000000/publication/${encodeURIComponent(patentNumber)}`;
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

    console.log(`🔎 Searching for ${company}`);

    // ============================================
    // ACCESS TOKEN
    // ============================================

    const token = await getAccessToken();

    // ============================================
    // SEARCH QUERY
    // ============================================

    const query = `pa="${company}"`;

    const searchUrl =
      `https://ops.epo.org/3.2/rest-services/published-data/search?q=${encodeURIComponent(query)}`;

    // ============================================
    // SEARCH REQUEST
    // ============================================

    const searchResponse = await axios.get(
      searchUrl,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/xml"
        }
      }
    );

    const parsedSearch =
      await xml2js.parseStringPromise(
        searchResponse.data
      );

    const publications =
      parsedSearch["ops:world-patent-data"]
        ?.["ops:biblio-search"]?.[0]
        ?.["ops:search-result"]?.[0]
        ?.["ops:publication-reference"] || [];

    console.log(
      `📄 Found ${publications.length} publications`
    );

    const patents = [];

    // ============================================
    // PROCESS PUBLICATIONS
    // ============================================

    for (const [index, pub] of publications.entries()) {

      try {

        const documentId =
          pub["document-id"]?.[0];

        const country =
          documentId?.country?.[0] || "";

        const docNumber =
          documentId?.["doc-number"]?.[0] || "";

        const kind =
          documentId?.kind?.[0] || "";

        const patentNumber =
          `${country}${docNumber}${kind}`;

        patents.push({
          index: index + 1,
          patentNumber
        });

        console.log(
          `✅ Processed patent ${patentNumber}`
        );

      } catch (error) {

        console.error(
          `❌ Failed processing publication ${index + 1}`
        );

        console.error(error.message);
      }
    }

    // ============================================
    // ENRICH TOP N PATENTS
    // (biblio data + AI summary + Espacenet link)
    // ============================================

    const toEnrich = patents.slice(0, ENRICH_COUNT);

    for (const patent of toEnrich) {

      try {

        console.log(
          `🔬 Enriching ${patent.patentNumber}...`
        );

        const biblio = await fetchBiblio(
          token,
          patent.patentNumber
        );

        patent.title = biblio.title;
        patent.inventor = biblio.inventor;
        patent.publicationDate = biblio.publicationDate;
        patent.link = buildEspacenetLink(patent.patentNumber);

        // Description + summary — isolated so a failure here
        // doesn't wipe out the biblio data we already got.
        try {

          const descriptionText = await fetchDescription(
            token,
            patent.patentNumber
          );

          patent.summary = await summarizeText(
            descriptionText,
            biblio.title
          );

        } catch (descError) {

          console.error(
            `⚠️ Description/summary failed for ${patent.patentNumber}`
          );

          console.error(
            descError.response?.data || descError.message
          );

          patent.summary = "Summary unavailable for this patent.";
        }

        console.log(
          `✅ Enriched ${patent.patentNumber}`
        );

      } catch (enrichError) {

        console.error(
          `❌ Enrichment failed for ${patent.patentNumber}`
        );

        console.error(
          enrichError.response?.data || enrichError.message
        );

        // Fall back to placeholders so the frontend still
        // has fields to render, just marked unavailable.
        patent.title = patent.title || "Details unavailable";
        patent.inventor = patent.inventor || "Not available";
        patent.publicationDate = patent.publicationDate || "Unknown";
        patent.link = patent.link || buildEspacenetLink(patent.patentNumber);
        patent.summary = patent.summary || "Details unavailable for this patent.";
      }
    }

    // Patents beyond ENRICH_COUNT still get a link (cheap, no API call)
    // and a placeholder summary so the frontend doesn't break on them.
    for (const patent of patents.slice(ENRICH_COUNT)) {
      patent.title = patent.title || patent.patentNumber;
      patent.inventor = patent.inventor || "Not loaded";
      patent.publicationDate = patent.publicationDate || "Not loaded";
      patent.link = buildEspacenetLink(patent.patentNumber);
      patent.summary = patent.summary || "Not loaded — showing top results only.";
    }

    // ============================================
    // SAVE TO CACHE
    // ============================================

    const xmlBuilder = new xml2js.Builder();

    const xmlData = {
      patents: {
        patent: patents.map(p => ({
          index: p.index,
          patentNumber: p.patentNumber,
          title: p.title,
          inventor: p.inventor,
          publicationDate: p.publicationDate,
          summary: p.summary,
          link: p.link
        }))
      }
    };

    const xml = xmlBuilder.buildObject(xmlData);

    fs.writeFileSync(CACHE_FILE, xml);

    // ============================================
    // RESPONSE
    // ============================================

    res.json({
      success: true,
      company,
      total: patents.length,
      patents
    });

  } catch (error) {

    console.error("❌ Search failed");

    console.error(
      error.response?.data || error.message
    );

    res.status(500).json({
      error: "Patent search failed"
    });
  }
});
// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {

  console.log("");
  console.log("=================================");
  console.log("🚀 Patenter Backend Running");
  console.log(`🌍 http://localhost:${PORT}`);
  console.log("=================================");
  console.log("");
});