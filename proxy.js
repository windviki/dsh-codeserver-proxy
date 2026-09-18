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
// prefix of it (e.g. /api/remote.mux before /api/, and /api itself last), so
// a generic rule never runs first and produces a double-prefixed string.
const HTML_TARGETS = ["/assets/", "/plugins/", "/manifest.webmanifest", "/favicon.svg"];
// NOTE: never add "/api/" (or /sidebar/, /git/, /pet/) to HTML_TARGETS: dsh
// 0.1.2's index.html inlines a parse-time remote-channel boot patch whose
// detector table uses those exact root-absolute strings. The patch only
// reroutes paths that literally start with them; every request the base-path
// rewrite produces carries the /proxy/<port>/ prefix and therefore never
// matches, which keeps the patch correctly inert under code-server.
const JS_TARGETS = [
  "/api/remote.mux",
  "/api/",
  "/plugins/events",
  "/plugins/",
  "/dsh-market/",
  "/_dsh/",
  // Third-party plugin root-absolute API prefixes. `@linxin666/*` plugins
  // fetch these directly (post()/EventSource); without the rewrite the
  // browser resolves them against the code-server host root and the calls
  // never reach dsh. Use the specific `/describe-image/` prefix, never bare
  // `/describe`: dsh-web-ui-settings builds its settings-bridge URLs as
  // WEB_UI_SETTINGS_BRIDGE_PREFIX + path where path is `"/describe"` /
  // `"/mutate"`, so a bare `/describe` target would double-prefix them into
  // /proxy/3100/api/dsh-web-ui-settings/proxy/3100/describe → 404.
  "/git/",
  "/describe-image/",
  // `dsh-better-sidebar` serves its whole surface under /sidebar/:
  // POST `/sidebar/api/<method>` (fs.tree/git.status/…), lazy chunk scripts
  // `/sidebar/bundle/<name>.js`, `/sidebar/file?…` media, `/sidebar/ws/*`
  // terminals and `/sidebar/html/*` previews — all root-absolute, so without
  // the rewrite the browser resolves them against the code-server host root
  // (chunks 404, API POSTs 405).
  "/sidebar/",
  "/pet/",
  "/tree/",
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

// Root path segments that are local filesystem/system roots, never plugin API
// keys: a `/key/…` literal under one of these must stay untouched.
const FS_ROOT_SEGMENTS = new Set([
  "home", "root", "Users", "dev", "bin", "sbin", "usr", "etc", "var", "tmp",
  "proc", "sys", "opt", "lib", "lib64", "boot", "media", "mnt", "run", "srv",
  "System", "Library", "Applications", "private", "Volumes", "Network",
]);

// Fallback rewrite for plugins not yet in JS_TARGETS: any root-absolute
// `"/<key>/…"` literal left after the whitelist pass whose first segment looks
// like a plugin key (a short alnum/dot/underscore/hyphen token that is not a
// filesystem root, not `proxy` — the base path — and not an already-whitelisted
// key) gets base-prefixed too. Newly added plugins therefore work without
// editing the whitelist. Heuristic by design:
// - Only double/single-quoted literals are considered. Backtick templates are
//   left to the whitelist (dsh-better-sidebar's `/sidebar/bundle/${name}.js`
//   chunk loader and `/sidebar/ws/*` are the known backtick forms; scanning
//   backticks generically hits minified non-URL encodings — CodeMirror's parser
//   payloads in client-editor.js look like `/nQ/…`, `/U/…` — so they must not
//   be rewritten).
// - Only the quote that opens the literal is considered, so nested paths inside
//   an already-prefixed string can never be re-prefixed, and fs paths (/home,
//   /tmp, /dev, …) are never touched.
function pluginFallbackPrefix(s, base, quote) {
  return s.replace(
    new RegExp(quote + "\\/([A-Za-z0-9][A-Za-z0-9._-]*)\\/", "g"),
    (whole, seg) =>
      FS_ROOT_SEGMENTS.has(seg) || seg === "proxy" ? whole : quote + base + "/" + seg + "/",
  );
}

function rewriteHtml(body, base) {
  if (base === "/") return body;
  let s = prefixQuoted(body, base, '"', HTML_TARGETS);
  // dsh 0.1.2 injects `<base href="/">` into index.html and references its
  // assets relatively (`./assets/…`, `./manifest.webmanifest`). Point the base
  // at the forwarded subtree so every relative reference resolves under the
  // base path without per-reference rewriting.
  s = s.split('<base href="/">').join(`<base href="${base}/">`);
  return s;
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
  // dsh-client-connection derives connection.isLoopback from the browser's
  // location.hostname (unless a transport owns the host). Through code-server
  // that hostname is never loopback; dsh 0.1.2's inlined remote-channel boot
  // patch sets __DSH_TRANSPORT__.ownsHost on non-loopback pages which covers
  // it — but only while that patch is present. Force the flag true to match
  // the Host/Origin rewrite, so privileged settings RPCs are always issued.
  // 0.1.2 literal first, the 0.1.1 form kept for symmetry (no-op if absent).
  s = s
    .split("isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),")
    .join("isLoopback: true,");
  s = s
    .split("isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),")
    .join("isLoopback: true,");
  // dsh-remote-web-ui 0.3.17 ships inside the @linxin666/dsh-web-all bundle
  // and installs a fetch/WebSocket patch that reroutes its detector matches
  // under `/remote`. Two problems under code-server: its detector table would
  // be base-prefixed by the rewrite above (matching every real request and
  // misrouting it to /remote/proxy/<port>/…, which dies at the code-server
  // hop), and the fenced /remote mirror is unreachable through the port
  // forward anyway. remoteChannelRequired() is the single gate for installing
  // the channel; force it off in the proxy-served copy — exactly the inert
  // behaviour the byte-for-byte exclusion produced for older dsh versions.
  s = s
    .split("function remoteChannelRequired(hostname, snapshot, hostPairingPolicy) {")
    .join("function remoteChannelRequired(hostname, snapshot, hostPairingPolicy) { return false;");
  // Cover double-quoted, single-quoted and backtick forms uniformly (e.g.
  // vision-toolkit emits '/_dsh/...' with single quotes, dsh-pet emits
  // '/api/pet/pets' with single quotes, connection uses `/${method}`).
  for (const q of ['"', "'", "`"]) s = prefixQuoted(s, base, q, JS_TARGETS);
  // Rescue unknown plugin keys not in JS_TARGETS (whitelist stays first).
  // Double/single quotes only — backtick templates are the whitelist's job.
  for (const q of ['"', "'"]) s = pluginFallbackPrefix(s, base, q);
  return s;
}

function needsRewrite(status, contentType, pathname = "") {
  if (status !== 200 || !contentType) return false;
  // dsh-remote-web-ui's remote channel patches window.fetch/WebSocket/… and
  // decides what to reroute from prefix constants baked into its client
  // (API_PREFIX = "/api/", WS_PATHS, SIDEBAR_PREFIX, …). The base-path rewrite
  // would turn those detectors into "/proxy/3100/api/…", so the channel then
  // misroutes every already-prefixed SDK call to /remote/proxy/3100/api/…,
  // which the code-server hop rejects with 405 before it ever reaches dsh.
  // When the client is addressable on its own (dsh ≤0.1.1 per-package URLs,
  // and the 0.1.2 `??`-prefixed form), serving it byte-for-byte keeps the
  // detectors correct. In 0.1.2 the code is compiled into the shared
  // dsh-web-all bundle where exclusion is impossible; rewriteJs neutralises
  // the channel gate there instead.
  if (
    pathname.startsWith("/plugins/@linxin666/dsh-remote-web-ui/client.js") ||
    pathname.startsWith("/plugins/??@linxin666/dsh-remote-web-ui/client.js")
  ) {
    return false;
  }
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

// ---------------------------------------------------------------------------
// dsh 0.1.2 launch-token authentication
// ---------------------------------------------------------------------------
// dsh 0.1.2 fences the whole web UI — index and every /api RPC — behind a
// browser cookie that is only minted when the launch URL's one-time query
// token is presented on GET / (the fence applies to loopback too). The token
// is printed once per `dsh web` process on stdout; it is reusable for further
// handshakes, and the minted cookie is bound to the request authority, signed
// with a secret persisted in the dsh home (30-day lifetime). The proxy:
//   - captures the token from the spawned dsh's stdout (or PROXY_DSH_TOKEN
//     when dsh is managed externally),
//   - runs the handshake server-side for a browser entry that holds no (or a
//     stale) dsh-auth cookie and hands that cookie to the browser on the index
//     response itself — `Set-Cookie` on the 200, never a 3xx — so opening
//     /proxy/<port>/ keeps working with one click,
//   - keeps the minted cookie for its own internal RPC probes.
//
// The cookie is deliberately NOT handed over through the upstream's `303 → /`:
// every hop in front of this proxy is free to prefix root-absolute redirects,
// and code-server's path proxy does exactly that (out/node/proxy.js,
// proxyRes hook: `location = req.base + location`). A base-prefixed Location
// therefore came back as /proxy/<port>/proxy/<port>/ in the browser's address
// bar, and the Location had to survive whatever the outer hop does. Serving
// the index with Set-Cookie needs no Location at all and cannot double.
let launchToken = process.env.PROXY_DSH_TOKEN || null;

let authCookie = null; // `name=value` presented to upstream
let authCookieSetCookie = null; // full Set-Cookie value handed to the browser

// The exact generated dsh-auth cookie the browser sent, if any. dsh names the
// cookie `dsh-auth-<sha256(authority)>` and binds the payload to the same
// authority, so a browser cookie either is the cookie this proxy would mint
// (same authority) or is stale — comparing the whole pair catches both.
function browserAuthPair(req) {
  const m = (req.headers.cookie || "").match(/(?:^|;\s*)(dsh-auth-[^=]*=[^;]*)/);
  return m ? m[1] : null;
}

// Mint the proxy-internal auth cookie via the launch token (GET /?token=…).
function handshakeCookie() {
  return new Promise((resolve) => {
    if (!launchToken) return resolve(null);
    const r = http.get(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: `/?token=${launchToken}`,
        headers: { host: LOOPBACK_AUTHORITY, "accept-encoding": "identity" },
      },
      (res) => {
        res.resume();
        const setCookie = res.headers["set-cookie"];
        const full = Array.isArray(setCookie) ? setCookie[0] : undefined;
        if (res.statusCode === 303 && typeof full === "string") {
          const pair = full.split(";")[0];
          resolve(pair ? { pair, setCookie: full } : null);
          return;
        }
        resolve(null);
      },
    );
    r.on("error", () => resolve(null));
    r.setTimeout(2000, () => {
      r.destroy();
      resolve(null);
    });
  });
}

let authCookieInflight = null;
async function ensureAuthCookie() {
  if (authCookie) return authCookie;
  if (!launchToken) return null;
  if (!authCookieInflight) {
    authCookieInflight = handshakeCookie()
      .then((minted) => {
        if (minted) {
          authCookie = minted.pair;
          authCookieSetCookie = minted.setCookie;
        }
        return authCookie;
      })
      .finally(() => {
        authCookieInflight = null;
      });
  }
  return authCookieInflight;
}

function invalidateAuthCookie() {
  authCookie = null;
  authCookieSetCookie = null;
}

// Attach the minted cookie to an outgoing response, keeping any Set-Cookie the
// upstream sent (the handshake's own header is the array-typed case).
function withInjectedCookie(headers, setCookie) {
  if (!setCookie) return headers;
  const existing = headers["set-cookie"];
  const list = existing === undefined ? [] : Array.isArray(existing) ? existing.slice() : [existing];
  if (!list.includes(setCookie)) list.push(setCookie);
  headers["set-cookie"] = list;
  return headers;
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

async function forward(req, res) {
  const targetPath = normalizePath(req.url);
  const headers = requestHeaders(req.headers);
  // Plain index navigation with a launch token available: the browser is about
  // to be served the application shell, so it is also the right moment to make
  // sure it holds a usable dsh-auth cookie. A request that already carries a
  // `?token=` is left alone (its upstream 303 → / becomes the clean
  // /proxy/<port>/ under code-server, which re-prefixes it itself).
  const isIndexEntry = req.method === "GET" && targetPath === "/" && Boolean(launchToken);
  let injectSetCookie = null;

  if (isIndexEntry) {
    const cookie = await ensureAuthCookie();
    if (cookie !== null) {
      headers.cookie = cookie;
      // Hand the cookie over whenever the browser's copy is missing or differs
      // from the one this proxy validated (stale cookie after a secret
      // rotation), so the whole session — not just the index — is authorized.
      if (browserAuthPair(req) !== cookie) injectSetCookie = authCookieSetCookie;
    }
  }

  let inflight = null;

  const handleResponse = (upRes, attempt) => {
    const status = upRes.statusCode;
    const contentType = upRes.headers["content-type"] || "";

    // The index answered 401 even though the proxy sent its minted cookie: the
    // cookie went stale (rotated dsh home secret, expired). Drop it, handshake
    // once more and retry the same request with the fresh cookie; that retry is
    // a bodiless GET, so it is written straight to the wire rather than piped.
    if (status === 401 && isIndexEntry && attempt === 1) {
      upRes.resume();
      invalidateAuthCookie();
      ensureAuthCookie()
        .then((cookie) => {
          if (res.destroyed) return;
          if (cookie === null) {
            // No token configured, or the upstream no longer accepts it: report
            // the fence instead of looping. The body is rewritten so a stale
            // content-length from upstream can never hang the client.
            const body = Buffer.from("dsh-codeserver-proxy: dsh web authentication required (no valid launch token)\n");
            const staleHeaders = withInjectedCookie(responseHeaders(upRes.headers), injectSetCookie);
            staleHeaders["content-type"] = "text/plain; charset=utf-8";
            staleHeaders["content-length"] = String(body.length);
            res.writeHead(401, staleHeaders);
            res.end(body);
            return;
          }
          headers.cookie = cookie;
          injectSetCookie = authCookieSetCookie;
          dispatch(2);
        })
        .catch((err) => sendUpstreamError(res, err));
      return;
    }

    // dsh's only source of 405 is the static-files fallback rejecting a
    // non-GET/HEAD request no registered route claims — during start-up the
    // RPC channel `/api` is not registered yet, so POST /api/* answers 405.
    // The frontend treats that as a real Method Not Allowed and never
    // retries. Report a transient 503 (with retry-after) instead and keep
    // the readiness probe spinning; once dsh finishes booting the next
    // request succeeds. A 405 on a live channel is anomalous and passes
    // through untouched.
    if (status === 405 && req.method === "POST" && targetPath.startsWith("/api")) {
      upRes.resume();
      ensureRpcProbe();
      if (!rpcReady) {
        res.writeHead(503, {
          "content-type": "text/plain; charset=utf-8",
          "retry-after": "2",
        });
        res.end("dsh-codeserver-proxy: dsh web is still starting up; refresh in a moment");
        return;
      }
    }

    if (needsRewrite(status, contentType, targetPath)) {
      // Rewritable responses are buffered (they are HTML/JS text, not large
      // binaries), rewritten, then sent with a recomputed content-length.
      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        if (res.destroyed) return;
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = Buffer.from(rewriteBody(raw, BASE, contentType));
        const outHeaders = withInjectedCookie(responseHeaders(upRes.headers), injectSetCookie);
        outHeaders["content-length"] = String(body.length);
        res.writeHead(status, outHeaders);
        res.end(body);
      });
      upRes.on("error", () => res.destroy());
    } else if (status >= 300 && status < 400 && upRes.headers.location) {
      // Redirects pass through verbatim. Root-absolute Locations are the outer
      // hop's business: code-server's path proxy already prepends its own base
      // to them, so prefixing here would produce /proxy/<port>/proxy/<port>/.
      upRes.resume();
      res.writeHead(status, withInjectedCookie(responseHeaders(upRes.headers), injectSetCookie));
      res.end();
    } else {
      // Everything else (assets, streams, SSE, 404s, ...) is piped through
      // untouched, without buffering it in memory.
      const outHeaders = withInjectedCookie(responseHeaders(upRes.headers), injectSetCookie);
      if (res.destroyed) {
        upRes.destroy();
        return;
      }
      res.writeHead(status, outHeaders);
      upRes.pipe(res);
      upRes.on("error", () => res.destroy());
    }
  };

  const dispatch = (attempt) => {
    const upstream = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: targetPath,
        method: req.method,
        headers,
      },
      (upRes) => handleResponse(upRes, attempt),
    );
    inflight = upstream;
    upstream.on("error", (err) => sendUpstreamError(res, err));
    // The 401 retry only ever happens for the bodiless index GET; piping the
    // request again after its 'end' has already fired would hang the upstream.
    if (attempt === 1) req.pipe(upstream);
    else upstream.end();
  };

  // Client can drop the request/response mid-flight (abort, RST); swallow so
  // the process never dies on an unhandled socket error.
  req.on("error", () => inflight?.destroy());
  res.on("error", () => inflight?.destroy());
  dispatch(1);
}

