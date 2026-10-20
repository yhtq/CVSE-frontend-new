# CVSE 收录管理前端

用于稿件收录、榜单预览校审和批量修改。浏览器通过 Rust/WASM 完成 Cap’n Proto RPC 编解码及数据适配；同源 Rust WebSocket 服务只把二进制字节流转发给现有 CVSE TCP RPC 后端，不解析请求。网页需要先构建 WASM。

## 部署包（无需在目标机安装 Nix）

在仓库根目录构建（`?submodules=1` 会按 Git 记录的提交获取 `CVSE-API/` 子模块；新文件须先加入 Git 索引，Nix 才能在 Git flake 中看到它们）：

```bash
nix build '.?submodules=1#default'
cp -rL result /tmp/cvse-deployment
/tmp/cvse-deployment/bin/cvse-relay
```

构建结果 `result/` 包含静态链接的 `bin/cvse-relay`、`share/cvse-frontend/index.html`、完整的 `static/` 和编译好的 WASM。**搬迁时必须复制整个目录**（不能只复制 `bin/` 或 Nix 的 `result` 符号链接）；在相同 CPU 架构的另一台 Linux 上执行 `bin/cvse-relay`，无需 Nix 或动态 libc。也可分别构建 `.#relay` 和 `.#wasm`，但迁移请使用包含全部资源的 `#default`。

### 单进程启动与访问

