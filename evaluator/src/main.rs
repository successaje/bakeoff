//! OutLayer entry point.
//!
//! Reads one request from stdin, takes the sealed test set and the model API
//! key from environment variables (OutLayer injects them from encrypted
//! secrets), and prints exactly one verdict to stdout.

use bakeoff_evaluator::{Digests, Reason, Verdict};
use serde::Deserialize;
use std::io::{Read, Write};

/// Environment variable holding the sealed test set (an OutLayer secret).
const TEST_SET_VAR: &str = "BAKEOFF_TEST_SET";
/// Environment variable holding the model API key (an OutLayer secret).
const API_KEY_VAR: &str = "BAKEOFF_LLM_API_KEY";

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    /// Score against the sealed test set from the environment. The only mode
    /// the contract requests.
    Sealed,
    /// Score against a test set supplied in the request, for local practice.
    Dev,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    mode: Mode,
    rules_json: String,
    config_json: String,
    #[serde(default)]
    test_set_json: Option<String>,
}

fn main() {
    let verdict = handle();
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(verdict.to_json().as_bytes());
    let _ = stdout.flush();
}

fn handle() -> Verdict {
    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return input_invalid("request is not valid UTF-8");
    }
    let request: Request = match serde_json::from_str(&raw) {
        Ok(request) => request,
        Err(e) => return input_invalid(&e.to_string()),
    };

    let test_set = match (&request.mode, request.test_set_json) {
        (Mode::Sealed, Some(_)) => {
            return input_invalid("sealed requests must not carry a test set")
        }
        (Mode::Sealed, None) => std::env::var(TEST_SET_VAR).ok(),
        (Mode::Dev, supplied) => supplied,
    };
    let api_key = std::env::var(API_KEY_VAR).unwrap_or_default();

    let endpoint = serde_json::from_str::<serde_json::Value>(&request.rules_json)
        .ok()
        .and_then(|rules| {
            rules
                .get("endpoint")
                .and_then(|e| e.as_str())
                .map(str::to_owned)
        })
        .unwrap_or_default();

    let mut client = transport::client(endpoint, api_key);
    let clock = bakeoff_evaluator::MonotonicClock::new();
    bakeoff_evaluator::evaluate_request(
        &request.rules_json,
        &request.config_json,
        test_set.as_deref(),
        &mut client,
        &clock,
    )
}

fn input_invalid(detail: &str) -> Verdict {
    Verdict::rejected(
        Reason::InputInvalid,
        Some(detail.to_string()),
        Digests::default(),
    )
}

#[cfg(target_arch = "wasm32")]
mod transport {
    use bakeoff_evaluator::wasi_http::{self, HttpRequest, Timeouts};
    use bakeoff_evaluator::{openai, ChatClient, ChatOutcome, ChatRequest};
    use std::time::Duration;

    pub struct WasiChatClient {
        endpoint: String,
        authorization: String,
        timeouts: Timeouts,
    }

    pub fn client(endpoint: String, api_key: String) -> WasiChatClient {
        WasiChatClient {
            endpoint,
            authorization: format!("Bearer {api_key}"),
            timeouts: Timeouts {
                connect: Duration::from_secs(10),
                first_byte: Duration::from_secs(45),
                between_bytes: Duration::from_secs(15),
            },
        }
    }

    impl ChatClient for WasiChatClient {
        fn complete_all(&mut self, requests: &[ChatRequest], limit: Duration) -> Vec<ChatOutcome> {
            let headers = [
                ("content-type", "application/json"),
                ("authorization", self.authorization.as_str()),
            ];
            let http_requests: Vec<HttpRequest<'_>> = requests
                .iter()
                .map(|request| HttpRequest {
                    url: &self.endpoint,
                    headers: &headers,
                    body: openai::request_body(request),
                })
                .collect();
            wasi_http::post_all(&http_requests, self.timeouts.capped(limit))
                .into_iter()
                .zip(requests)
                .map(|(timed, request)| {
                    let result = timed.value.and_then(|response| {
                        if (200..300).contains(&response.status) {
                            openai::parse_response(&response.body)
                        } else {
                            Err(format!("upstream status {}", response.status))
                        }
                    });
                    // stderr stays in the worker's logs; only the verdict is returned.
                    if let Err(e) = &result {
                        eprintln!("model call to {} failed: {e}", request.model);
                    }
                    ChatOutcome {
                        result,
                        latency_ms: timed.elapsed_ms,
                    }
                })
                .collect()
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
mod transport {
    use bakeoff_evaluator::{ChatClient, ChatOutcome, ChatRequest};
    use std::time::Duration;

    /// Native builds have no network transport; the evaluator is meant to be
    /// built for `wasm32-wasip2` and run under OutLayer or wasmtime.
    pub struct UnavailableClient;

    pub fn client(_endpoint: String, _api_key: String) -> UnavailableClient {
        UnavailableClient
    }

    impl ChatClient for UnavailableClient {
        fn complete_all(&mut self, requests: &[ChatRequest], _limit: Duration) -> Vec<ChatOutcome> {
            requests
                .iter()
                .map(|_| ChatOutcome {
                    result: Err(
                        "network transport is only available in the wasm32-wasip2 build".into(),
                    ),
                    latency_ms: 0,
                })
                .collect()
        }
    }
}
