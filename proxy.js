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
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Buffer } from "node:buffer";

// Minimal .env loader (no shell interpolation). Deployers keep private values
// — proxy base path, listening/upstream ports, whether to spawn dsh — in a
// gitignored .env; every variable below has a documented default for the
// common code-server + dsh-on-loopback layout. Real environment variables
// always win over .env entries.
for (const line of existsSync(".env") ? readFileSync(".env", "utf8").split("\n") : []) {
  const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && m[2] !== "" && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

// Variables use the PROXY_ prefix (not DSH_*): dsh boots with this directory as
// its cwd and refuses any DSH_-prefixed name it finds in a .env there.
const BASE = process.env.PROXY_BASE || "/proxy/3100";
const UPSTREAM_HOST = process.env.PROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.PROXY_UPSTREAM_PORT || 3000);
const PORT = Number(process.env.PROXY_PORT || 3100);
const SPAWN_DSH = process.env.PROXY_SPAWN_DSH !== "0";

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

function rewriteHtml(body, base) {
  let s = body;
  // Each `from` begins with the opening quote of a root-absolute reference; the
  // base path goes AFTER that quote, so the reference stays well-formed JSON/HTML.
  const rules = [
    '"/assets/',
    '"/plugins/',
    '"/manifest.webmanifest"',
    '"/favicon.svg"',
  ];
  for (const from of rules) {
    s = s.split(from).join('"' + base + from.slice(1));
  }
  return s;
}

function rewriteJs(body, base) {
  let s = body;
  // Longer/more specific first; shorter generic forms afterwards, so a shorter
  // match never runs first and produces a double-prefixed string. The base path
  // is inserted after the opening quote/backtick in every case.
  const rules = [
    // The base path rewrites `/api` (the RPC channel) to `/proxy/3100/api`,
    // but connection's assertTarget rejects a channel with more than one slash
    // (`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`). Widen the class to accept
    // `/`, so the rewritten multi-segment channel passes validation while the
    // URL built from it (`${channel}/${endpoint}`) still carries the base path.
    ["CHANNEL_PATTERN = /^\\/[A-Za-z0-9._~-]+$/", "CHANNEL_PATTERN = /^\\/[A-Za-z0-9._~\\/-]+$/"],
    ['"/api/events.host"', '"' + base + '/api/events.host"'],
    ['"/api/events.mux"', '"' + base + '/api/events.mux"'],
    ['"/api/respond"', '"' + base + '/api/respond"'],
    // Any other /api/<plugin>/... route (dsh-ssh, skin-center, ...): prefix the
    // whole root-absolute /api/ subpath family, not just the fixed ones above.
    ['"/api/', '"' + base + '/api/'],
    ["`/api/${method}`", `\`${base}/api/\${method}\``],
    // Backtick form of the same plugin-API family (`/api/pet`, ...).
    ["`/api/", `\`${base}/api/`],
    ['"/plugins/events"', '"' + base + '/plugins/events"'],
    // Plugin client bundles fetch their own /plugins/<id>/... assets at runtime
    // (e.g. a ticker widget); rewriteHtml already covers the HTML-side refs.
    ['"/plugins/', '"' + base + '/plugins/'],
    // dshmarket client bundle references its HTTP routes (`/dsh-market/*`,
    // registry/installed/install/...) as root-absolute strings; prefix them
    // so the browser hits them under the proxy base path.
    ['"/dsh-market/', '"' + base + '/dsh-market/'],
    // vision-toolkit exposes its HTTP routes under /_dsh/vision-toolkit/*.
    ['"/_dsh/', '"' + base + '/_dsh/'],
    ['"/manifest.webmanifest"', '"' + base + '/manifest.webmanifest"'],
    ['"/favicon.svg"', '"' + base + '/favicon.svg"'],
    ['"/api"', '"' + base + '/api"'],
    ["`/api`", `\`${base}/api\``],
  ];
  for (const [from, to] of rules) {
    s = s.split(from).join(to);
  }
  return s;
}

function normalizePath(rawUrl) {
  let url = rawUrl;
  if (url.startsWith(BASE)) url = url.slice(BASE.length);
  // code-server's proxy target joins an extra slash, e.g. //api/events.mux.
  url = url.replace(/^\/+/, "/");
  if (url === "") url = "/";
  return url;
}

const LOOPBACK_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;

function headerHost(headers) {
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
  if (out.origin) out.origin = `http://${LOOPBACK_AUTHORITY}`;
  return out;
}

function forward(req, res) {
  const targetPath = normalizePath(req.url);
  const headers = headerHost(req.headers);

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: targetPath,
      method: req.method,
      headers,
    },
    (upRes) => {
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        let body = Buffer.concat(chunks);
        const type = upRes.headers["content-type"] || "";
        let status = upRes.statusCode;
        if (status === 200) {
          if (type.includes("text/html")) body = Buffer.from(rewriteHtml(body.toString("utf8"), BASE));
          else if (type.includes("javascript")) body = Buffer.from(rewriteJs(body.toString("utf8"), BASE));
          else if (type.includes("application/manifest+json")) body = Buffer.from(rewriteHtml(body.toString("utf8"), BASE));
        }
        const outHeaders = { ...upRes.headers };
        delete outHeaders["transfer-encoding"];
        delete outHeaders["content-length"];
        outHeaders["content-length"] = String(body.length);
        res.writeHead(status, outHeaders);
        res.end(body);
      });
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`dsh-codeserver-proxy: upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT} unreachable: ${err.message}`);
  });
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
  const headers = headerHost(req.headers);
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

async function ensureUpstream() {
  if (!SPAWN_DSH) return;
  if (await upstreamReady()) return;
  console.log(`[dsh-codeserver-proxy] upstream not running, spawning dsh web on ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  const child = spawn("dsh", ["web", "--port", String(UPSTREAM_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[dsh] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[dsh] ${d}`));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[dsh-codeserver-proxy] dsh web exited with code ${code}`);
  });
  for (let i = 0; i < 30; i++) {
    if (await upstreamReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("[dsh-codeserver-proxy] upstream did not become ready; continuing anyway");
}

await ensureUpstream();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dsh-codeserver-proxy] listening on ${PORT}; access through ${BASE}/ on code-server`);
  console.log(`[dsh-codeserver-proxy] forwarding to ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
