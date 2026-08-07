// An OAuth 2.1 front door for the phone's Android Remote Control MCP server.
//
//     node scripts/mcp-oauth-proxy.mjs          # listens on 127.0.0.1:8791
//
// Then add it in the desktop app's "custom connector" form with JUST the URL:
//     https://127.0.0.1:8791/mcp
// Leave the OAuth client id/secret blank -- this server supports Dynamic Client Registration,
// so Claude registers itself and no credential ever has to be typed in.
//
// HTTPS IS REQUIRED BY THE FORM (it rejects http:// outright), so this serves TLS from a
// self-signed cert in .certs/ with SANs for localhost / 127.0.0.1 / ::1. Trust it once:
//     Import-Certificate -FilePath .certs\proxy-cert.pem -CertStoreLocation Cert:\CurrentUser\Root
// CurrentUser needs no admin rights, and the key never leaves this machine.
//
// WHY THIS EXISTS
// ---------------
// The connector form can only do OAuth. It cannot send `Authorization: Bearer <token>`, which is
// what the phone's MCP server requires (known limitation: anthropics/claude-ai-mcp #10, #112,
// #411). So this shim speaks OAuth to Claude and Bearer to the phone, and translates between them.
//
// It also fixes three things that have each cost real time:
//   * SESSION-START BINDING. Claude Code binds MCP servers ONCE at startup. Twice the phone was
//     dozing at that instant and the android_* tools were dead for the entire session. This proxy
//     is always listening, so the bind always succeeds; a phone outage becomes a failed CALL, and
//     recovery needs no restart.
//   * TOKEN ROTATION. The phone regenerates its bearer token every time its server restarts,
//     which invalidates anything that hard-codes it. The upstream token is re-read from
//     ~/.claude.json on every request, so fixing the config is enough -- no proxy restart.
//   * SCHEME/ADDRESS DRIFT. HTTPS on/off and LAN-IP changes are absorbed by upstream probing.
//
// WHAT IT IMPLEMENTS (the five endpoints an MCP client expects, plus the resource itself)
//   GET  /.well-known/oauth-protected-resource   RFC 9728 -- which AS protects this resource
//   GET  /.well-known/oauth-authorization-server RFC 8414 -- endpoint discovery
//   POST /register                               RFC 7591 -- dynamic client registration
//   GET  /authorize                              auth code + PKCE (auto-approves, see below)
//   POST /token                                  code -> access token, and refresh
//   *    /mcp                                    the protected resource; forwards upstream
//
// AUTO-APPROVAL IS DELIBERATE. A consent screen exists to stop a THIRD PARTY getting access on
// the user's behalf. Here the client, the authorization server and the resource owner are all the
// same person on one machine, reachable only via 127.0.0.1 -- a consent click would be theatre.
// Every issued token is random, in-memory, and dies with the process.
//
// SECURITY. Binds 127.0.0.1 ONLY. The phone's bearer token never leaves this machine and is never
// handed to the OAuth client. Upstream TLS verification is off because the app serves a
// self-signed cert for `android-mcp.local`, which cannot match the loopback address we reach it
// on; the hop is a USB cable. Do not reuse that choice off-box.

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const PORT = Number(process.env.FFS_OAUTH_PROXY_PORT || 8791);
const HOST = "127.0.0.1";

