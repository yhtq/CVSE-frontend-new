# CVSE native relay

`cvse-relay` 是**单进程 Rust Web server**：启动它即可同时提供 `GET /` 页面、`GET /static/*`（含 WASM）和 `GET /rpc` WebSocket 中继，三者共用同一监听端口。不需要另起一个静态文件服务，也不需要单独启动 relay 子进程。`/rpc` 将 WebSocket Binary 消息与 CVSE 原始 TCP 字节流双向转发，不解析、修改或验证 Cap'n Proto / CVSE 消息；不提供 `/api/*`。

## 构建、运行、验证

先在仓库根目录按 [README](../README.md) 使用 `nix develop` 构建 WASM，然后运行：

```sh
cargo test --locked --manifest-path relay/Cargo.toml
cargo run --locked --release --manifest-path relay/Cargo.toml
```

Rust、Cargo、WASM 标准库、`capnp` 和 `wasm-bindgen-cli` 均由根目录 `flake.nix` 提供，无需 rustup。

默认监听 `127.0.0.1:25126`，固定连接 `47.104.91.74:8663`；浏览器页面地址为 `http://127.0.0.1:25126/`，WebSocket 地址为 `ws://127.0.0.1:25126/rpc`。可在启动进程时设置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CVSE_RELAY_LISTEN` | `127.0.0.1:25126` | IP:端口；非本机地址须显式设置 Origin |
| `CVSE_RELAY_UPSTREAM` | `47.104.91.74:8663` | 启动时确定的 CVSE TCP IP:端口；客户端不能更改 |
| `CVSE_RELAY_ORIGIN` | `http://<监听IP:端口>` | 浏览器确切来源，例如 `https://example.org`；Host 必须与该来源的 authority 一致 |
| `CVSE_RELAY_ROOT` | 自动查找 | 可选资源根目录，须包含 `index.html` 与 `static/`；完整部署包默认自动使用 `bin/../share/cvse-frontend` |

示例（仅在受信任的 TLS 反向代理后开放；代理应正确传递 Host 与 Origin）：

```sh
CVSE_RELAY_LISTEN=127.0.0.1:25126 CVSE_RELAY_ORIGIN=https://example.org cargo run --release
```

完整部署包可从 `nix build '.?submodules=1#default'` 获得，复制包内所有内容到其他同架构 Linux 后直接运行 `bin/cvse-relay`；relay 采用 musl 静态链接，资源路径相对于程序位置，不嵌入构建机路径。开发时 `cargo run` 会使用项目根目录资源。部署时应保持包内相对目录结构，且不得让不可信用户写入静态资源。静态路径只允许非隐藏的 ASCII 字母数字、点、短横线、下划线组成的段；不支持目录列表、动态文件名中的空格/中文、Range 请求、缓存或热更新入口路径。`index.html` 仅通过 `/` 提供。静态目录采用 capability 文件系统访问，无法借助符号链接逃出 `static/`；单文件最多 8 MiB。

仅接受与配置值**完全相同**的 WebSocket `Origin`（必须存在、只能有一个）及 `Host`；不支持跨域、`null` Origin 或在代理后通过 `X-Forwarded-*` 推断来源。静态请求同样检查 Host，若带 Origin 也须匹配。不接受请求体、查询参数或客户端提供的上游地址。最多 16 个并发转发、32 个并发文件读取、128 个并发入站 HTTP 连接；额外请求/连接直接拒绝。HTTP 头读取限时 5 秒，头缓冲区 16 KiB，HTTP 连接最多 30 秒且不复用；上游连接和每次写操作限时 10 秒，静态读取等待最多 10 秒，WebSocket/TCP 双向无活动 60 秒断开。WebSocket 单条消息/帧最多 1 MiB，文本帧关闭连接，TCP 数据按读取块（最多 16 KiB）送为二进制消息；**不保证 WebSocket 消息边界等于 CVSE 协议边界**。

**限制：**页面已通过 WASM 使用 `/rpc`，但必须先构建 `static/wasm/`。relay 没有应用级身份验证或写权限检查，实际权限由 CVSE 后端控制；暴露到公网前应增加可信反向代理的 TLS、认证及访问控制。浏览器到代理可使用 WSS，但 relay 到上游始终是**明文 TCP**，不要经不可信网络发送敏感信息。Origin 检查是浏览器防跨站机制，不是非浏览器客户端的认证。每次新 WebSocket 对应新上游 TCP；请求失败后关闭旧连接，下一次页面操作重新连接，不自动重放写入。

`nix develop` 内直接运行上述 `cargo` 命令即可；如需一次性运行也可使用 `nix develop --command cargo test --locked --manifest-path relay/Cargo.toml`。
