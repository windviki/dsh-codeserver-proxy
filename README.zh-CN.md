# dsh-codeserver-proxy

[English](README.md) | **中文**

Base-path 适配代理：让 [dsh](https://github.com/deepseek-ai/dsh)（DeepSeek Harness）的官方 Web UI，能在**自部署的 code-server** 的端口转发下正常工作，浏览器里一点即达。

```
你的浏览器
   │  https://code.your-host/proxy/3100/
   ▼
code-server  (端口转发: 把 /proxy/3100/ 转发到本机 127.0.0.1:3100)
   ▼
dsh-codeserver-proxy   (本工程: 监听 3100, 转发 + 重写)
   ▼
dsh web                (官方 UI, 绑定 127.0.0.1:3000)
```

## 背景：为什么要这个代理

dsh 的 `dsh web` 是**本地优先**的 Web 服务：

- 它只绑定 loopback（`127.0.0.1:3000`），默认只给本机浏览器用；
- 它输出的前端资源全部是**根绝对路径**（`/assets/...`、`/api/...`、`/plugins/...`、`/dsh-market/...`）。

而 code-server 的端口转发把服务挂载在 `https://host/proxy/<port>/` 这个**子路径**下。于是浏览器打开转发地址后，页面里的 `/assets/...` 会被解析到 `https://host/assets/...`（主机根路径）而不是 `/proxy/<port>/assets/...`，整个 SPA 根本加载不出来。

本工程就是架在两者之间的适配器：**它转发一切到 dsh，同时把 dsh 吐出的 HTML/JS 里每个根绝对引用改写上 `/proxy/<port>/` 前缀**，让 UI 在 code-server 下开箱即用。除此之外，UI 的字节保持不变。

## 它还解决的五件事

1. **dsh 0.1.2 启动 token 认证**。dsh 0.1.2-rc.1 起整个 Web UI（首页 + 所有 `/api` RPC）都被一道浏览器 cookie 围栏保护，只有带上启动 URL 里的一次性 `?token=` 才能换取（loopback 也不例外）。代理从 spawn 的 `dsh web` stdout 自动捕获 token（dsh 外部托管时用 `PROXY_DSH_TOKEN`），并在浏览器无 cookie 首次进入时代为完成握手：浏览器收到 303 + `Set-Cookie`（Location 已加 base 前缀），打开 `/proxy/<port>/` 依旧一点即达。cookie 绑定代理伪装的 loopback authority，有效期 30 天。
2. **权限栅栏**。dsh 把一整个特权 RPC 类别（设置 / 凭据 / agent 预设 / 模型发现）限定为 loopback 同源访问，`trustedHosts` 只是 DNS-rebinding 防线、不是认证。代理把每个请求的 `Host` 和 `Origin` 都改写成 loopback 上游的样子，等价于本机浏览器直连，特权功能在 code-server 下同样可用。客户端侧同时强制 `isLoopback` 为 true（0.1.2 的内联 boot patch 在非 loopback 页面会设置 `__DSH_TRANSPORT__.ownsHost`，字面量补丁覆盖其不生效的场景）。
3. **dsh-market 重启/下载守卫**。dsh-market 的进程控制端点拒绝任何带转发痕迹（`x-forwarded-*`）的请求。code-server 恰好会加这些头，代理把它们剥离，让「一键重启」在转发环境下也能用。
4. **WebSocket 下行**。0.1.2 的 `/api/remote.mux` 实时通道以及插件终端（如 `/sidebar/ws/*`）以同样的 base 前缀路径透传，`101` 升级头原样转发（`Sec-WebSocket-Accept` 必须来自上游，浏览器会校验）。
5. **remote 通道中和**。`@linxin666/dsh-remote-web-ui` 0.3.17 编入共享的 `dsh-web-all` bundle，会安装 fetch/WebSocket 补丁把探测器命中的请求改道 `/remote` —— 该路径经 code-server 一跳根本不可达。改写层在代理输出的副本里强制其 `remoteChannelRequired()` 总闸关闭，等效于旧版本「字节级豁免」带来的 inert 行为。

## 快速开始

前置要求：

- Node.js >= 18
- 已安装 `dsh` CLI（本代理可以替你拉起 `dsh web`；或者你自己单独起好 dsh）
- 一个自部署的 code-server，并配置好端口转发

### 1. 配置

```bash
cp .env.example .env
# 按需编辑 .env
```

### 2. 启动

```bash
node proxy.js
```

代理默认监听 `3100`。若上游 `127.0.0.1:3000` 没有 dsh，它会自动 `spawn` 一个 `dsh web --port 3000`。

### 3. 在 code-server 里开启端口转发

在 code-server 中把本机端口 `3100` 转发出去，转发地址形如：

```
https://code.your-host/proxy/3100/
```

浏览器打开这个地址即进入 dsh Web UI。

## 配置项

所有配置可通过环境变量或 `.env` 设置（`.env` 已 gitignore，请勿提交）。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROXY_BASE` | `/proxy/3100` | 代理在 code-server 下被访问的 base 路径，即端口转发挂载的子树 |
| `PROXY_PORT` | `3100` | 代理自己监听的端口 |
| `PROXY_UPSTREAM_HOST` | `127.0.0.1` | dsh web 所在主机 |
| `PROXY_UPSTREAM_PORT` | `3000` | dsh web 端口 |
| `PROXY_SPAWN_DSH` | `1` | 设为 `0` 时不自动拉起 dsh（例如 dsh 由 systemd/pm2 托管） |
| `PROXY_DSH_TOKEN` | — | dsh ≥ 0.1.2 的启动 token，仅在 dsh 外部托管时需要；从 `dsh web` 打印的 URL 里复制。代理自己 spawn dsh 时会自动从 stdout 捕获 |

> 注意变量用 `PROXY_` 前缀而非 `DSH_`：dsh 启动时会把调用目录当作 cwd 读取 `.env`，而 `DSH_` 前缀是 dsh 保留的启动环境命名空间，出现在 `.env` 里会导致 dsh 拒绝启动。

## 工作原理

- **改写 HTML/JS**：只在 `200` 响应且 `content-type` 为 HTML / JavaScript / Web App Manifest 时执行。dsh 0.1.2 的首页改用相对路径引用资源并注入 `<base href="/">`，代理把这个 base 指向转发子树，相对资源随之归位；JS 里的根绝对引用（`/api`、`/plugins`、`/dsh-market/`、`/_dsh/`、`/sidebar/`、`/git/`、`/pet/` 等）则在开引号之后统一加上 base 前缀，双引号、单引号、反引号三种形式都覆盖，保证改写后的字符串仍是合法 JSON/HTML/JS。更具体的路径先于通用前缀改写，因此不会出现二次加前缀。内联 remote-channel boot patch 的探测表（`"/api/"`、`"/sidebar/"` 等）刻意保持原样 —— base 路径下探测永不命中，补丁自然 inert。
- **其余响应零缓冲透传**：二进制、SSE、错误响应等直接管道转发，不整包缓冲进内存。根绝对路径的重定向 `Location` 头会补上 base 前缀（token 握手的 `303 → /` 即此场景）。
- **通道校验放宽**：dsh 连接层要求 RPC channel 是单段路径（`CHANNEL_PATTERN`），改写后的 `/proxy/<port>/api` 是多段，代理把该正则的字符类放宽以放行改写后的 channel，URL 仍携带 base 前缀。
- **请求头**：`Host`/`Origin` 改写成 loopback 上游；剥离 `hop-by-hop` 头与 `x-forwarded-*` 转发痕迹。
- **错误安全**：上游失联返回 `502`；客户端中途断连、RST、WS 升级失败都不致代理进程崩溃。
- **优雅退出**：收到 `SIGINT`/`SIGTERM` 时关闭监听并结束由代理拉起的 `dsh web`，不留孤儿进程。

## 许可

MIT
