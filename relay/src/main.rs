use std::{
    collections::VecDeque,
    env,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use cap_std::{ambient_authority, fs::Dir};
use futures_util::{SinkExt, StreamExt};
use hyper::server::conn::http1;
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{OwnedSemaphorePermit, Semaphore},
    time::{self, Instant},
};

const MAX_ASSET: u64 = 8 * 1024 * 1024;
const MAX_MESSAGE: usize = 1024 * 1024;
const MAX_FRAME: usize = 1024 * 1024;
const IDLE: Duration = Duration::from_secs(60);
const IO_TIMEOUT: Duration = Duration::from_secs(10);

struct Config {
    listen: SocketAddr,
    upstream: SocketAddr,
    origin: String,
    authority: String,
    rpc_rate_limit: u32,
}

fn parse_rpc_rate_limit(value: &str) -> Result<u32, &'static str> {
    value
        .parse::<u32>()
        .ok()
        .filter(|limit| *limit > 0)
        .ok_or("CVSE_RPC_RATE_LIMIT must be a positive integer (connections per second)")
}

impl Config {
    fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let listen: SocketAddr = env::var("CVSE_RELAY_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:25126".into())
            .parse()?;
        let upstream: SocketAddr = env::var("CVSE_RELAY_UPSTREAM")
            .unwrap_or_else(|_| "47.104.91.74:8663".into())
            .parse()?;
        let origin = env::var("CVSE_RELAY_ORIGIN").unwrap_or_else(|_| format!("http://{listen}"));
        let uri: Uri = origin.parse()?;
        if !matches!(uri.scheme_str(), Some("http" | "https"))
            || uri.authority().is_none()
            || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
            || origin.ends_with('/')
            || origin.contains('@')
            || origin.contains('#')
        {
            return Err("CVSE_RELAY_ORIGIN must be an exact http(s) origin without path, credentials or trailing slash".into());
        }
        let authority = uri.authority().unwrap().as_str().to_owned();
        let rpc_rate_limit = match env::var("CVSE_RPC_RATE_LIMIT") {
            Ok(value) => parse_rpc_rate_limit(&value)?,
            Err(env::VarError::NotPresent) => 10,
            Err(error) => return Err(Box::new(error)),
        };
        if !listen.ip().is_loopback() && env::var_os("CVSE_RELAY_ORIGIN").is_none() {
            return Err("non-loopback listen requires explicit CVSE_RELAY_ORIGIN".into());
        }
        Ok(Self {
            listen,
            upstream,
            origin,
            authority,
            rpc_rate_limit,
        })
    }
}

// One window for the entire process: never key RPC admission by IP or user.
struct RpcRateLimiter {
    limit: u32,
    attempts: Mutex<VecDeque<Instant>>,
}

impl RpcRateLimiter {
    fn new(limit: u32) -> Self {
        Self {
            limit,
            attempts: Mutex::new(VecDeque::new()),
        }
    }

    fn allow(&self, now: Instant) -> bool {
        let mut attempts = self.attempts.lock().expect("RPC rate limiter poisoned");
        while attempts
            .front()
            .is_some_and(|first| now.duration_since(*first) >= Duration::from_secs(1))
        {
            attempts.pop_front();
        }
        if attempts.len() >= self.limit as usize {
            return false;
        }
        attempts.push_back(now);
        true
    }
}

struct AppState {
    root: Arc<Dir>,
    static_root: Arc<Dir>,
    config: Config,
    connections: Arc<Semaphore>,
    files: Arc<Semaphore>,
    rpc_limiter: RpcRateLimiter,
}

fn allowed(headers: &HeaderMap, state: &AppState, require_origin: bool) -> bool {
    let host_ok = headers.get_all(header::HOST).iter().count() == 1
        && headers.get(header::HOST).and_then(|v| v.to_str().ok())
            == Some(state.config.authority.as_str());
    let origins = headers.get_all(header::ORIGIN);
    let origin_ok = origins.iter().count() == 1
        && origins.iter().next().and_then(|v| v.to_str().ok())
            == Some(state.config.origin.as_str());
    host_ok && (origin_ok || (!require_origin && origins.iter().next().is_none()))
}

fn no_body(headers: &HeaderMap, uri: &Uri) -> bool {
    uri.query().is_none()
        && !headers.contains_key(header::TRANSFER_ENCODING)
        && headers.get_all(header::CONTENT_LENGTH).iter().count() <= 1
        && headers
            .get(header::CONTENT_LENGTH)
            .is_none_or(|v| v.as_bytes() == b"0")
}

fn asset_name(raw: &str) -> Option<String> {
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    if decoded.len() > 512
        || decoded.is_empty()
        || decoded.split('/').any(|part| {
            part.is_empty()
                || part.starts_with('.')
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_'))
        })
    {
        return None;
    }
    Some(decoded.into_owned())
}

