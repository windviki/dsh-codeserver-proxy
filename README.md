# dsh-codeserver-proxy

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

## 它还解决的三件事

1. **权限栅栏**。dsh 把一整个特权 RPC 类别（设置 / 凭据 / agent 预设 / 模型发现）限定为 loopback 同源访问，`trustedHosts` 只是 DNS-rebinding 防线、不是认证。代理把每个请求的 `Host` 和 `Origin` 都改写成 loopback 上游的样子，等价于本机浏览器直连，特权功能在 code-server 下同样可用。
2. **dsh-market 重启/下载守卫**。dsh-market 的进程控制端点拒绝任何带转发痕迹（`x-forwarded-*`）的请求。code-server 恰好会加这些头，代理把它们剥离，让「一键重启」在转发环境下也能用。
3. **WebSocket 下行**。`/api/events.mux`、`/api/events.host` 等实时通道以同样的 base 前缀路径透传，101 升级头原样转发（`Sec-WebSocket-Accept` 必须来自上游，浏览器会校验）。

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

> 注意变量用 `PROXY_` 前缀而非 `DSH_`：dsh 启动时会把调用目录当作 cwd 读取 `.env`，而 `DSH_` 前缀是 dsh 保留的启动环境命名空间，出现在 `.env` 里会导致 dsh 拒绝启动。

## 工作原理

- **改写 HTML/JS**：只在 `200` 响应且 `content-type` 为 HTML / JavaScript / Web App Manifest 时执行；把 `"/assets/`、`"/api`、`"/plugins/`、`"/dsh-market/` 等根绝对引用统一加上 base 前缀。base 插在开引号之后，保证改写后的字符串仍是合法 JSON/HTML。
- **通道校验放宽**：dsh 连接层要求 RPC channel 是单段路径（`CHANNEL_PATTERN`），改写后的 `/proxy/<port>/api` 是多段，代理把该正则的字符类放宽以放行改写后的 channel，URL 仍携带 base 前缀。
- **请求头**：`Host`/`Origin` 改写成 loopback 上游；剥离 `hop-by-hop` 头与 `x-forwarded-*` 转发痕迹。
- **错误安全**：上游失联返回 `502`；客户端中途断连、WS 升级失败都不致代理进程崩溃。

## 许可

MIT