`cvse-relay` 本身就是 Rust Web server：启动**这一个进程**后，同一监听端口提供 `GET /`（页面）、`GET /static/*`（CSS、JavaScript、图片和 WASM），以及 `GET /rpc`（WebSocket，与固定的 RPC TCP 后端双向转发）。**无需另起静态文件服务或单独启动 relay 进程。**默认监听 `127.0.0.1:25126`，可直接访问 [http://127.0.0.1:25126/](http://127.0.0.1:25126/)；目标机须能连接 RPC 后端的 TCP 端口。

可用 `CVSE_RELAY_LISTEN`、`CVSE_RELAY_UPSTREAM`、`CVSE_RELAY_ORIGIN` 配置监听、上游和浏览器来源。`CVSE_RPC_RATE_LIMIT` 配置全部用户共享的 `/rpc` 新连接限速（默认每秒 10 次），超过上限返回 HTTP 429；它不统计一条连接内部的 RPC 方法次数。如果调整包内目录布局，可用 `CVSE_RELAY_ROOT` 指向包含 `index.html` 和 `static/` 的目录。公网部署仍须 TLS 反向代理和身份认证：将 `/`、`/static/*` 和支持 WebSocket Upgrade 的 `/rpc` **一起**代理到同一监听端口，并将 `CVSE_RELAY_ORIGIN` 设置为外部 HTTPS 来源；详见 [relay 说明](relay/README.md)。

每次向任意分支推送提交，[发布工作流](.github/workflows/release.yml) 都会运行 Nix 构建，并以该提交 SHA 自动创建 `build-<sha>` 预发布版本（无需手动打标签），附加 `cvse-frontend-linux-x86_64.tar.gz`。下载后解压并运行 `cvse-frontend/bin/cvse-relay`；压缩包包含网页和 WASM，不需要在部署机器上构建。仓库的 Actions 工作流需要 `contents: write` 权限才能创建 Release。

## 本地开发

需要启用 Nix flakes；Rust 编译器（含 `wasm32-unknown-unknown` 标准库）、Cargo、`capnp`、与锁定版本匹配的 `wasm-bindgen-cli` 及 Node 均由根目录 `flake.nix` 提供，不需要 `rustup`。

```bash
git submodule update --init --recursive
nix develop
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path wasm-client/Cargo.toml
wasm-bindgen --target web --out-dir static/wasm wasm-client/target/wasm32-unknown-unknown/release/cvse_wasm_client.wasm
cargo run --locked --release --manifest-path relay/Cargo.toml
```

启动后访问 [http://127.0.0.1:25126](http://127.0.0.1:25126)。`static/wasm/` 是构建输出，不提交到仓库；每次更新 WASM 源码或 schema 后要重新构建。`relay/` 默认只监听本机，并连接 `47.104.91.74:8663`，可通过 `CVSE_RELAY_LISTEN`、`CVSE_RELAY_UPSTREAM`、`CVSE_RELAY_ORIGIN` 配置，参见 [relay 说明](relay/README.md)。浏览器请求经同源 `/rpc` WebSocket 中继；部署到 HTTPS 域名时，须用 TLS 反向代理提供 WSS 并设置准确的 `CVSE_RELAY_ORIGIN`。后端 TCP 仍为明文，不宜通过不可信网络传递密钥。

## 使用说明

### 实时收录

- 按日期、关键词、AV/BV 号、期刊、收录状态和搬运标记筛选。期刊支持多选，满足任一所选类别即可显示。
- “其他（无归属）”指尚未审核且没有期刊归属的稿件；“排除”指已审核且没有期刊归属的稿件。
- “清除筛选”恢复当天、清空筛选并回到第一页，保留每页条数、布局和待提交修改。
- 可以逐条编辑，或勾选后批量收录、排除。排除不会删除稿件，也不会清除搬运和 Staff 信息。

### 预览校审

- 选择类别和期数，读取后端已有的榜单结果。查询、翻页和提交修改不会自动重新计算榜单。
- 支持上一页、下一页，每页可选 10、20、50、80、100、120 条，以及当前类别和期数内的完整 AV/BV 号搜索。
- 修改类别、期数或每页条数后，点击“预览 / 搜索”再读取数据；修改条件不会自动请求后端。
- 显示稿件时长、数据指标和收录状态。仅名次为 0 的 HOT/SH 使用特殊标签并默认隐藏，勾选后仅在第一页展示；非零名次始终显示数字排名。精确搜索命中的 HOT/SH 稿件仍可显示。
- 预览按需读取当前页，不加载整期编号，也不提供页码跳转。翻页失败会保留当前页，可再次点击分页按钮重试。加载失败不会自动重试或重算；重算开销较大，仅在确有需要时手动发起。

### 修改与提交

编辑后点击“保存到本地”，修改进入当前页面的待提交队列；确认“提交更改”后才写入后端。队列中的修改可以逐条撤销或全部清空。关闭编辑面板会放弃该面板尚未保存的草稿。

写入需要在设置中填写有效密钥，由真实后端校验。匿名查询成功不代表密钥具有写入权限。

### 手机与外观

支持浅色、深色和跟随系统，默认跟随系统，手动选择会保存到浏览器。

手机端筛选条件可折叠；选择稿件后，顶部单行批量操作栏吸顶，“更多”中提供全选和清空选择。底部待提交栏默认折叠，点击“查看”展开改动列表，点击遮罩或下滑面板顶部收起。编辑时隐藏上下操作栏。

## 部署与安全

中继没有 HTTP `/api/*` 接口，也不读取或保存 API Key；WASM 仅在写入 RPC 的 `auth_token` 字段传递浏览器保存的密钥。只读 RPC 不验证写入权限，设置中的“验证”无法确定密钥是否有效；写入权限由 RPC 后端检查。中继严格检查浏览器 `Origin` 和 `Host`，但这**不是身份认证**：开放公网前须在可信 TLS 反向代理处实施用户身份认证、访问限制和限流，确保 WebSocket Upgrade 及静态资源使用相同域名。中继到 RPC 后端仍是明文 TCP。详见 [relay 说明](relay/README.md)。

**连接恢复：**每次页面操作建立新的 WebSocket 和上游 TCP 连接，完成或失败后关闭；失败的 RPC 可能令后端立即关闭 TCP，但后续操作会创建新连接。不会自动重放写入请求（失败时后端可能已执行部分操作），请核对后端状态后手动重试。

## 开发

| 路径 | 内容 |
| --- | --- |
| `index.html` | 页面结构 |
| `static/` | 样式、交互脚本与图片 |
| `wasm-client/` | Rust/WASM Cap’n Proto 客户端与页面数据适配 |
| `relay/` | 静态文件服务与二进制 WebSocket ↔ TCP 中继 |
| `CVSE-API/CVSE.capnp` | RPC schema（直接子模块） |
| `tests/` | 前端单元及浏览器测试 |

测试命令、预览分页和请求限制见 [开发说明](docs/development.md)。