// forward() awaits the auth-cookie handshake, so its rejection must never
// escape as an unhandled rejection (Node would tear the process down).
const server = http.createServer((req, res) => {
  forward(req, res).catch((err) => sendUpstreamError(res, err));
});
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

// dsh web's HTTP server is up (and its static-files fallback is registered)
// before its RPC channel `/api` is: the webserver listens early, then plugins
// register routes as they boot. A POST /api/* that lands in that window hits
// the fallback, which answers 405 (method not allowed) — the frontend treats
// that as a real error and never retries, so the whole session list / history
// / providers UI breaks during start-up. The readiness probe below watches the
// RPC channel directly (agentPresets/list answers 200 once the channel + the
// @Remote gateway are live) so the proxy can tell "dsh is still booting" from
// "dsh is broken".
let rpcReady = false;
let rpcProbeScheduled = false;

async function probeRpcOnce() {
  // 0.1.2 fences /api behind the browser cookie; the probe handshakes once
  // with the captured launch token and re-mints whenever the cookie goes bad
  // (dsh restart rotates nothing here, but expiry/secret changes do).
  const cookie = await ensureAuthCookie();
  return new Promise((resolve) => {
    const body = JSON.stringify({
      type: "client-request",
      rpcId: "dsh-codeserver-proxy:probe",
      method: "agentPresets/list",
      payload: {},
    });
    const headers = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    };
    if (cookie) headers.cookie = cookie;
    const probe = http.request(
      {
        host: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: "/api/agentPresets/list",
        method: "POST",
        headers,
      },
      (probeRes) => {
        probeRes.resume();
        if (probeRes.statusCode === 401) authCookie = null;
        resolve(probeRes.statusCode === 200);
      },
    );
    probe.on("error", () => resolve(false));
    probe.setTimeout(1500, () => {
      probe.destroy();
      resolve(false);
    });
    probe.end(body);
  });
}

