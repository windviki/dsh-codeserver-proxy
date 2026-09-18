// Integration test for the dsh 0.1.2 launch-token authentication and the new
// rewrite anchors in proxy.js.
//
// dsh 0.1.2-rc.1 fences the whole web UI behind a browser cookie minted from
// the launch URL's one-time ?token= (loopback included): GET / without a
// cookie answers 401, GET /?token=… answers 303 + Set-Cookie, and every /api
// RPC demands the cookie as well. The proxy must:
//   - capture the token (here: PROXY_DSH_TOKEN, the externally-managed path)
//   - run the handshake server-side for a cookie-less (or stale-cookie) entry
//     and hand the cookie to the browser on the index 200 itself — never via a
//     3xx, because the hop in front (code-server) prepends its own base to
//     root-absolute Locations and the two prefixes would stack into
//     /proxy/<port>/proxy/<port>/
//   - pass authenticated traffic through unchanged
//   - repoint the injected <base href="/"> at the forwarded subtree while
//     leaving the inlined remote-channel boot patch's detector table alone
//   - force connection.isLoopback true (0.1.2 literal) and neutralise the
//     remote channel gate compiled into the shared dsh-web-all bundle
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "proxy.js");
const TOKEN = "it-launch-token-secret";
const COOKIE_NAME = "dsh-auth-it";
const COOKIE_VALUE = "v1.signed-payload";

const FAKE_INDEX = [
  "<!doctype html><html><head>",
  '<base href="/">',
  '<link rel="preload" as="script" href="/plugins/??x/client.js&rev=1">',
  "<script>",
  'var R={"remotePrefix":"/remote","apiPrefix":"/api/","sidebarPrefix":"/sidebar/","wsPaths":["/api/remote.mux"]};',
  "</script>",
  "</head><body></body></html>",
].join("");

const FAKE_WEBALL = [
  "function remoteChannelRequired(hostname, snapshot, hostPairingPolicy) {",
  "  if (isLoopbackHostname(hostname)) return false;",
  "  return snapshot.enabled;",
  "}",
  'const RULES = { apiPrefix: "/api/", sidebarPrefix: "/sidebar/" };',
  'fetch("/dsh-market/status");',
].join("\n");

