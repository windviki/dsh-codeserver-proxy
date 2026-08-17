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

1. **Privileged-RPC fence.** dsh restricts a whole class of privileged RPC methods (settings / credentials / agent presets / model discovery) to loopback same-origin access; `trustedHosts` is only a DNS-rebinding fence, not authentication. The proxy rewrites each request's `Host` and `Origin` to look like a direct local browser connection to the loopback upstream, so privileged features work under code-server as well.
2. **dsh-market restart/download guards.** dsh-market's process-control endpoints reject any request that carries forwarding traces (`x-forwarded-*`). code-server adds exactly those headers; the proxy strips them so one-click restart works behind the forward.
3. **WebSocket downlinks.** Real-time channels such as `/api/events.mux` and `/api/events.host` pass through with the same base-prefixed path; the `101` upgrade headers are forwarded verbatim (`Sec-WebSocket-Accept` must come from upstream — the browser verifies it).

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

> The variables deliberately use the `PROXY_` prefix instead of `DSH_`: dsh boots with the calling directory as its cwd and reads `.env` from there, and `DSH_`-prefixed names are dsh's reserved bootstrap namespace — if any appear in `.env`, dsh refuses to start.

## How it works

- **HTML/JS rewriting** is applied only to `200` responses with `content-type` of HTML, JavaScript or Web App Manifest. Root-absolute references (`/assets/`, `/api`, `/plugins/`, `/dsh-market/`, `/_dsh/`, manifest, favicon, …) are prefixed with the base path after the opening quote, in both double-quoted, single-quoted and backtick forms, so the rewritten string remains valid JSON/HTML/JS. More specific paths are rewritten before generic prefixes, so a path is never double-prefixed.
- **Everything else streams through untouched** — binaries, SSE, redirects and error responses are piped without being buffered in memory.
- **Channel-validation widening.** dsh's connection layer requires the RPC channel to be a single path segment (`CHANNEL_PATTERN`); after rewriting, `/proxy/<port>/api` is multi-segment. The proxy widens that regex character class to accept `/`, so the rewritten channel passes validation while the URL still carries the base prefix.
- **Request headers.** `Host`/`Origin` are rewritten to the loopback upstream; hop-by-hop headers and `x-forwarded-*` forwarding traces are stripped.
- **Error safety.** An unreachable upstream returns `502`; client disconnects, RSTs and failed WS upgrades are handled without crashing the process.
- **Graceful shutdown.** `SIGINT`/`SIGTERM` close the listener and terminate a spawned `dsh web`, so no orphan process is left behind.

## License

MIT
