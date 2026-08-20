// Integration test for the RPC-readiness guard in proxy.js.
//
// The dsh web HTTP server is up (with its static-files fallback) before its RPC
// channel `/api` is registered, so a POST /api/* in that window answers 405 —
// which the frontend treats as a fatal Method Not Allowed and never retries.
// The proxy must instead answer 503 (with retry-after) while the channel is not
// live, keep probing, and transparently proxy again once dsh is ready.
//
// The test boots a stub upstream that starts "not ready" (405 on /api/* POSTs)
// and flips to ready (200) on demand, plus a real proxy.js child pointed at it.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROXY_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "proxy.js");
const PROBE_METHOD = "host.describe";

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

function jsonRpc(method, payload = {}) {
  return {
    type: "client-request",
    rpcId: "it:" + method + ":" + Math.random().toString(36).slice(2),
    method,
    payload,
  };
}

function rpcOk(value) {
  return JSON.stringify({ type: "server-response", rpcId: "x", result: { ok: true, value } });
}

// Stub upstream: mirrors the relevant dsh behavior.
class StubUpstream {
  constructor(port) {
    this.port = port;
    this.ready = false;
    this.seen = { headers: [], paths: [] };
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      this.seen.headers.push({ host: req.headers.host, origin: req.headers.origin, method: req.method });
      this.seen.paths.push(url.pathname);
      if (url.pathname.startsWith("/assets/")) {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end("/* stub */");
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        if (!this.ready) {
          res.writeHead(405, { "content-type": "text/plain" });
          res.end("method not allowed");
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const parsed = JSON.parse(body);
          if (parsed.method === PROBE_METHOD) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(rpcOk({ name: "stub", version: "it" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(rpcOk({ items: [{ sessionId: "s1" }] }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
  }
  listen() {
    return new Promise((resolve) => this.server.listen(this.port, "127.0.0.1", resolve));
  }
  setReady(v) {
    this.ready = v;
  }
  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

function fetchStatus(port, pathname, { method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(jsonRpc("session.list"));
    const headers = { "content-type": "application/json" };
    if (method === "POST") headers["content-length"] = Buffer.byteLength(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, retryAfter: res.headers["retry-after"] }));
      },
    );
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}

function waitForStatus(port, pathname, want, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetchStatus(port, pathname);
        if (r.status === want) return resolve(r);
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${want} on ${pathname}`));
      setTimeout(tick, 200);
    };
    tick();
  });
}

describe("proxy.js RPC-readiness guard", () => {
  let stubPort;
  let proxyPort;
  let stub;
  let proxy;

  before(async () => {
    stubPort = await freePort();
    proxyPort = await freePort();
    stub = new StubUpstream(stubPort);
    await stub.listen();
    proxy = spawn(process.execPath, [PROXY_JS], {
      env: {
        ...process.env,
        PROXY_PORT: String(proxyPort),
        PROXY_UPSTREAM_HOST: "127.0.0.1",
        PROXY_UPSTREAM_PORT: String(stubPort),
        PROXY_SPAWN_DSH: "0",
        PROXY_BASE: "/proxy/" + proxyPort,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    proxy.stderr.on("data", (d) => (err += d));
    // Wait for the proxy listener (connection refused -> reset state).
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

  test("未就绪时 POST /api/* 返回 503 而不是 405", async () => {
    const r = await fetchStatus(proxyPort, "/proxy/" + proxyPort + "/api/session.list");
    assert.equal(r.status, 503);
    assert.match(r.body, /starting up/);
    assert.equal(r.retryAfter, "2");
  });

  test("静态资源 GET 不受影响,正常透传", async () => {
    const r = await fetchStatus(proxyPort, "/proxy/" + proxyPort + "/assets/app.js", { method: "GET" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "/* stub */");
  });

  test("就绪后 POST /api/* 透明透传 200", async () => {
    stub.setReady(true);
    const r = await waitForStatus(proxyPort, "/proxy/" + proxyPort + "/api/session.list", 200, 6000);
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('"sessionId":"s1"'));
  });

  test("转发给上游的请求被重写为 loopback Host 与 Origin", () => {
    const seen = stub.seen.headers.find((h) => h.method === "POST" && h.host === "127.0.0.1:" + stubPort);
    assert.ok(seen, "应有 POST 请求以 loopback Host 到达上游, 实际: " + JSON.stringify(stub.seen.headers.slice(-3)));
  });
});