// TLS IS MANDATORY, not optional: the desktop app's custom-connector form rejects http:// URLs
// outright. The cert is self-signed with SANs for localhost/127.0.0.1/::1 (see scripts/README or
// the generation command in git history). Because it is self-signed, it must be trusted once --
// import .certs/proxy-cert.pem into the CurrentUser "Trusted Root Certification Authorities"
// store, which needs no admin rights.
const CERT_DIR = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", ".certs");
function loadTls() {
  const key = path.join(CERT_DIR, "proxy-key.pem");
  const cert = path.join(CERT_DIR, "proxy-cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.error(`[oauth-proxy] missing TLS material in ${CERT_DIR}`);
    console.error(`[oauth-proxy] generate it with:`);
    console.error(`    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config san.cnf \\`);
    console.error(`      -keyout .certs/proxy-key.pem -out .certs/proxy-cert.pem`);
    process.exit(1);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
const ISSUER = `https://${HOST}:${PORT}`;

// --- upstream (the phone) -------------------------------------------------------------------

/**
 * Re-read every time: the phone rotates its bearer token on every server restart, so caching it
 * is precisely the bug that made this whole exercise necessary.
 */
function upstreamConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
  const srv = cfg?.mcpServers?.["android-device"];
  if (!srv?.url) throw new Error("no mcpServers['android-device'].url in ~/.claude.json");
  const token = Object.values(srv.headers || {})[0];
  if (!token) throw new Error("no auth header on the android-device server config");
  return { url: srv.url, token };
}

function candidates(configuredUrl) {
  const u = new URL(configuredUrl);
  const p = u.pathname || "/mcp";
  const out = [];
  // 18080 is the port adb-keepalive.ps1 re-asserts on every reconnect: the durable USB route.
  for (const port of [18080, u.port || 8080]) {
    for (const scheme of ["https", "http"]) out.push(`${scheme}://127.0.0.1:${port}${p}`);
  }
  out.push(u.toString());
  return out;
}

let lastGoodUpstream = null;

/**
 * Upstream transport is curl.exe, not node:https.
 *
 * Node cannot complete the handshake against this server when the app's HTTPS toggle is on: it
 * fails with ECONNRESET at TLS 1.2 and 1.3, with and without explicit SNI, with
 * rejectUnauthorized:false and a relaxed cipher floor. curl to the identical URL returns 401
 * instantly -- on Windows it goes through SChannel and sends a materially different ClientHello.
 * Use the client that demonstrably works instead of guessing at TLS knobs.
 */
function curlPost(target, headers, body) {
  return new Promise((resolve, reject) => {
    const stem = path.join(os.tmpdir(), `ffs-oauth-${process.pid}-${crypto.randomUUID()}`);
    const bodyFile = `${stem}.body`;
    const hdrFile = `${stem}.hdr`;
    try {
      fs.writeFileSync(bodyFile, body ?? Buffer.alloc(0));
    } catch (e) {
      return reject(e);
    }
    const args = ["-sk", "--max-time", "65", "-X", "POST", target, "-D", hdrFile,
                  "--data-binary", `@${bodyFile}`];
    for (const [k, v] of Object.entries(headers)) if (v != null) args.push("-H", `${k}: ${v}`);

    execFile("curl.exe", args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      let raw = "";
      try { raw = fs.readFileSync(hdrFile, "utf8"); } catch {}
      fs.rmSync(bodyFile, { force: true });
      fs.rmSync(hdrFile, { force: true });
      if (err) return reject(new Error(`curl: ${String(err.message).split("\n")[0]}`));
      const blocks = raw.split(/\r?\n\r?\n/).filter((b) => b.trim());
      const lines = (blocks[blocks.length - 1] || "").split(/\r?\n/);
      const status = Number((lines[0] || "").match(/\s(\d{3})/)?.[1] || 0);
      if (!status) return reject(new Error("no HTTP status from upstream"));
      const h = {};
      for (const line of lines.slice(1)) {
        const i = line.indexOf(":");
        if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      resolve({ status, headers: h, body: stdout });
    });
  });
}

async function forwardToPhone(body, extraHeaders) {
  const { url, token } = upstreamConfig();
  const order = lastGoodUpstream
    ? [lastGoodUpstream, ...candidates(url).filter((c) => c !== lastGoodUpstream)]
    : candidates(url);
  const headers = {
    ...extraHeaders,
    Authorization: token,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  let lastErr;
  for (const target of order) {
    try {
      const res = await curlPost(target, headers, body);
      // A 401 means we reached a live server but our stored token is stale -- report it as such
      // rather than silently trying the next candidate and blaming the network.
      if (res.status === 401) {
        lastGoodUpstream = target;
        const e = new Error(
          "phone rejected the stored bearer token (it rotates on every server restart) -- " +
          "update mcpServers['android-device'].headers in ~/.claude.json; no proxy restart needed"
        );
        e.upstreamUnauthorized = true;
        throw e;
      }
      if (lastGoodUpstream !== target) {
        console.log(`[oauth-proxy] upstream -> ${target}`);
        lastGoodUpstream = target;
      }
      return res;
    } catch (e) {
      if (e.upstreamUnauthorized) throw e;
      lastErr = e;
      if (lastGoodUpstream === target) lastGoodUpstream = null;
    }
  }
  throw lastErr ?? new Error("no upstream reachable");
}

// --- OAuth state (in memory; dies with the process, which is correct for a local shim) -------

const clients = new Map(); // client_id -> {client_secret, redirect_uris}
const codes = new Map();   // code -> {client_id, redirect_uri, challenge, method, expires}
const tokens = new Map();  // access_token -> {client_id, expires}
const refresh = new Map(); // refresh_token -> client_id

const rand = (n = 32) => crypto.randomBytes(n).toString("base64url");
const TOKEN_TTL = 3600;

function verifyPkce(verifier, challenge, method) {
  if (!challenge) return true; // no challenge was issued
  if (method === "S256" || !method) {
    const h = crypto.createHash("sha256").update(verifier ?? "").digest("base64url");
    return h === challenge;
  }
  return verifier === challenge; // "plain"
}

// --- helpers ---------------------------------------------------------------------------------

const json = (res, status, obj, extra = {}) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": b.length, ...extra });
  res.end(b);
};

const readBody = (req) =>
  new Promise((resolve) => {
    const c = [];
    req.on("data", (x) => c.push(x));
    req.on("end", () => resolve(Buffer.concat(c)));
  });

function parseForm(buf, contentType = "") {
  const s = buf.toString("utf8");
  if (contentType.includes("application/json")) {
    try { return JSON.parse(s || "{}"); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(s));
}

// --- server ---------------------------------------------------------------------------------

const server = https.createServer(loadTls(), async (req, res) => {
  const url = new URL(req.url, ISSUER);
  const p = url.pathname;

  // RFC 9728 -- tells the client which authorization server protects /mcp.
  // Both the bare path and the resource-suffixed form are served, because clients differ.
  if (req.method === "GET" && p.startsWith("/.well-known/oauth-protected-resource")) {
    return json(res, 200, {
      resource: `${ISSUER}/mcp`,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  }

  // RFC 8414 -- endpoint discovery. Advertising `registration_endpoint` is what lets Claude
  // register itself, so the user never types a client id or secret.
  if (req.method === "GET" && p.startsWith("/.well-known/oauth-authorization-server")) {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: ["mcp"],
    });
  }

  // Some clients probe the OIDC path instead. Same document.
  if (req.method === "GET" && p.startsWith("/.well-known/openid-configuration")) {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      registration_endpoint: `${ISSUER}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
    });
  }

  // RFC 7591 dynamic client registration.
  if (req.method === "POST" && p === "/register") {
    const body = parseForm(await readBody(req), req.headers["content-type"] || "");
    const client_id = `ffs-${rand(9)}`;
    const client_secret = rand(24);
    const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    clients.set(client_id, { client_secret, redirect_uris });
    console.log(`[oauth-proxy] registered client ${client_id} redirects=${JSON.stringify(redirect_uris)}`);
    return json(res, 201, {
      client_id,
      client_secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0, // never
      redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  }

  // Authorization endpoint. Auto-approves (see the header note) and redirects straight back.
  if (req.method === "GET" && p === "/authorize") {
    const q = url.searchParams;
    const client_id = q.get("client_id") || "";
    const redirect_uri = q.get("redirect_uri") || "";
    const state = q.get("state") || "";
    if (!redirect_uri) return json(res, 400, { error: "invalid_request", error_description: "redirect_uri required" });

    // Accept unknown client_ids: some clients use a pre-agreed id rather than registering.
    if (!clients.has(client_id)) clients.set(client_id, { client_secret: null, redirect_uris: [redirect_uri] });

    const code = rand(24);
    codes.set(code, {
      client_id,
      redirect_uri,
      challenge: q.get("code_challenge"),
      method: q.get("code_challenge_method") || "plain",
      expires: Date.now() + 5 * 60_000,
    });
    const to = new URL(redirect_uri);
    to.searchParams.set("code", code);
    if (state) to.searchParams.set("state", state);
    console.log(`[oauth-proxy] authorize -> auto-approved for ${client_id}`);
    res.writeHead(302, { location: to.toString() });
    return res.end();
  }

  if (req.method === "POST" && p === "/token") {
    const body = parseForm(await readBody(req), req.headers["content-type"] || "");
    const grant = body.grant_type;

    if (grant === "refresh_token") {
      const cid = refresh.get(body.refresh_token);
      if (!cid) return json(res, 400, { error: "invalid_grant" });
      const access_token = rand();
      tokens.set(access_token, { client_id: cid, expires: Date.now() + TOKEN_TTL * 1000 });
      return json(res, 200, { access_token, token_type: "Bearer", expires_in: TOKEN_TTL, scope: "mcp" });
    }

    if (grant !== "authorization_code") {
      return json(res, 400, { error: "unsupported_grant_type", error_description: String(grant) });
    }
    const entry = codes.get(body.code);
    if (!entry || entry.expires < Date.now()) return json(res, 400, { error: "invalid_grant" });
    codes.delete(body.code); // single use
    if (!verifyPkce(body.code_verifier, entry.challenge, entry.method)) {
      return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    }

    const access_token = rand();
    const refresh_token = rand();
    tokens.set(access_token, { client_id: entry.client_id, expires: Date.now() + TOKEN_TTL * 1000 });
    refresh.set(refresh_token, entry.client_id);
    console.log(`[oauth-proxy] issued access token to ${entry.client_id}`);
    return json(res, 200, {
      access_token,
      token_type: "Bearer",
      expires_in: TOKEN_TTL,
      refresh_token,
      scope: "mcp",
    });
  }

  // --- the protected resource ---------------------------------------------------------------
  if (p === "/mcp" || p === "/") {
    const auth = req.headers.authorization || "";
    const presented = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const rec = presented ? tokens.get(presented) : null;

    // MUST be 401 (not 200) with WWW-Authenticate pointing at the PRM, or the client never
    // discovers that it needs to authenticate at all.
    if (!rec || rec.expires < Date.now()) {
      if (rec) tokens.delete(presented);
      return json(
        res, 401,
        { error: "unauthorized", error_description: "missing or expired access token" },
        { "www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"` }
      );
    }

    const body = await readBody(req);
    try {
      const up = await forwardToPhone(body, { "mcp-session-id": req.headers["mcp-session-id"] });
      const out = { ...up.headers };
      delete out["transfer-encoding"];
      delete out["content-length"];
      res.writeHead(up.status, out);
      return res.end(up.body);
    } catch (e) {
      console.error(`[oauth-proxy] upstream: ${e.message}`);
      // JSON-RPC-shaped so the client surfaces something actionable. The proxy STAYS UP.
      return json(res, 503, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: `phone MCP unreachable: ${e.message}` },
      });
    }
  }

  json(res, 404, { error: "not_found", path: p });
});

server.listen(PORT, HOST, () => {
  console.log(`[oauth-proxy] listening on ${ISSUER}`);
  console.log(`[oauth-proxy] add this URL as a custom connector (leave id/secret BLANK):`);
  console.log(`    ${ISSUER}/mcp`);
  try {
    const { url } = upstreamConfig();
    console.log(`[oauth-proxy] upstream (from ~/.claude.json): ${url}`);
  } catch (e) {
    console.log(`[oauth-proxy] ⚠ upstream config problem: ${e.message}`);
  }
});