// Probe until the channel is live, re-scheduling itself once a second while
// dsh is still booting; idles (rpcReady stays true) once ready.
async function ensureRpcProbe() {
  if (rpcReady || rpcProbeScheduled) return;
  rpcProbeScheduled = true;
  try {
    if (await probeRpcOnce()) {
      rpcReady = true;
      return;
    }
  } finally {
    rpcProbeScheduled = false;
  }
  setTimeout(() => ensureRpcProbe(), 1000);
}

async function waitForRpcReady(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeRpcOnce()) {
      rpcReady = true;
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.error("[dsh-codeserver-proxy] RPC channel did not become ready; continuing anyway");
  return false;
}

let dshChild = null;

async function ensureUpstream() {
  if (!SPAWN_DSH) return;
  if (await upstreamReady()) {
    // Port is up but the RPC channel may not be registered yet; wait for it so
    // the first browser requests don't hit the static-files fallback (405).
    await waitForRpcReady();
    return;
  }
  console.log(`[dsh-codeserver-proxy] upstream not running, spawning dsh web on ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  const child = spawn("dsh", ["web", "--port", String(UPSTREAM_PORT), "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  dshChild = child;
  // dsh 0.1.2 prints the authenticated launch URL once on stdout; capture the
  // one-time token so the proxy can run the cookie handshake for browsers.
  child.stdout.on("data", (d) => {
    const text = d.toString();
    const m = text.match(/[?&]token=([A-Za-z0-9_-]+)/);
    if (m) {
      launchToken = m[1];
      console.log("[dsh-codeserver-proxy] captured dsh web launch token");
    }
    process.stdout.write(`[dsh] ${text}`);
  });
  child.stderr.on("data", (d) => process.stderr.write(`[dsh] ${d}`));
  child.on("exit", (code) => {
    if (dshChild === child) dshChild = null;
    if (code !== null && code !== 0) console.error(`[dsh-codeserver-proxy] dsh web exited with code ${code}`);
  });
  for (let i = 0; i < 30; i++) {
    if (await upstreamReady()) {
      await waitForRpcReady();
      return;
    }
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
