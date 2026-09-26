// Patenter auth client, shared by every page.
//
// The access token is kept in memory only (never localStorage), so a
// script injected into the page can't read a long-lived copy of it.
// Each page gets a fresh token on load from /auth/refresh, which uses the
// HttpOnly refresh cookie that JavaScript can't see.
//
// The APIs are expected on the same host as the page (ports 3000/3001) so
// the SameSite=Strict refresh cookie is sent. Override for deployment by
// defining window.PATENTER_CONFIG = { authUrl, apiUrl } before this script.
(function () {
  "use strict";

  const config = window.PATENTER_CONFIG || {};
  const host = location.hostname || "localhost";
  const AUTH_URL = config.authUrl || `http://${host}:3000`;
  const API_URL = config.apiUrl || `http://${host}:3001`;

  // Path of the login page relative to the site root.
  const LOGIN_PATH = config.loginPath || "/login.html";

  let accessToken = null;
  let refreshing = null;

  // Seconds until the token expires (negative when expired).
  function secondsLeft(token) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return payload.exp - Date.now() / 1000;
    } catch {
      return -1;
    }
  }

  async function request(url, { method = "GET", body, token, credentials } = {}) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = "Bearer " + token;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: credentials ? "include" : "omit",
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      return { ok: false, networkError: true, status: 0, data: null };
    }

    let data = null;
    try { data = await res.json(); } catch { /* empty or non-JSON body */ }

    return { ok: res.ok, status: res.status, data, networkError: false };
  }

  async function doRefresh() {
    let result = await request(AUTH_URL + "/auth/refresh", { method: "POST", credentials: true });

    // Another tab may have rotated the token a moment ago; by now the
    // browser holds the new cookie, so one retry is enough.
    if (result.status === 401) {
      await new Promise(resolve => setTimeout(resolve, 300));
      result = await request(AUTH_URL + "/auth/refresh", { method: "POST", credentials: true });
    }

    accessToken = result.ok && result.data ? result.data.accessToken : null;
    return accessToken;
  }

  // Returns a valid access token, or null when the user isn't signed in.
  function getAccessToken() {
    if (accessToken && secondsLeft(accessToken) > 30) {
      return Promise.resolve(accessToken);
    }
    if (!refreshing) {
      refreshing = doRefresh().finally(() => { refreshing = null; });
    }
    return refreshing;
  }

  // fetch() for the Patenter APIs: adds the token and retries once after
  // refreshing it if the server says it has expired.
  async function apiFetch(path, options = {}) {
    const url = /^https?:/.test(path) ? path : API_URL + path;

    const send = token => fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), ...(token ? { Authorization: "Bearer " + token } : {}) }
    });

    let res = await send(await getAccessToken());

    if (res.status === 401) {
      accessToken = null;
      const token = await getAccessToken();
      if (token) res = await send(token);
    }

    return res;
  }

  async function login(email, password) {
    const result = await request(AUTH_URL + "/auth/login", {
      method: "POST",
      body: { email, password },
      credentials: true
    });
    if (result.ok && result.data) accessToken = result.data.accessToken;
    return result;
  }

  function register(email, password) {
    return request(AUTH_URL + "/auth/register", { method: "POST", body: { email, password } });
  }

  async function logout() {
    await request(AUTH_URL + "/auth/logout", { method: "POST", credentials: true });
    accessToken = null;
  }

  // Signs the user out on every device.
  async function logoutAll() {
    const token = await getAccessToken();
    const result = await request(AUTH_URL + "/auth/logout-all", { method: "POST", token, credentials: true });
    accessToken = null;
    return result;
  }

  // Only same-site paths are allowed as a post-login destination, so the
  // login page can't be used to bounce users to another website.
  function safeNextPath(next) {
    if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
      return null;
    }
    return next;
  }

  function goToLogin() {
    const next = location.pathname + location.search;
    location.href = LOGIN_PATH + "?next=" + encodeURIComponent(next);
  }

  // Call on pages that need a signed-in user. Resolves with the token, or
  // redirects to the login page.
  async function requireSignIn() {
    const token = await getAccessToken();
    if (!token) goToLogin();
    return token;
  }

  window.PatenterAuth = {
    AUTH_URL,
    API_URL,
    getAccessToken,
    apiFetch,
    login,
    register,
    logout,
    logoutAll,
    requireSignIn,
    goToLogin,
    safeNextPath
  };
})();
