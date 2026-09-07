# dsh-codeserver-proxy

**English** | [中文](README.zh-CN.md)

Base-path adapter so the official [dsh](https://github.com/deepseek-ai/dsh) (DeepSeek Harness) web UI works behind a **self-hosted code-server**'s port forwarding — one click in the browser, no manual URL fixing.

```
Your browser
   │  https://code.your-host/proxy/3100/
   ▼
code-server  (port forwarding: /proxy/3100/ -> 127.0.0.1:3100 on the host)
   ▼
dsh-codeserver-proxy   (this project: listens on 3100, forwards + rewrites)
   ▼
dsh web                (official UI, bound to 127.0.0.1:3000)
```

## Why this proxy exists

`dsh web` is a **local-first** web service:

- it only binds loopback (`127.0.0.1:3000`), intended for a local browser;
- the frontend resources it serves are all **root-absolute paths** (`/assets/...`, `/api/...`, `/plugins/...`, `/dsh-market/...`).

code-server's port forwarding mounts the service under a **sub-path** — `https://host/proxy/<port>/`. When the browser loads the forwarded address, those `/assets/...` references resolve to `https://host/assets/...` (the host root) instead of `/proxy/<port>/assets/...`, so the SPA never loads.

This project is the adapter in between: **it forwards everything to dsh and rewrites every root-absolute reference in the HTML/JS served by dsh with a `/proxy/<port>/` prefix**, so the UI works out of the box under code-server. Apart from that, the UI bytes are untouched.

## What else it fixes

1. **dsh 0.1.2 launch-token authentication.** dsh 0.1.2-rc.1 fences the entire web UI — the index and every `/api` RPC — behind a browser cookie that is only issued when the launch URL's one-time `?token=` is presented (loopback included). The proxy captures the token from the spawned `dsh web` stdout (or `PROXY_DSH_TOKEN` when dsh is supervised externally) and runs the handshake server-side on a cookie-less entry: the browser gets the 303 + `Set-Cookie` (Location base-prefixed), so opening `/proxy/<port>/` keeps working with one click. The cookie is authority-bound to the loopback upstream the proxy already impersonates, and lasts 30 days.
2. **Privileged-RPC fence.** dsh restricts a whole class of privileged RPC methods (settings / credentials / agent presets / model discovery) to loopback same-origin access; `trustedHosts` is only a DNS-rebinding fence, not authentication. The proxy rewrites each request's `Host` and `Origin` to look like a direct local browser connection to the loopback upstream, so privileged features work under code-server as well. On the client side the `isLoopback` flag is forced true (dsh 0.1.2's inlined boot patch sets `__DSH_TRANSPORT__.ownsHost` on non-loopback pages; the literal patch covers the cases where it doesn't run).
3. **dsh-market restart/download guards.** dsh-market's process-control endpoints reject any request that carries forwarding traces (`x-forwarded-*`). code-server adds exactly those headers; the proxy strips them so one-click restart works behind the forward.
4. **WebSocket downlinks.** Real-time channels (0.1.2's `/api/remote.mux`, plus plugin terminals such as `/sidebar/ws/*`) pass through with the same base-prefixed path; the `101` upgrade headers are forwarded verbatim (`Sec-WebSocket-Accept` must come from upstream — the browser verifies it).
5. **Remote-channel neutralisation.** `@linxin666/dsh-remote-web-ui` 0.3.17 compiles into the shared `dsh-web-all` bundle and installs a fetch/WebSocket patch that reroutes its detector matches under `/remote` — unreachable through the code-server hop. The rewrite layer forces its `remoteChannelRequired()` gate off in the proxy-served copy, which reproduces exactly the inert behaviour the byte-for-byte exclusion produced on older dsh versions.

## Quick start

Prerequisites:

- Node.js >= 18
- the `dsh` CLI installed (the proxy can spawn `dsh web` for you; alternatively run dsh yourself)
- a self-hosted code-server with port forwarding configured

### 1. Configure

```bash
cp .env.example .env
# edit .env if needed
```

### 2. Start

```bash
node proxy.js
```

The proxy listens on `3100` by default. If no dsh is reachable at `127.0.0.1:3000`, it automatically spawns `dsh web --port 3000`.

### 3. Forward the port in code-server

Forward host port `3100` in code-server. The forwarding address looks like:

```
https://code.your-host/proxy/3100/
```

Open that address in a browser to enter the dsh web UI.

## Configuration

All settings can be provided via environment variables or a `.env` file (`.env` is gitignored — never commit it).

| Variable | Default | Description |
| --- | --- | --- |
| `PROXY_BASE` | `/proxy/3100` | Base path under which the proxy is reached on code-server, i.e. the forwarded subtree |
| `PROXY_PORT` | `3100` | Port the proxy itself listens on |
| `PROXY_UPSTREAM_HOST` | `127.0.0.1` | Host where dsh web is running |
| `PROXY_UPSTREAM_PORT` | `3000` | Port of dsh web |
| `PROXY_SPAWN_DSH` | `1` | Set to `0` to disable auto-spawning dsh (e.g. when dsh is managed by systemd/pm2) |
| `PROXY_DSH_TOKEN` | — | dsh ≥ 0.1.2 launch token, for externally managed dsh only; copied from `dsh web`'s printed URL. Auto-captured from stdout when the proxy spawns dsh itself |

> The variables deliberately use the `PROXY_` prefix instead of `DSH_`: dsh boots with the calling directory as its cwd and reads `.env` from there, and `DSH_`-prefixed names are dsh's reserved bootstrap namespace — if any appear in `.env`, dsh refuses to start.

## How it works

- **HTML/JS rewriting** is applied only to `200` responses with `content-type` of HTML, JavaScript or Web App Manifest. dsh 0.1.2 serves its index with relative references plus an injected `<base href="/">`; the proxy repoints that base at the forwarded subtree so every relative asset resolves under it, while root-absolute references in served JS (`/api`, `/plugins`, `/dsh-market/`, `/_dsh/`, `/sidebar/`, `/git/`, `/pet/`, …) are prefixed with the base path after the opening quote, in double-quoted, single-quoted and backtick forms, so the rewritten string remains valid JSON/HTML/JS. More specific paths are rewritten before generic prefixes, so a path is never double-prefixed. The inline remote-channel boot patch's detector table (`"/api/"`, `"/sidebar/"`, …) is deliberately left untouched — its matches stay empty under the base path, keeping the patch inert.
- **Everything else streams through untouched** — binaries, SSE, redirects and error responses are piped without being buffered in memory. Redirect `Location` headers that are root-absolute get the base prefix (the token handshake's `303 → /` is the known case).
- **Channel-validation widening.** dsh's connection layer requires the RPC channel to be a single path segment (`CHANNEL_PATTERN`); after rewriting, `/proxy/<port>/api` is multi-segment. The proxy widens that regex character class to accept `/`, so the rewritten channel passes validation while the URL still carries the base prefix.
- **Request headers.** `Host`/`Origin` are rewritten to the loopback upstream; hop-by-hop headers and `x-forwarded-*` forwarding traces are stripped.
- **Error safety.** An unreachable upstream returns `502`; client disconnects, RSTs and failed WS upgrades are handled without crashing the process.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` close the listener and terminate a spawned `dsh web`, so no orphan process is left behind.

## License

MIT
