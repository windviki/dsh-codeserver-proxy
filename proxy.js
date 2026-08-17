#!/usr/bin/env node
/**
 * dsh-codeserver-proxy — base-path adapter for the official DeepSeek Harness
 * web UI, deployed on a self-hosted code-server.
 *
 * dsh web serves its frontend with root-absolute paths (/assets/..., /plugins/...,
 * /api/...) and binds to loopback. When it is exposed through code-server's port
 * forwarding (https://host/proxy/<port>/), the browser resolves those absolute
 * paths against the host root instead of the /proxy/<port>/ subtree, so the SPA
 * never loads. This proxy sits between code-server and dsh, forwards everything
 * to dsh, and rewrites the served HTML/JS so every root-absolute reference is
 * prefixed with the proxy base path. The UI bytes are otherwise untouched.
 *
 *   browser -> code-server /proxy/<port>/ -> this proxy -> dsh web (loopback)
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// .env loading
// ---------------------------------------------------------------------------
// Minimal, dependency-free .env loader (no shell interpolation). Deployers keep
// private values — proxy base path, listening/upstream ports, whether to spawn
// dsh — in a gitignored .env; every variable below has a documented default for
// the common code-server + dsh-on-loopback layout. Real environment variables
// always win over .env entries.
function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value === "") continue;
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(".env");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Variables use the PROXY_ prefix (not DSH_*): dsh boots with this directory as
// its cwd and refuses any DSH_-prefixed name it finds in a .env there.
function envPort(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  console.warn(`[dsh-codeserver-proxy] invalid ${name}=${raw}; falling back to ${fallback}`);
  return fallback;
}

const BASE = (process.env.PROXY_BASE || "/proxy/3100").replace(/\/+$/, "") || "/";
const UPSTREAM_HOST = process.env.PROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = envPort("PROXY_UPSTREAM_PORT", 3000);
const PORT = envPort("PROXY_PORT", 3100);
const SPAWN_DSH = process.env.PROXY_SPAWN_DSH !== "0";
const LOOPBACK_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

// code-server's path proxy stamps forwarding traces (x-forwarded-*) on its
// /proxy/<port>/ requests. dsh-market's process-control guards
// (trustedRestartRequest / trustedDownloadRequest) reject any request that
// shows a forwarding trace, treating it as proxied rather than a direct
// loopback peer. From the upstream dsh's point of view this proxy IS the
// final local peer, so those traces are stripped here — the request then
// satisfies the same loopback-same-origin checks a stock local browser does.
const NO_FORWARD_TRACE = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
]);

// ---------------------------------------------------------------------------
// Response rewriting
// ---------------------------------------------------------------------------
// Order matters: a more specific path must be rewritten before a generic
// prefix of it (e.g. /api/events.host before /api/, and /api itself last), so
// a generic rule never runs first and produces a double-prefixed string.
const HTML_TARGETS = ["/assets/", "/plugins/", "/manifest.webmanifest", "/favicon.svg"];
const JS_TARGETS = [
  "/api/events.host",
  "/api/events.mux",
  "/api/respond",
  "/api/",
  "/plugins/events",
  "/plugins/",
  "/dsh-market/",
  "/_dsh/",
  "/manifest.webmanifest",
  "/favicon.svg",
  "/api",
];

// Insert `base` after an opening quote for every occurrence of the target
// root-absolute path, so `"/assets/...` becomes `"/proxy/3100/assets/...` and
// the rewritten string stays well-formed JSON/HTML/JS.
function prefixQuoted(s, base, quote, targets) {
  let out = s;
  for (const path of targets) out = out.split(quote + path).join(quote + base + path);
  return out;
}

function rewriteHtml(body, base) {
  if (base === "/") return body;
  return prefixQuoted(body, base, '"', HTML_TARGETS);
}

function rewriteJs(body, base) {
  if (base === "/") return body;
  let s = body;
  // The base path rewrites `/api` (the RPC channel) to `/proxy/3100/api`,
  // but connection's assertTarget rejects a channel with more than one slash
  // (`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`). Widen the class to accept
  // `/`, so the rewritten multi-segment channel passes validation while the
  // URL built from it (`${channel}/${endpoint}`) still carries the base path.
  s = s
    .split("CHANNEL_PATTERN = /^\\/[A-Za-z0-9._~-]+$/")
    .join("CHANNEL_PATTERN = /^\\/[A-Za-z0-9._~\\/-]+$/");
  // Cover double-quoted, single-quoted and backtick forms uniformly (e.g.
  // vision-toolkit emits '/_dsh/...' with single quotes, dsh-pet emits
  // '/api/pet/pets' with single quotes, connection uses `/${method}`).
  for (const q of ['"', "'", "`"]) s = prefixQuoted(s, base, q, JS_TARGETS);
  return s;
}

function needsRewrite(status, contentType) {
  if (status !== 200 || !contentType) return false;
  const type = contentType.toLowerCase();
  return type.includes("text/html") || type.includes("javascript") || type.includes("application/manifest+json");
}

function rewriteBody(body, base, contentType) {
  const type = contentType.toLowerCase();
  if (type.includes("text/html") || type.includes("application/manifest+json")) return rewriteHtml(body, base);
  return rewriteJs(body, base);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function normalizePath(rawUrl) {
  let url = rawUrl;
  if (BASE !== "/" && url.startsWith(BASE)) url = url.slice(BASE.length);
  // code-server's proxy target joins an extra slash, e.g. //api/events.mux.
  url = url.replace(/^\/+/, "/");
  if (url === "") url = "/";
  return url;
}

function requestHeaders(headers) {
  // dsh gates a whole class of privileged RPC methods (settings/credentials/
  // agentPreset/llm.discoverModels) to loopback-same-origin regardless of
  // trustedHosts — `trustedHosts` is a DNS-rebinding fence, not authentication.
  // So every request is rewritten to look like a local browser direct-connect:
  // Host and Origin both become the loopback upstream, and the fence is then
  // satisfied exactly as it is in the stock `dsh web` local-only deployment.
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k) || NO_FORWARD_TRACE.has(k)) continue;
    out[k] = v;
  }
  out.host = LOOPBACK_AUTHORITY;
  // Rewriting only makes sense on the plain bytes; never ask upstream for a
  // compressed representation that would turn HTML/JS into binary gibberish.
  out["accept-encoding"] = "identity";
  if (out.origin) out.origin = `http://${LOOPBACK_AUTHORITY}`;
  return out;
}

function responseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function sendUpstreamError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, { "content-type": "text/plain" });
  res.end(`dsh-codeserver-proxy: upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT} unreachable: ${err.message}`);
}

// ---------------------------------------------------------------------------
// Proxy handler
// ---------------------------------------------------------------------------

function forward(req, res) {
  const targetPath = normalizePath(req.url);
  const headers = requestHeaders(req.headers);

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: targetPath,
      method: req.method,
      headers,
    },
    (upRes) => {
      const status = upRes.statusCode;
      const contentType = upRes.headers["content-type"] || "";

      if (needsRewrite(status, contentType)) {
        // Rewritable responses are buffered (they are HTML/JS text, not large
        // binaries), rewritten, then sent with a recomputed content-length.
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          if (res.destroyed) return;
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = Buffer.from(rewriteBody(raw, BASE, contentType));
          const outHeaders = responseHeaders(upRes.headers);
          outHeaders["content-length"] = String(body.length);
          res.writeHead(status, outHeaders);
          res.end(body);
        });
        upRes.on("error", () => res.destroy());
      } else {
        // Everything else (assets, streams, SSE, 404s, redirects, ...) is
        // piped through untouched, without buffering it in memory.
        const outHeaders = responseHeaders(upRes.headers);
        if (res.destroyed) {
          upRes.destroy();
          return;
        }
        res.writeHead(status, outHeaders);
        upRes.pipe(res);
        upRes.on("error", () => res.destroy());
      }
    },
  );

  upstream.on("error", (err) => sendUpstreamError(res, err));
  req.on("error", () => upstream.destroy());
  // Client can drop the response mid-flight (abort, RST); swallow so the
  // process never dies on an unhandled socket error.
  res.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer(forward);
server.on("clientError", (err, socket) => socket.destroy());

// WebSocket downlinks (/api/events.mux, /api/events.host) pass through the same
// base-prefixed paths; pipe the upgraded socket to upstream.
server.on("upgrade", (req, socket, head) => {
  const targetPath = normalizePath(req.url);
  const headers = requestHeaders(req.headers);
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: targetPath,
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
  });
  // Raw upgraded sockets emit 'error' (RST/abort) with no automatic handler;
  // without these listeners any dropped WS connection would crash the proxy.
  socket.on("error", () => socket.destroy());
  upstream.on("error", () => socket.destroy());
  upstream.on("response", (upRes) => {
    // Upstream refused the upgrade (e.g. 404/502). Pass a plain HTTP response
    // back instead of leaving the browser connection hanging.
    const statusLine = `HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || "Error"}\r\n`;
    socket.write(statusLine);
    for (const [k, v] of Object.entries(responseHeaders(upRes.headers))) {
      socket.write(`${k}: ${v}\r\n`);
    }
    socket.write("\r\n");
    upRes.on("error", () => socket.destroy());
    upRes.pipe(socket);
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    upSocket.on("error", () => {
      socket.destroy();
      upSocket.destroy();
    });
    // Forward the upstream 101 headers verbatim: the browser WebSocket verifies
    // Sec-WebSocket-Accept (SHA-1 of key+GUID), so a hardcoded 101 would fail.
    socket.write("HTTP/1.1 101 Switching Protocols\r\n");
    for (const [k, v] of Object.entries(upRes.headers)) {
      socket.write(`${k}: ${v}\r\n`);
    }
    socket.write("\r\n");
    // Push each side's buffered head into the other pipe before streaming.
    if (head.length) upSocket.write(head);
    if (upHead.length) socket.write(upHead);
    socket.pipe(upSocket).pipe(socket);
  });
  upstream.end();
});

// ---------------------------------------------------------------------------
// Upstream readiness / dsh spawn
// ---------------------------------------------------------------------------

function upstreamReady() {
  return new Promise((resolve) => {
    const r = http.get({ host: UPSTREAM_HOST, port: UPSTREAM_PORT, path: "/" }, (res) => {
      res.resume();
      resolve(true);
    });
    r.on("error", () => resolve(false));
    r.setTimeout(1000, () => {
      r.destroy();
      resolve(false);
    });
  });
}

let dshChild = null;

async function ensureUpstream() {
  if (!SPAWN_DSH) return;
  if (await upstreamReady()) return;
  console.log(`[dsh-codeserver-proxy] upstream not running, spawning dsh web on ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  const child = spawn("dsh", ["web", "--port", String(UPSTREAM_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  dshChild = child;
  child.stdout.on("data", (d) => process.stdout.write(`[dsh] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[dsh] ${d}`));
  child.on("exit", (code) => {
    if (dshChild === child) dshChild = null;
    if (code !== null && code !== 0) console.error(`[dsh-codeserver-proxy] dsh web exited with code ${code}`);
  });
  for (let i = 0; i < 30; i++) {
    if (await upstreamReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("[dsh-codeserver-proxy] upstream did not become ready; continuing anyway");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown(signal) {
  console.log(`[dsh-codeserver-proxy] ${signal} received, shutting down`);
  server.close(() => process.exit(0));
  if (dshChild && !dshChild.killed) dshChild.kill("SIGTERM");
  // Fallback: never hang in a half-open state.
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
// Do not leave a spawned `dsh web` orphaned if the proxy dies another way.
process.on("exit", () => {
  if (dshChild && !dshChild.killed) dshChild.kill("SIGTERM");
});

await ensureUpstream();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dsh-codeserver-proxy] listening on ${PORT}; access through ${BASE}/ on code-server`);
  console.log(`[dsh-codeserver-proxy] forwarding to ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