async fn index(State(state): State<Arc<AppState>>, headers: HeaderMap, uri: Uri) -> Response {
    asset(state, headers, uri, "index.html", true).await
}

async fn static_file(State(state): State<Arc<AppState>>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(raw) = uri.path().strip_prefix("/static/") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(name) = asset_name(raw) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    asset(state, headers, uri, &name, false).await
}

async fn asset(
    state: Arc<AppState>,
    headers: HeaderMap,
    uri: Uri,
    name: &str,
    is_index: bool,
) -> Response {
    if !allowed(&headers, &state, false) || !no_body(&headers, &uri) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Ok(permit) = state.files.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let root = if is_index {
        state.root.clone()
    } else {
        state.static_root.clone()
    };
    let name = name.to_owned();
    let mime = mime_guess::from_path(&name)
        .first_or_octet_stream()
        .to_string();
    let result = time::timeout(
        IO_TIMEOUT,
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let file = root.open(Path::new(&name))?;
            let meta = file.metadata()?;
            if !meta.is_file() || meta.len() > MAX_ASSET {
                return Err(std::io::Error::other("not a bounded regular file"));
            }
            let mut data = Vec::new();
            file.take(MAX_ASSET + 1).read_to_end(&mut data)?;
            if data.len() as u64 > MAX_ASSET {
                return Err(std::io::Error::other("file grew past limit"));
            }
            Ok::<_, std::io::Error>(data)
        }),
    )
    .await;
    match result {
        Ok(Ok(Ok(data))) => (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "no-store".to_owned()),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_owned()),
            ],
            data,
        )
            .into_response(),
        Ok(Ok(Err(e)))
            if e.kind() == std::io::ErrorKind::NotFound
                || e.kind() == std::io::ErrorKind::PermissionDenied =>
        {
            StatusCode::NOT_FOUND.into_response()
        }
        _ => StatusCode::SERVICE_UNAVAILABLE.into_response(),
    }
}

async fn rpc(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    uri: Uri,
    ws: WebSocketUpgrade,
) -> Response {
    if !allowed(&headers, &state, true) || !no_body(&headers, &uri) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(permit) = state.connections.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    if !state.rpc_limiter.allow(Instant::now()) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "1")],
            "RPC connection rate limit exceeded",
        )
            .into_response();
    }
    let upstream = match time::timeout(IO_TIMEOUT, TcpStream::connect(state.config.upstream)).await
    {
        Ok(Ok(stream)) => stream,
        _ => return StatusCode::BAD_GATEWAY.into_response(),
    };
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_FRAME)
        .on_upgrade(move |socket| bridge(socket, upstream, permit))
        .into_response()
}

async fn bridge(mut ws: WebSocket, mut upstream: TcpStream, _permit: OwnedSemaphorePermit) {
    let mut buf = [0u8; 16 * 1024];
    let mut deadline = Instant::now() + IDLE;
    loop {
        tokio::select! {
            _ = time::sleep_until(deadline) => break,
            incoming = ws.next() => {
                match incoming {
                    Some(Ok(Message::Binary(bytes))) => {
                        if !matches!(time::timeout(IO_TIMEOUT, upstream.write_all(&bytes)).await, Ok(Ok(()))) { break; }
                        deadline = Instant::now() + IDLE;
                    }
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => { deadline = Instant::now() + IDLE; }
                    _ => break, // Text and close frames never reach the binary TCP service.
                }
            }
            incoming = upstream.read(&mut buf) => {
                match incoming {
                    Ok(n) if n > 0 => {
                        if !matches!(time::timeout(IO_TIMEOUT, ws.send(Message::Binary(buf[..n].to_vec().into()))).await, Ok(Ok(()))) { break; }
                        deadline = Instant::now() + IDLE;
                    }
                    _ => break,
                }
            }
        }
    }
    let _ = time::timeout(Duration::from_secs(1), ws.close()).await;
}

