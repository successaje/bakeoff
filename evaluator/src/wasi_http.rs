//! Minimal HTTP client over the WASI Preview 2 `wasi:http` interfaces.
//!
//! Written against the raw bindings rather than `wasi-http-client` because
//! that crate writes the request body with a single
//! `blocking-write-and-flush`, which hosts reject for buffers over 4096
//! bytes, and because it sends one request at a time. Here every request in
//! a batch is started before any response is awaited.

use std::time::{Duration, Instant};
use wasi::http::outgoing_handler;
use wasi::http::types::{
    Fields, FutureIncomingResponse, IncomingBody, Method, OutgoingBody, OutgoingRequest,
    RequestOptions, Scheme,
};
use wasi::io::poll;
use wasi::io::streams::StreamError;

/// Largest buffer `blocking-write-and-flush` accepts.
const MAX_WRITE: usize = 4096;
const READ_CHUNK: u64 = 64 * 1024;

#[derive(Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    pub first_byte: Duration,
    pub between_bytes: Duration,
}

impl Timeouts {
    /// The same timeouts, none longer than `limit`.
    pub fn capped(self, limit: Duration) -> Self {
        Self {
            connect: self.connect.min(limit),
            first_byte: self.first_byte.min(limit),
            between_bytes: self.between_bytes.min(limit),
        }
    }
}

pub struct HttpRequest<'a> {
    pub url: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: Vec<u8>,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub struct Timed<T> {
    pub value: T,
    /// Time from the start of the batch until this response was read.
    pub elapsed_ms: u64,
}

/// Sends every request concurrently and returns their outcomes in request
/// order once all have completed or failed.
pub fn post_all(
    requests: &[HttpRequest<'_>],
    timeouts: Timeouts,
) -> Vec<Timed<Result<HttpResponse, String>>> {
    let started = Instant::now();
    let elapsed = || started.elapsed().as_millis() as u64;

    let mut results: Vec<Option<Timed<Result<HttpResponse, String>>>> =
        requests.iter().map(|_| None).collect();
    let mut pending: Vec<Option<FutureIncomingResponse>> = requests.iter().map(|_| None).collect();
    for (i, request) in requests.iter().enumerate() {
        match start(request, timeouts) {
            Ok(future) => pending[i] = Some(future),
            Err(e) => {
                results[i] = Some(Timed {
                    value: Err(e),
                    elapsed_ms: elapsed(),
                })
            }
        }
    }

    loop {
        let ready: Vec<usize> = {
            // Pollables are children of their futures and must be dropped
            // before the futures are consumed.
            let live: Vec<(usize, wasi::io::poll::Pollable)> = pending
                .iter()
                .enumerate()
                .filter_map(|(i, f)| f.as_ref().map(|f| (i, f.subscribe())))
                .collect();
            if live.is_empty() {
                break;
            }
            let pollables: Vec<&wasi::io::poll::Pollable> = live.iter().map(|(_, p)| p).collect();
            poll::poll(&pollables)
                .into_iter()
                .map(|index| live[index as usize].0)
                .collect()
        };
        for i in ready {
            let future = pending[i].take().expect("ready future is pending");
            let value = finish(future);
            results[i] = Some(Timed {
                value,
                elapsed_ms: elapsed(),
            });
        }
    }

    results
        .into_iter()
        .map(|r| r.expect("every request has an outcome"))
        .collect()
}

fn start(request: &HttpRequest<'_>, timeouts: Timeouts) -> Result<FutureIncomingResponse, String> {
    let target = Target::parse(request.url)?;

    let fields = Fields::new();
    // Without an explicit length the host sends the body chunked, which
    // some servers refuse.
    let content_length = request.body.len().to_string();
    for (name, value) in request
        .headers
        .iter()
        .copied()
        .chain(std::iter::once(("content-length", content_length.as_str())))
    {
        fields
            .append(&name.to_string(), &value.as_bytes().to_vec())
            .map_err(|e| format!("invalid header {name}: {e:?}"))?;
    }

    let outgoing = OutgoingRequest::new(fields);
    outgoing
        .set_method(&Method::Post)
        .map_err(|()| "failed to set method")?;
    outgoing
        .set_scheme(Some(&target.scheme))
        .map_err(|()| "failed to set scheme")?;
    outgoing
        .set_authority(Some(&target.authority))
        .map_err(|()| "failed to set authority")?;
    outgoing
        .set_path_with_query(Some(&target.path))
        .map_err(|()| "failed to set path")?;

    let outgoing_body = outgoing.body().map_err(|()| "request body unavailable")?;
    {
        // The stream is a child resource of the body and must be dropped
        // before the body is finished.
        let stream = outgoing_body
            .write()
            .map_err(|()| "request body stream unavailable")?;
        for chunk in request.body.chunks(MAX_WRITE) {
            stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| format!("request write failed: {e:?}"))?;
        }
    }
    OutgoingBody::finish(outgoing_body, None)
        .map_err(|e| format!("request finish failed: {e:?}"))?;

    let options = RequestOptions::new();
    options
        .set_connect_timeout(Some(nanos(timeouts.connect)))
        .map_err(|()| "connect timeout not supported")?;
    options
        .set_first_byte_timeout(Some(nanos(timeouts.first_byte)))
        .map_err(|()| "first byte timeout not supported")?;
    options
        .set_between_bytes_timeout(Some(nanos(timeouts.between_bytes)))
        .map_err(|()| "between bytes timeout not supported")?;

    outgoing_handler::handle(outgoing, Some(options)).map_err(|e| format!("request failed: {e:?}"))
}

fn finish(future: FutureIncomingResponse) -> Result<HttpResponse, String> {
    let response = loop {
        match future.get() {
            Some(result) => {
                break result
                    .map_err(|()| "response already taken")?
                    .map_err(|e| format!("request failed: {e:?}"))?
            }
            None => future.subscribe().block(),
        }
    };

    let status = response.status();
    let incoming_body = response
        .consume()
        .map_err(|()| "response body unavailable")?;
    let mut body = Vec::new();
    {
        let stream = incoming_body
            .stream()
            .map_err(|()| "response body stream unavailable")?;
        loop {
            match stream.blocking_read(READ_CHUNK) {
                Ok(chunk) => body.extend_from_slice(&chunk),
                Err(StreamError::Closed) => break,
                Err(e) => return Err(format!("response read failed: {e:?}")),
            }
        }
    }
    let _trailers = IncomingBody::finish(incoming_body);
    Ok(HttpResponse { status, body })
}

struct Target {
    scheme: Scheme,
    authority: String,
    path: String,
}

impl Target {
    fn parse(url: &str) -> Result<Self, String> {
        let (scheme, rest) = if let Some(rest) = url.strip_prefix("https://") {
            (Scheme::Https, rest)
        } else if let Some(rest) = url.strip_prefix("http://") {
            (Scheme::Http, rest)
        } else {
            return Err(format!("unsupported URL scheme in {url}"));
        };
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], &rest[i..]),
            None => (rest, "/"),
        };
        if authority.is_empty() {
            return Err(format!("URL has no host: {url}"));
        }
        Ok(Self {
            scheme,
            authority: authority.to_string(),
            path: path.to_string(),
        })
    }
}

fn nanos(duration: Duration) -> u64 {
    duration.as_nanos().min(u64::MAX as u128) as u64
}
