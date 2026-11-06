//! Minimal HTTP client over the WASI Preview 2 `wasi:http` interfaces.
//!
//! Written against the raw bindings rather than `wasi-http-client` because
//! that crate writes the request body with a single
//! `blocking-write-and-flush`, which hosts reject for buffers over 4096
//! bytes. A prompt with a few examples is larger than that.

use std::time::Duration;
use wasi::http::outgoing_handler;
use wasi::http::types::{
    Fields, IncomingBody, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
};
use wasi::io::streams::StreamError;

/// Largest buffer `blocking-write-and-flush` accepts.
const MAX_WRITE: usize = 4096;
const READ_CHUNK: u64 = 64 * 1024;

pub struct Timeouts {
    pub connect: Duration,
    pub first_byte: Duration,
    pub between_bytes: Duration,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
}

pub fn post(
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    timeouts: &Timeouts,
) -> Result<HttpResponse, String> {
    let target = Target::parse(url)?;

    let fields = Fields::new();
    for (name, value) in headers {
        fields
            .append(&name.to_string(), &value.as_bytes().to_vec())
            .map_err(|e| format!("invalid header {name}: {e:?}"))?;
    }

    let request = OutgoingRequest::new(fields);
    request
        .set_method(&Method::Post)
        .map_err(|()| "failed to set method")?;
    request
        .set_scheme(Some(&target.scheme))
        .map_err(|()| "failed to set scheme")?;
    request
        .set_authority(Some(&target.authority))
        .map_err(|()| "failed to set authority")?;
    request
        .set_path_with_query(Some(&target.path))
        .map_err(|()| "failed to set path")?;

    let outgoing_body = request.body().map_err(|()| "request body unavailable")?;
    {
        // The stream is a child resource of the body and must be dropped
        // before the body is finished.
        let stream = outgoing_body
            .write()
            .map_err(|()| "request body stream unavailable")?;
        for chunk in body.chunks(MAX_WRITE) {
            stream
                .blocking_write_and_flush(chunk)
                .map_err(|e| format!("request write failed: {e:?}"))?;
        }
    }
    OutgoingBody::finish(outgoing_body, None).map_err(|e| format!("request finish failed: {e:?}"))?;

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

    let pending = outgoing_handler::handle(request, Some(options))
        .map_err(|e| format!("request failed: {e:?}"))?;
    let response = loop {
        match pending.get() {
            Some(result) => {
                break result
                    .map_err(|()| "response already taken")?
                    .map_err(|e| format!("request failed: {e:?}"))?
            }
            None => pending.subscribe().block(),
        }
    };

    let status = response.status();
    let incoming_body = response.consume().map_err(|()| "response body unavailable")?;
    let mut out = Vec::new();
    {
        let stream = incoming_body
            .stream()
            .map_err(|()| "response body stream unavailable")?;
        loop {
            match stream.blocking_read(READ_CHUNK) {
                Ok(chunk) => out.extend_from_slice(&chunk),
                Err(StreamError::Closed) => break,
                Err(e) => return Err(format!("response read failed: {e:?}")),
            }
        }
    }
    let _trailers = IncomingBody::finish(incoming_body);

    Ok(HttpResponse { status, body: out })
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
