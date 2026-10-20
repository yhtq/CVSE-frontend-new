# 开发说明

## 本地检查

先按 [README](../README.md) 初始化根目录的 `CVSE-API/` 子模块、进入 `nix develop` 并构建 WASM。所有 Rust 工具链和生成工具都由根目录 flake 提供，无需 `rustup` 或 `cargo install`。

```bash
cargo test --locked --manifest-path wasm-client/Cargo.toml
cargo test --locked --manifest-path relay/Cargo.toml
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path wasm-client/Cargo.toml
wasm-bindgen --target web --out-dir static/wasm wasm-client/target/wasm32-unknown-unknown/release/cvse_wasm_client.wasm
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

浏览器测试使用拦截的 WASM 调用，不需要连接真实 RPC 后端；`tests/mock_server.cjs` 只用于旧版模拟界面，不能作为 `/rpc` 中继。实际端到端验证仍须在允许连接 CVSE TCP 后端的环境中进行，**不要**对生产数据库运行写入测试。

## RPC 与连接恢复

`wasm-client/src/transport.rs` 将 WebSocket 二进制帧作为**无额外帧头的有序字节流**交给 Cap’n Proto TwoParty RPC；`relay/` 不解析、解密或缓存这些字节。WS 帧边界不是 Cap’n Proto 消息边界。每个页面操作都新开一个 WebSocket，并由中继新开一个 TCP 连接。某次 RPC 失败导致后端关闭 TCP 后，下一次操作不会复用失效连接；由于写操作失败前可能已被后端执行，不进行自动重试。

## 预览分页

预览不读取整期详情；按游标查询当前名次区间，并保留并列名次内的偏移。名次可能并列且跳号，不能用名次当行号。单页最多 120 条；HOT/SH 使用单独的 `[0, 1)` 查询，详情最多 100 条。已有 RPC 不能对极大并列组的编号响应设置上限。完整 AV/BV 搜索直接查指定编号，不扫描整期。浏览器切换条件可忽略旧请求的响应，但无法中止已发起的 RPC；中继会在连接关闭或空闲超时后回收。

## 部署核对

运行 `nix build '.?submodules=1#default'` 构建完整的静态 relay + WASM 资源包；`?submodules=1` 是必需的，schema 从 Git 指针指定的 `CVSE-API/` 获取，flake 没有额外的 schema 输入。将 `result` 指向的**整个目录**复制到目标机，并保持 `bin/` 与 `share/` 的相对位置。首先确认 `static/wasm/cvse_wasm_client.js` 和 `static/wasm/cvse_wasm_client_bg.wasm` 已由当前 schema 和源码构建并可被同源静态服务读取；页面应从 `/rpc` 建立 WS/WSS 连接，而非请求 `/api/*`。在权限允许的环境核对一次只读查询和失败后的下一次只读查询；不要因只读成功就认为写入密钥有效。部署时的 TLS、Origin 与上游地址限制参见 [relay 说明](../relay/README.md)。
