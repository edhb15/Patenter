// Tests for the search/chat backend. EPO and OpenRouter are stubbed,
// so no network access or real credentials are needed.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const jwt = require("jsonwebtoken");

const SECRET = "test-access-secret-0123456789abcdef";

Object.assign(process.env, {
  CONSUMER_KEY: "key",
  CONSUMER_SECRET: "secret",
  OPENROUTER_API_KEY: "or-key",
  JWT_ACCESS_SECRET: SECRET,
  ALLOWED_ORIGINS: "http://localhost:5500"
});

// The server logs heavily to stdout; in the test runner's child process
// that output can corrupt the runner's own reporting stream.
console.log = () => {};
console.error = () => {};

// ---- stubs ---------------------------------------------------------------

const calls = { token: 0, search: 0, biblio: 0, description: 0, ai: 0 };

const SEARCH_XML = `
<ops:world-patent-data xmlns:ops="http://ops.epo.org">
  <ops:biblio-search><ops:search-result>
    <ops:publication-reference><document-id><country>EP</country><doc-number>1000001</doc-number><kind>A1</kind></document-id></ops:publication-reference>
    <ops:publication-reference><document-id><country>US</country><doc-number>2000002</doc-number><kind>B2</kind></document-id></ops:publication-reference>
  </ops:search-result></ops:biblio-search>
</ops:world-patent-data>`;

const BIBLIO_XML = `
<ops:world-patent-data xmlns:ops="http://ops.epo.org">
  <exchange-documents><exchange-document><bibliographic-data>
    <publication-reference><document-id><date>20240101</date></document-id></publication-reference>
    <invention-title lang="de">Titel</invention-title>
    <invention-title lang="en">Widget</invention-title>
    <parties><inventors><inventor><inventor-name><name>Ada Lovelace</name></inventor-name></inventor></inventors></parties>
  </bibliographic-data></exchange-document></exchange-documents>
</ops:world-patent-data>`;

const DESCRIPTION_XML = `
<ops:world-patent-data xmlns:ops="http://ops.epo.org" xmlns:ftxt="http://www.epo.org/fulltext">
  <ftxt:fulltext-documents><ftxt:fulltext-document><description><p>A widget.</p></description></ftxt:fulltext-document></ftxt:fulltext-documents>
</ops:world-patent-data>`;

const fakeEpo = {
  async post(url) {
    assert.equal(url, "/auth/accesstoken");
    calls.token++;
    return { data: { access_token: "epo-token", expires_in: "1199" } };
  },
  async get(url, config) {
    assert.equal(config.headers.Authorization, "Bearer epo-token");
    if (url.includes("/search?")) { calls.search++; return { data: SEARCH_XML }; }
    if (url.endsWith("/biblio")) { calls.biblio++; return { data: BIBLIO_XML }; }
    if (url.endsWith("/description")) { calls.description++; return { data: DESCRIPTION_XML }; }
    throw new Error("unexpected url " + url);
  }
};

axios.create = () => fakeEpo;
axios.post = async (url, body) => {
  calls.ai++;
  return { data: { choices: [{ message: { content: `reply from ${body.model}` } }] } };
};

const { app, buildEspacenetLink, flattenXmlText, mapWithConcurrency } = require("../server");

// ---- helpers -------------------------------------------------------------

let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

beforeEach(() => {
  for (const key of Object.keys(calls)) calls[key] = 0;
});

let userCounter = 0;

// Each test uses its own user so the per-user rate limit doesn't carry over.
function token(overrides = {}) {
  return jwt.sign({ sub: `user-${++userCounter}`, email: "a@b.io" }, SECRET, {
    expiresIn: "15m",
    issuer: "patenter-auth",
    audience: "patenter",
    ...overrides
  });
}

async function post(path, body, { auth = token(), headers = {} } = {}) {
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
}

// ---- tests ---------------------------------------------------------------

