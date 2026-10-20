# CVSE browser RPC client

This Rust/WASM client implements the data adaptation previously provided by Python. The page calls it from `static/js/api.js`. Bindings are generated from `../CVSE-API/CVSE.capnp` during build. Each operation opens a new WebSocket/RPC session, including after an upstream error; writes are never automatically retried.

## Server transport

The browser connects to **same-origin** `ws(s)://<location.host>/rpc`. The `../relay/` crate serves the page and bridges binary WebSocket frames to the fixed CVSE TCP backend without parsing or packing the stream. Frame boundaries are *not* RPC message boundaries. The CVSE backend authorizes writes via the `auth_token` field; read-only connections do not verify credentials. Deploy with authentication and TLS at a trusted reverse proxy if exposing the relay beyond localhost.

## Build

From repository root, use `nix develop` (no rustup or cargo install needed):

```sh
cargo test --locked --manifest-path wasm-client/Cargo.toml
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path wasm-client/Cargo.toml
wasm-bindgen --target web --out-dir static/wasm wasm-client/target/wasm32-unknown-unknown/release/cvse_wasm_client.wasm
```

The root flake provides `capnp`, the WASM Rust standard library and a `wasm-bindgen-cli` matching the pinned `wasm-bindgen` in `Cargo.lock`. The page loads `/static/wasm/cvse_wasm_client.js`; generated files are build artifacts and are ignored by Git.

## JS API

```js
import init, { request } from '/static/wasm/cvse_wasm_client.js';
await init();
const result = await request('getVideos', { date: '2026-10-20', page: 1, page_size: 20 }, null);
const preview = await request('getRankingPreview', {
  rank: 'domestic', index: 1, page: 1, page_size: 20,
  include_special: true, cursor_rank: 1, cursor_offset: 0
}, null);
await request('submitChanges', { changes: [
  { avid: 'av123', bvid: 'BV...', ranks: ['domestic'], is_examined: true,
    is_republish: null, staff_info: null }
]}, authKey);
```

`request(method, params, auth)` returns a Promise of a plain JS object in the same successful response shape as `server.py`, or rejects on error. Supported method names: `getVideos` (`videos`), `getVideo` (`video`; `params` is a BV/AV string or `{bvid: string}`), `getRankingPreview` (`ranking-preview`), `submitChanges` (`submit-changes`), `calculateRankings` (`calculate-rankings`). Parameters use the Python API's snake_case names: `keyword`, `rank`, `examined`, `bvid`, `avid`, `date`, `page`, `page_size`, `is_republish`, `video_id`, `contain_unexamined`, `include_special`, `cursor_rank`, `cursor_offset`, `index`, `lock`, `changes`. Omitted nullable fields in changes are left unchanged; an empty `ranks` array clears inclusion. Numeric counters are JS numbers; values outside JS's safe integer range lose precision, as with JSON responses from the existing server.

Read-only Cap'n Proto methods take no auth token and cannot validate a writing key; only a permitted write can verify credentials. This client has no `health`/`debug` HTTP endpoints, nor a way to cancel an in-flight request. Preview uses one WebSocket session per operation and performs multiple RPC calls on that session. Each later operation opens a fresh session even when the previous RPC failed and the server closed the TCP connection. Failed writes are not replayed automatically.
