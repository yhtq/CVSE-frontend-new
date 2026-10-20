//! A WebSocket binary message is a chunk of the *unpacked*, unframed TCP byte stream.
//! Never use Cap'n Proto packed serialization or treat WS message boundaries as RPC boundaries.
use futures::{
    channel::{mpsc, oneshot},
    io::{AsyncRead, AsyncWrite},
    Stream,
};
use std::{
    cell::RefCell,
    io,
    pin::Pin,
    rc::Rc,
    task::{Context, Poll},
};
use wasm_bindgen::{closure::Closure, JsCast, JsValue};
use web_sys::{BinaryType, Event, MessageEvent, WebSocket};

pub struct Reader {
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    pending: Vec<u8>,
    offset: usize,
}

impl AsyncRead for Reader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut [u8],
    ) -> Poll<io::Result<usize>> {
        if out.is_empty() {
            return Poll::Ready(Ok(0));
        }
        while self.offset == self.pending.len() {
            match Pin::new(&mut self.rx).poll_next(cx) {
                Poll::Ready(Some(bytes)) => {
                    self.pending = bytes;
                    self.offset = 0;
                }
                Poll::Ready(None) => return Poll::Ready(Ok(0)),
                Poll::Pending => return Poll::Pending,
            }
        }
        let n = out.len().min(self.pending.len() - self.offset);
        out[..n].copy_from_slice(&self.pending[self.offset..self.offset + n]);
        self.offset += n;
        Poll::Ready(Ok(n))
    }
}

pub struct Writer(WebSocket);
impl AsyncWrite for Writer {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.0.ready_state() != WebSocket::OPEN {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "RPC WebSocket closed",
            )));
        }
        // Bound a single frame; AsyncWrite callers must handle short writes.
        let n = buf.len().min(64 * 1024);
        self.0.send_with_u8_array(&buf[..n]).map_err(|e| {
            io::Error::new(io::ErrorKind::BrokenPipe, format!("WebSocket send: {e:?}"))
        })?;
        Poll::Ready(Ok(n))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        let _ = self.0.close();
        Poll::Ready(Ok(()))
    }
}

pub struct Socket {
    ws: WebSocket,
    _open: Closure<dyn FnMut(Event)>,
    _message: Closure<dyn FnMut(MessageEvent)>,
    _error: Closure<dyn FnMut(Event)>,
    _close: Closure<dyn FnMut(Event)>,
}
impl Drop for Socket {
    fn drop(&mut self) {
        self.ws.set_onopen(None);
        self.ws.set_onmessage(None);
        self.ws.set_onerror(None);
        self.ws.set_onclose(None);
        let _ = self.ws.close();
    }
}

pub async fn connect() -> Result<(Reader, Writer, Socket), JsValue> {
    let window = web_sys::window().ok_or_else(|| JsValue::from_str("window unavailable"))?;
    let loc = window.location();
    let scheme = if loc.protocol()? == "https:" {
        "wss"
    } else {
        "ws"
    };
    let url = format!("{scheme}://{}/rpc", loc.host()?);
    let ws = WebSocket::new(&url)?;
    ws.set_binary_type(BinaryType::Arraybuffer);
    let (tx, rx) = mpsc::unbounded();
    let (opened_tx, opened_rx) = oneshot::channel::<Result<(), String>>();
    let opened = Rc::new(RefCell::new(Some(opened_tx)));
    let onopen = {
        let opened = opened.clone();
        Closure::wrap(Box::new(move |_: Event| {
            if let Some(tx) = opened.borrow_mut().take() {
                let _ = tx.send(Ok(()));
            }
        }) as Box<dyn FnMut(Event)>)
    };
    let onmessage = {
        let tx = tx.clone();
        Closure::wrap(Box::new(move |ev: MessageEvent| {
            if let Ok(buffer) = ev.data().dyn_into::<js_sys::ArrayBuffer>() {
                let _ = tx.unbounded_send(js_sys::Uint8Array::new(&buffer).to_vec());
            } else {
                tx.close_channel(); // text/Blob is a protocol violation
            }
        }) as Box<dyn FnMut(MessageEvent)>)
    };
    let onerror = {
        let opened = opened.clone();
        let tx = tx.clone();
        Closure::wrap(Box::new(move |_: Event| {
            if let Some(done) = opened.borrow_mut().take() {
                let _ = done.send(Err("RPC WebSocket error".into()));
            }
            tx.close_channel();
        }) as Box<dyn FnMut(Event)>)
    };
    let onclose = {
        let opened = opened.clone();
        Closure::wrap(Box::new(move |_: Event| {
            if let Some(done) = opened.borrow_mut().take() {
                let _ = done.send(Err("RPC WebSocket closed during handshake".into()));
            }
            tx.close_channel();
        }) as Box<dyn FnMut(Event)>)
    };
    ws.set_onopen(Some(onopen.as_ref().unchecked_ref()));
    ws.set_onmessage(Some(onmessage.as_ref().unchecked_ref()));
    ws.set_onerror(Some(onerror.as_ref().unchecked_ref()));
    ws.set_onclose(Some(onclose.as_ref().unchecked_ref()));
    let socket = Socket {
        ws: ws.clone(),
        _open: onopen,
        _message: onmessage,
        _error: onerror,
        _close: onclose,
    };
    opened_rx
        .await
        .map_err(|_| JsValue::from_str("RPC WebSocket handshake interrupted"))?
        .map_err(|e| JsValue::from_str(&e))?;
    Ok((
        Reader {
            rx,
            pending: vec![],
            offset: 0,
        },
        Writer(ws),
        socket,
    ))
}
