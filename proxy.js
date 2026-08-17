#!/usr/bin/env node
/**
 * Base-path adapter for the official DeepSeek Harness web UI.
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
import { Buffer } from "node:buffer";

const BASE = process.env.DSH_WEB_BASE || "/proxy/3100";
const UPSTREAM_HOST = process.env.DSH_WEB_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.DSH_WEB_UPSTREAM_PORT || 3000);
const PORT = Number(process.env.PORT || 3100);
const SPAWN_DSH = process.env.DSH_WEB_SPAWN !== "0";

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
    ['"/api/events.host"', '"' + base + '/api/events.host"'],
    ['"/api/events.mux"', '"' + base + '/api/events.mux"'],
    ['"/api/respond"', '"' + base + '/api/respond"'],
    ["`/api/${method}`", `\`${base}/api/\${method}\``],
    ['"/plugins/events"', '"' + base + '/plugins/events"'],
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

function forward(req, res) {
  const targetPath = normalizePath(req.url);
  const headers = {};
  // Preserve the original Host header: dsh's /api fence compares Host against
  // the browser's Origin, and the profile trusts the external authority
  // (code.example.com) via trustedHosts. Rewriting Host to the loopback target
  // would make the two mismatch and the fence would reject every request.
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    headers[k] = v;
  }

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
    res.end(`dsh-web-proxy: upstream ${UPSTREAM_HOST}:${UPSTREAM_PORT} unreachable: ${err.message}`);
  });
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer(forward);

// WebSocket downlinks (/api/events.mux, /api/events.host) pass through the same
// base-prefixed paths; pipe the upgraded socket to upstream.
server.on("upgrade", (req, socket, head) => {
  const targetPath = normalizePath(req.url);
  const headers = {};
  // Keep the original Host header, same rationale as forward(): dsh's /api fence
  // (and the WS handshake) compares Host against the browser's Origin, and the
  // profile trusts code.example.com via trustedHosts. Rewriting it to loopback
  // would make Host != Origin and the fence would reject the upgrade.
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    headers[k] = v;
  }
  const upstream = http.request({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    path: targetPath,
    headers: { ...headers, connection: "Upgrade", upgrade: "websocket" },
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
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
  upstream.on("error", () => socket.destroy());
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
  console.log(`[dsh-web-proxy] upstream not running, spawning dsh web on ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  const child = spawn("dsh", ["web", "--port", String(UPSTREAM_PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[dsh] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[dsh] ${d}`));
  child.on("exit", (code) => {
    if (code !== null && code !== 0) console.error(`[dsh-web-proxy] dsh web exited with code ${code}`);
  });
  for (let i = 0; i < 30; i++) {
    if (await upstreamReady()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error("[dsh-web-proxy] upstream did not become ready; continuing anyway");
}

await ensureUpstream();
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[dsh-web-proxy] listening on ${PORT}; access through ${BASE}/ on code-server`);
  console.log(`[dsh-web-proxy] forwarding to ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
});