const FAKE_CONN = [
  "const handle = {",
  "  isLoopback: transport?.ownsHost === true || pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),",
  "};",
].join("\n");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Stub upstream mirroring dsh 0.1.2's browser-auth fence.
class StubUpstream {
  constructor(port) {
    this.port = port;
    this.seen = { paths: [] };
    // Force the next index request to answer 401 even with a valid cookie, to
    // exercise the proxy's "cookie went stale → re-handshake → retry" path.
    this.rejectNextIndex = false;
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      this.seen.paths.push(req.method + " " + url.pathname + url.search);
      const authed = (req.headers.cookie || "").includes(`${COOKIE_NAME}=${COOKIE_VALUE}`);

      if (req.method === "GET" && url.pathname === "/" && url.searchParams.get("token") === TOKEN) {
        res.writeHead(303, {
          location: "/",
          "set-cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/legacy-redirect") {
        // A root-absolute redirect straight from upstream: code-server prepends
        // its own base to this, so the proxy must forward it verbatim.
        res.writeHead(302, { location: "/" });
        res.end();
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        if (this.rejectNextIndex) {
          this.rejectNextIndex = false;
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
          return;
        }
        if (!authed) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("dsh web authentication required; reopen the URL printed by dsh web.\n");
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(FAKE_INDEX);
        return;
      }
      // `/plugins/??<pkg>/client.js&rev=…` puts everything after the first `?`
      // into the query string — match on the raw URL instead of the pathname.
      if (req.method === "GET" && req.url.startsWith("/plugins/??@linxin666/dsh-web-all/client.js")) {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(FAKE_WEBALL);
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/plugins/??@deepseek-ai/dsh-client-connection/client.js")) {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(FAKE_CONN);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        if (!authed) {
          res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
          res.end("dsh web authentication required\n");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: "x", result: { ok: true } }));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  }
  listen() {
    return new Promise((resolve) => this.server.listen(this.port, "127.0.0.1", resolve));
  }
  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

function request(port, pathname, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body: data,
          location: res.headers.location,
          setCookie: res.headers["set-cookie"],
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("proxy.js dsh 0.1.2 auth fence + rewrite anchors", () => {
  let stubPort;
  let proxyPort;
  let base;
  let stub;
  let proxy;

  before(async () => {
    stubPort = await freePort();
    proxyPort = await freePort();
    base = "/proxy/" + proxyPort;
    stub = new StubUpstream(stubPort);
    await stub.listen();
    proxy = spawn(process.execPath, [PROXY_JS], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_UPSTREAM_HOST: "127.0.0.1",
        PROXY_UPSTREAM_PORT: String(stubPort),
        PROXY_SPAWN_DSH: "0",
        PROXY_DSH_TOKEN: TOKEN,
        PROXY_BASE: base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proxy.stderr.on("data", (d) => (err += d));
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        const c = net.connect({ host: "127.0.0.1", port: proxyPort });
        c.on("connect", () => {
          c.destroy();
          resolve();
        });
        c.on("error", () => {
          c.destroy();
          if (Date.now() - start > 8000) return reject(new Error("proxy never listened: " + err.slice(0, 500)));
          setTimeout(tick, 150);
        });
      };
      tick();
    });
  });

  after(async () => {
    proxy?.kill("SIGKILL");
    await stub?.close();
  });

  test("无 cookie 首次进入: 代理代跑 token 握手, 直接 200 首页 + Set-Cookie, 不产生 3xx/Location", async () => {
    const before = stub.seen.paths.length;
    const r = await request(proxyPort, base + "/");
    assert.equal(r.status, 200, "应以首页直接应答, 而不是 303 重定向");
    assert.equal(r.location, undefined, "不得产生 Location——外层 code-server 会再叠加一层 base 前缀");
    assert.ok(
      r.setCookie?.some((c) => c.startsWith(`${COOKIE_NAME}=${COOKIE_VALUE}`)),
      "换来的 cookie 应通过 Set-Cookie 交给浏览器",
    );
    assert.match(r.body, new RegExp(`<base href="${base}/">`), "首页应正常改写 base 标签");
    const seen = stub.seen.paths.slice(before);
    assert.ok(seen.includes(`GET /?token=${TOKEN}`), "上游应收到带 token 的握手请求, 实际: " + JSON.stringify(seen));
    assert.ok(seen.includes("GET /"), "首页请求应带上换来的 cookie, 实际: " + JSON.stringify(seen));
  });

  test("浏览器带过期 dsh-auth cookie: 用代理 cookie 重取首页并补发有效的 Set-Cookie", async () => {
    const r = await request(proxyPort, base + "/", { headers: { cookie: `${COOKIE_NAME}=v1.stale-payload` } });
    assert.equal(r.status, 200, "过期 cookie 不应把首页卡死在 401");
    assert.ok(
      r.setCookie?.some((c) => c.startsWith(`${COOKIE_NAME}=${COOKIE_VALUE}`)),
      "应补发有效 cookie, 让后续 /api 请求也能通过围栏",
    );
  });

  test("代理 cookie 过期 (上游 401): 重新握手并重试一次, 仍返回首页 + Set-Cookie", async () => {
    stub.rejectNextIndex = true;
    const before = stub.seen.paths.length;
    const r = await request(proxyPort, base + "/", { headers: { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}` } });
    assert.equal(r.status, 200, "重握手后应恢复 200");
    assert.ok(
      r.setCookie?.some((c) => c.startsWith(`${COOKIE_NAME}=${COOKIE_VALUE}`)),
      "重换的 cookie 应交给浏览器",
    );
    const seen = stub.seen.paths.slice(before);
    assert.equal(seen.filter((p) => p.startsWith("GET /?token=")).length, 1, "应重新握手一次, 实际: " + JSON.stringify(seen));
    assert.equal(seen.filter((p) => p === "GET /").length, 2, "应重试一次首页请求, 实际: " + JSON.stringify(seen));
  });

  test("上游根绝对 Location 原样透传: base 前缀由外层 code-server 补, 代理不能再补一次", async () => {
    const r = await request(proxyPort, base + "/legacy-redirect");
    assert.equal(r.status, 302);
    assert.equal(r.location, "/", "Location 不得被改写, 否则会变成 " + base + base + "/");
  });

  test("带 cookie 访问首页: 200 HTML, base 标签指向转发子树", async () => {
    const r = await request(proxyPort, base + "/", { headers: { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}` } });
    assert.equal(r.status, 200);
    assert.match(r.body, new RegExp(`<base href="${base}/">`), "base 标签应改写为 base 前缀");
  });

  test("首页内联 boot patch 的探测器表保持原样", async () => {
    const r = await request(proxyPort, base + "/", { headers: { cookie: `${COOKIE_NAME}=${COOKIE_VALUE}` } });
    assert.match(r.body, /"apiPrefix":"\/api\/"/, "apiPrefix 探测常量不应被 base 前缀化");
    assert.match(r.body, /"wsPaths":\["\/api\/remote\.mux"\]/, "wsPaths 探测常量不应被改写");
    assert.match(r.body, new RegExp(`href="${base}/plugins/\\?\\?x/client\\.js`), "preload 的 plugins 引用应被 base 前缀化");
  });

  test("dsh-web-all bundle: remoteChannelRequired 被强制关闭", async () => {
    const r = await request(proxyPort, base + "/plugins/??@linxin666/dsh-web-all/client.js");
    assert.equal(r.status, 200);
    assert.match(
      r.body,
      /function remoteChannelRequired\(hostname, snapshot, hostPairingPolicy\) \{ return false;/,
      "通道总闸应被强制返回 false",
    );
    assert.match(r.body, new RegExp('"/' + base.slice(1) + '/dsh-market/status"'.replace(/\//g, "\\/")), "market 端点应被 base 前缀化");
  });

  test("connection 客户端: 0.1.2 的 isLoopback 字面量被强制为 true", async () => {
    const r = await request(proxyPort, base + "/plugins/??@deepseek-ai/dsh-client-connection/client.js");
    assert.equal(r.status, 200);
    assert.match(r.body, /isLoopback: true,/);
    assert.doesNotMatch(r.body, /isLoopback: transport\?\.ownsHost/);
  });

  test("API 无 cookie 保持 401 透传, 有 cookie 透传 200", async () => {
    const anon = await request(proxyPort, base + "/api/session.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    assert.equal(anon.status, 401);
    const authed = await request(proxyPort, base + "/api/session.list", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${COOKIE_NAME}=${COOKIE_VALUE}` },
    });
    assert.equal(authed.status, 200);
  });
});