fn asset_root() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(root) = env::var_os("CVSE_RELAY_ROOT") {
        return Ok(PathBuf::from(root));
    }
    // A copied release bundle keeps bin/ and share/ together; no /nix/store path is embedded.
    let executable = env::current_exe()?;
    let bin_dir = executable.parent().ok_or("executable has no parent")?;
    let bundle = bin_dir.parent().ok_or("executable has no bundle root")?;
    let installed = bundle.join("share/cvse-frontend");
    if installed.is_dir() {
        return Ok(installed);
    }
    // `cargo run` places the binary in relay/target/{debug,release}/.
    let source_root = bundle
        .parent()
        .and_then(Path::parent)
        .ok_or("no source root")?;
    if source_root.join("index.html").is_file() && source_root.join("static").is_dir() {
        return Ok(source_root.to_path_buf());
    }
    Err("static assets not found; set CVSE_RELAY_ROOT or copy the full bundle".into())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    // Open the selected asset root once. Capability-relative opens cannot escape it via symlinks.
    let root = Arc::new(Dir::open_ambient_dir(asset_root()?, ambient_authority())?);
    let static_root = Arc::new(root.open_dir("static")?);
    let listener = TcpListener::bind(config.listen).await?;
    eprintln!(
        "CVSE relay listening on {}, origin {}, upstream {}",
        listener.local_addr()?,
        config.origin,
        config.upstream
    );
    let state = Arc::new(AppState {
        root,
        static_root,
        rpc_limiter: RpcRateLimiter::new(config.rpc_rate_limit),
        config,
        connections: Arc::new(Semaphore::new(16)),
        files: Arc::new(Semaphore::new(32)),
    });
    let app = Router::new()
        .route("/", get(index))
        .route("/static/{*path}", get(static_file))
        .route("/rpc", get(rpc))
        .with_state(state);
    let sockets = Arc::new(Semaphore::new(128));
    loop {
        let (stream, _) = listener.accept().await?;
        let Ok(permit) = sockets.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let app = app.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let service = TowerToHyperService::new(app);
            let mut http = http1::Builder::new();
            http.max_buf_size(16 * 1024);
            http.timer(TokioTimer::new())
                .header_read_timeout(Duration::from_secs(5))
                .keep_alive(false);
            let connection = http
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades();
            let _ = time::timeout(Duration::from_secs(30), connection).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn state() -> AppState {
        AppState {
            root: Arc::new(Dir::open_ambient_dir(".", ambient_authority()).unwrap()),
            static_root: Arc::new(Dir::open_ambient_dir(".", ambient_authority()).unwrap()),
            config: Config {
                listen: "127.0.0.1:1".parse().unwrap(),
                upstream: "127.0.0.1:2".parse().unwrap(),
                origin: "http://127.0.0.1:1".into(),
                authority: "127.0.0.1:1".into(),
                rpc_rate_limit: 10,
            },
            connections: Arc::new(Semaphore::new(16)),
            files: Arc::new(Semaphore::new(32)),
            rpc_limiter: RpcRateLimiter::new(10),
        }
    }

    #[test]
    fn rpc_rate_limit_is_global_and_uses_a_sliding_second() {
        let limiter = RpcRateLimiter::new(10);
        let start = Instant::now();
        for _ in 0..10 {
            assert!(limiter.allow(start));
        }
        assert!(!limiter.allow(start));
        assert!(!limiter.allow(start + Duration::from_millis(999)));
        for _ in 0..10 {
            assert!(limiter.allow(start + Duration::from_secs(1)));
        }
        assert!(!limiter.allow(start + Duration::from_secs(1)));

        let sliding = RpcRateLimiter::new(2);
        assert!(sliding.allow(start));
        assert!(sliding.allow(start + Duration::from_millis(500)));
        assert!(sliding.allow(start + Duration::from_secs(1)));
        assert!(!sliding.allow(start + Duration::from_secs(1)));
    }

    #[test]
    fn invalid_rpc_rate_limit_fails_configuration() {
        for invalid in ["", "0", "-1", "1.5", "abc", "4294967296"] {
            assert!(parse_rpc_rate_limit(invalid).is_err());
        }
        assert_eq!(parse_rpc_rate_limit("20"), Ok(20));
    }

    #[test]
    fn origin_and_host_are_exact() {
        let state = state();
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:1"));
        assert!(!allowed(&h, &state, true));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:1"),
        );
        assert!(allowed(&h, &state, true));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:1.evil"),
        );
        assert!(!allowed(&h, &state, true));
        h.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert!(!allowed(&h, &state, true));
    }

    #[test]
    fn paths_and_bodies_are_restricted() {
        for path in [
            "../server.py",
            "%2e%2e/server.py",
            "css/%2fsecret",
            "css/../x",
            ".git/config",
            "x\\y",
            "x//y",
            "x%00y",
        ] {
            assert!(asset_name(path).is_none(), "{path}");
        }
        assert_eq!(asset_name("css/style.css"), Some("css/style.css".into()));
        let mut h = HeaderMap::new();
        assert!(no_body(&h, &"/rpc".parse().unwrap()));
        assert!(!no_body(&h, &"/rpc?upstream=bad".parse().unwrap()));
        h.insert(header::CONTENT_LENGTH, HeaderValue::from_static("1"));
        assert!(!no_body(&h, &"/rpc".parse().unwrap()));
    }
}