test("requires a valid access token", async () => {
  assert.equal((await post("/search", { company: "Acme" }, { auth: null })).status, 401);
  assert.equal((await post("/chat", { message: "hi" }, { auth: null })).status, 401);

  const wrongSecret = jwt.sign({ sub: "u" }, "another-secret", { issuer: "patenter-auth", audience: "patenter" });
  assert.equal((await post("/search", { company: "Acme" }, { auth: wrongSecret })).status, 401);

  const wrongAudience = token({ audience: "someone-else" });
  assert.equal((await post("/search", { company: "Acme" }, { auth: wrongAudience })).status, 401);

  const expired = token({ expiresIn: -10 });
  assert.equal((await post("/search", { company: "Acme" }, { auth: expired })).status, 401);
});

test("validates search input", async () => {
  assert.equal((await post("/search", {})).status, 400);
  assert.equal((await post("/search", { company: { $ne: 1 } })).status, 400);
  assert.equal((await post("/search", { company: 'x" or pa="y' })).status, 400);
  assert.equal((await post("/search", { company: "a".repeat(201) })).status, 400);
  assert.equal((await post("/search", "{not json")).status, 400);
  assert.equal(calls.search, 0);
});

test("search enriches results, caches them and reuses the EPO token", async () => {
  const first = await post("/search", { company: "Acme Corp" });

  assert.equal(first.status, 200);
  assert.equal(first.body.total, 2);

  const [top, rest] = first.body.patents;
  assert.equal(top.patentNumber, "EP1000001A1");
  assert.equal(top.title, "Widget");
  assert.equal(top.inventor, "Ada Lovelace");
  assert.equal(top.publicationDate, "20240101");
  assert.match(top.summary, /^reply from /);
  assert.equal(top.link, "https://worldwide.espacenet.com/patent/search?q=pn%3DEP1000001A1");
  assert.equal(rest.patentNumber, "US2000002B2");

  assert.equal(calls.token, 1);
  assert.equal(calls.search, 1);
  assert.equal(calls.biblio, 2);

  // Same company (different case) comes from the cache: no new API calls.
  const second = await post("/search", { company: "acme corp" });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body.patents, first.body.patents);
  assert.equal(calls.search, 1);

  // A different company reuses the cached EPO token.
  await post("/search", { company: "Other Inc" });
  assert.equal(calls.search, 2);
  assert.equal(calls.token, 1);
});

test("chat proxies to OpenRouter and validates input", async () => {
  const ok = await post("/chat", { message: "Draft a claim" });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.success, true);
  assert.match(ok.body.message, /^reply from /);

  assert.equal((await post("/chat", { message: "" })).status, 400);
  assert.equal((await post("/chat", { message: 42 })).status, 400);
  assert.equal((await post("/chat", { message: "x".repeat(8001) })).status, 400);
});

test("rate limits each user", async () => {
  const auth = token();
  let last;
  for (let i = 0; i < 31; i++) {
    last = await post("/chat", { message: "hi" }, { auth });
  }
  assert.equal(last.status, 429);

  // Another user is unaffected.
  assert.equal((await post("/chat", { message: "hi" })).status, 200);
});

test("CORS only allows configured origins", async () => {
  const preflight = origin => fetch(baseUrl + "/search", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST" }
  });

  const allowed = await preflight("http://localhost:5500");
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5500");

  const denied = await preflight("https://evil.example");
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("helpers", async () => {
  assert.equal(flattenXmlText(["a", { _: "b" }, { x: ["c"] }]), "a b c");
  assert.equal(
    buildEspacenetLink("EP1A1"),
    "https://worldwide.espacenet.com/patent/search?q=pn%3DEP1A1"
  );

  let running = 0;
  let peak = 0;
  const seen = [];
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async n => {
    running++;
    peak = Math.max(peak, running);
    await new Promise(resolve => setTimeout(resolve, 5));
    seen.push(n);
    running--;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});
