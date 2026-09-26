// /patenter/backend/server.js

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const xml2js = require("xml2js");
const qs = require("querystring");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = 3000;

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

// Same fallback list as the chat page, reused here for summarization
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

async function summarizeText(sourceText, title) {

  if (!sourceText) {
    return "No description text was available to summarize.";
  }

  const prompt =
    `Summarize the following patent description in plain English, ` +
    `maximum 10 lines, no markdown headings, no preamble:\n\n` +
    `Title: ${title}\n\n${sourceText}`;

  for (const model of SUMMARY_MODELS) {

    try {

      const response = await axios.post(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          model,
          messages: [
            {
              role: "system",
              content: "You summarize patents clearly and concisely, max 10 lines, plain text only."
            },
            {
              role: "user",
              content: prompt
            }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "http://localhost",
            "X-Title": "Patenter AI",
            "Content-Type": "application/json"
          }
        }
      );

      const message =
        response.data?.choices?.[0]?.message?.content;

      if (message) {
        return message.trim();
      }

    } catch (error) {

      console.log(`⚠️ Summary model failed: ${model}`);
      console.error(error.response?.data || error.message);
    }
  }

  return "Summary unavailable — all AI models failed.";
}

// ============================================
// ESPACENET LINK (no API call needed)
// ============================================

function buildEspacenetLink(patentNumber) {
  return `https://worldwide.espacenet.com/patent/search/family/000000000/publication/${encodeURIComponent(patentNumber)}`;
}

// ============================================
// SEARCH PATENTS
// ============================================

app.post("/search", async (req, res) => {

  try {

    const { company } = req.body;

    if (!company) {
      return res.status(400).json({
        error: "Company name required"
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