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
    use bakeoff_evaluator::attestation::{self, Fetched, ModelTee, Receipt};
    use bakeoff_evaluator::wasi_http::{self, HttpRequest, HttpResponse, Timed, Timeouts, Verb};
    use bakeoff_evaluator::{openai, ChatClient, ChatOutcome, ChatRequest};
    use std::collections::{BTreeMap, BTreeSet};
    use std::time::{Duration, Instant, SystemTime};

    pub struct WasiChatClient {
        endpoint: String,
        authorization: String,
        timeouts: Timeouts,
        /// What the provider must have signed, one per answer returned.
        receipts: Vec<Option<Receipt>>,
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
            receipts: Vec::new(),
        }
    }

    /// Signature and attestation lookups in flight at once. A signature takes NEAR AI about
    /// 0.7 s, so 500 of them take about 11 s.
    const ATTESTATION_IN_FLIGHT: usize = 32;

    impl WasiChatClient {
        /// `https://host` from `https://host/v1/chat/completions`.
        fn origin(&self) -> &str {
            self.endpoint.split("/v1/").next().unwrap_or(&self.endpoint)
        }

        fn get_all(
            &self,
            urls: &[String],
            deadline: Instant,
            authorized: bool,
        ) -> Vec<Timed<Result<HttpResponse, String>>> {
            let auth = [("authorization", self.authorization.as_str())];
            let headers: &[(&str, &str)] = if authorized { &auth } else { &[] };
            let requests: Vec<HttpRequest<'_>> = urls
                .iter()
                .map(|url| HttpRequest {
                    verb: Verb::Get,
                    url,
                    headers,
                    body: Vec::new(),
                })
                .collect();
            wasi_http::send_all(
                &requests,
                self.timeouts,
                ATTESTATION_IN_FLIGHT,
                remaining(deadline),
            )
        }
    }

    fn remaining(deadline: Instant) -> Duration {
        deadline.saturating_duration_since(Instant::now())
    }

    fn ok_body(
        timed: Timed<Result<HttpResponse, String>>,
        what: &str,
    ) -> Result<HttpResponse, String> {
        let response = timed.value.map_err(|e| format!("{what}: {e}"))?;
        if (200..300).contains(&response.status) {
            Ok(response)
        } else {
            Err(format!("{what}: HTTP {}", response.status))
        }
    }

    impl ChatClient for WasiChatClient {
        fn complete_all(
            &mut self,
            requests: &[ChatRequest],
            limit: Duration,
            max_in_flight: usize,
        ) -> Vec<ChatOutcome> {
            let headers = [
                ("content-type", "application/json"),
                ("authorization", self.authorization.as_str()),
            ];
            let http_requests: Vec<HttpRequest<'_>> = requests
                .iter()
                .map(|request| HttpRequest {
                    verb: Verb::Post,
                    url: &self.endpoint,
                    headers: &headers,
                    body: openai::request_body(request),
                })
                .collect();
            let timed_all =
                wasi_http::send_all(&http_requests, self.timeouts, max_in_flight, limit);
            let mut receipts = Vec::new();
            let outcomes = timed_all
                .into_iter()
                .zip(requests.iter().zip(&http_requests))
                .map(|(timed, (request, sent))| {
                    let result = timed.value.and_then(|response| {
                        if (200..300).contains(&response.status) {
                            let parsed = openai::parse_response(&response.body);
                            if parsed.is_ok() {
                                receipts.push(Receipt::new(
                                    &request.model,
                                    &sent.body,
                                    &response.body,
                                ));
                            }
                            parsed
                        } else {
                            Err(format!("upstream status {}", response.status))
                        }
                    });
                    // stderr stays in the worker's logs; only the verdict is returned.
                    if let (Err(e), true) = (&result, timed.started) {
                        eprintln!("model call to {} failed: {e}", request.model);
                    }
                    ChatOutcome {
                        result,
                        latency_ms: timed.elapsed_ms,
                        skipped: !timed.started,
                    }
                })
                .collect();
            self.receipts.extend(receipts);
            outcomes
        }

        /// Checks every answer's signature, then attests each signer's key: its servers' TDX
        /// quotes against Intel's collateral, bound to a nonce made here, and their GPU evidence
        /// with NVIDIA's service. See `bakeoff_evaluator::attestation`.
        fn attest(&mut self, binding: [u8; 32], limit: Duration) -> Result<ModelTee, String> {
            let deadline = Instant::now() + limit;
            let random: [u8; 32] = wasi::random::random::get_random_bytes(32)
                .try_into()
                .map_err(|_| "no randomness for the nonce")?;
            let nonce = attestation::nonce(&binding, &random);
            let origin = self.origin().to_string();
            let answers = self.receipts.len() as u32;

            // 1. Every answer's signature, from the key that signed it.
            let signed: Vec<&Receipt> = self.receipts.iter().flatten().collect();
            let urls: Vec<String> = signed
                .iter()
                .map(|r| {
                    format!(
                        "{origin}/v1/signature/{}?model={}&signing_algo=ecdsa",
                        r.chat_id, r.model
                    )
                })
                .collect();
            eprintln!("model attestation: checking {} signatures", urls.len());
            let mut signers: BTreeMap<(String, [u8; 20]), u32> = BTreeMap::new();
            let mut first_error = None;
            for (receipt, timed) in signed.iter().zip(self.get_all(&urls, deadline, true)) {
                let checked = ok_body(timed, "signature")
                    .and_then(|r| {
                        serde_json::from_slice(&r.body)
                            .map_err(|_| "signature: malformed".to_string())
                    })
                    .and_then(|answer| attestation::check_signature(receipt, &answer));
                match checked {
                    Ok(signer) => *signers.entry((receipt.model.clone(), signer)).or_default() += 1,
                    Err(e) => {
                        first_error.get_or_insert(e);
                    }
                }
            }
            if let Some(e) = &first_error {
                eprintln!("model attestation: an answer's signature did not check out: {e}");
            }
            if signers.is_empty() {
                return Err(first_error.unwrap_or_else(|| "no answer to attest".into()));
            }

            // 2. Each signer's key, attested by its servers with this run's nonce.
            let now = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|_| "the clock is before 1970")?
                .as_secs();
            let mut tdx: Option<String> = None;
            let mut collaterals: BTreeMap<String, dcap_qvl::QuoteCollateralV3> = BTreeMap::new();
            for (model, signer) in signers.keys() {
                let address = attestation::address_hex(signer);
                let url = format!(
                    "{origin}/v1/attestation/report?model={model}&nonce={}&signing_algo=ecdsa&signing_address={address}",
                    hex::encode(nonce)
                );
                eprintln!("model attestation: {} of {model}'s answers signed by {address}; fetching its attestation", signers[&(model.clone(), *signer)]);
                let response = ok_body(
                    self.get_all(&[url], deadline, true).remove(0),
                    "attestation report",
                )?;
                let report: attestation::Report = serde_json::from_slice(&response.body)
                    .map_err(|e| format!("attestation report: {e}"))?;
                // Every server holding the key binds it the same way; as NEAR AI's own chat
                // verifier does, one genuine quote that binds it shows the key lives in an attested
                // TEE. Verifying a quote in WebAssembly takes a few hundred million instructions,
                // so checking them all would not fit OutLayer's limit of a billion per run.
                let servers = attestation::servers_for(&report, signer);
                eprintln!(
                    "model attestation: {} servers hold the key ({} KB report); checking the first",
                    servers.len(),
                    response.body.len() / 1024
                );
                let servers = &servers[..servers.len().min(1)];
                if servers.is_empty() {
                    return Err(format!("no server attests {address} for {model}"));
                }
                for server in servers {
                    let quote = server.quote()?;
                    let urls = attestation::collateral_urls(&quote)?;
                    let key = urls[..2].join(" ");
                    if !collaterals.contains_key(&key) {
                        let mut fetched = self.get_all(&urls, deadline, false).into_iter();
                        let mut next = |what: &str| {
                            ok_body(fetched.next().expect("one response per URL"), what)
                        };
                        let (pck, tcb, qe, root) = (
                            next("PCK CRL")?,
                            next("TCB info")?,
                            next("QE identity")?,
                            next("root CA CRL")?,
                        );
                        let collateral = attestation::collateral_from(
                            Fetched {
                                body: &pck.body,
                                header: &|name: &str| pck.header(name),
                            },
                            Fetched {
                                body: &tcb.body,
                                header: &|name: &str| tcb.header(name),
                            },
                            Fetched {
                                body: &qe.body,
                                header: &|name: &str| qe.header(name),
                            },
                            &root.body,
                        )?;
                        collaterals.insert(key.clone(), collateral);
                    }
                    let status = attestation::check_quote(
                        &quote,
                        &collaterals[&key],
                        now,
                        signer,
                        &nonce,
                        server.app_compose().as_deref(),
                    )?;
                    tdx = Some(match tdx {
                        Some(worst) => attestation::least_current(&worst, &status),
                        None => status,
                    });
                    attestation::check_gpu_nonce(&server.nvidia_payload, &nonce)?;
                }
                eprintln!(
                    "model attestation: TDX quotes verified ({}); asking NVIDIA about the GPUs",
                    tdx.as_deref().unwrap_or("-")
                );
                // NVIDIA's service, for every server's GPU evidence at once.
                let json = [("content-type", "application/json")];
                let posts: Vec<HttpRequest<'_>> = servers
                    .iter()
                    .map(|server| HttpRequest {
                        verb: Verb::Post,
                        url: attestation::NVIDIA_NRAS,
                        headers: &json,
                        body: server.nvidia_payload.clone().into_bytes(),
                    })
                    .collect();
                for timed in wasi_http::send_all(
                    &posts,
                    self.timeouts,
                    ATTESTATION_IN_FLIGHT,
                    remaining(deadline),
                ) {
                    let reply = ok_body(timed, "NVIDIA attestation")?;
                    if !attestation::nras_verdict(&reply.body)? {
                        return Err(format!(
                            "NVIDIA did not accept the GPU evidence for {address}"
                        ));
                    }
                }
            }

            let listed: BTreeSet<String> = signers
                .keys()
                .map(|(_, signer)| attestation::address_hex(signer))
                .collect();
            Ok(ModelTee {
                signed: signers.values().sum(),
                answers,
                signers: listed.into_iter().collect(),
                tdx: tdx.unwrap_or_default(),
            })
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
        fn complete_all(
            &mut self,
            requests: &[ChatRequest],
            _limit: Duration,
            _max_in_flight: usize,
        ) -> Vec<ChatOutcome> {
            requests
                .iter()
                .map(|_| ChatOutcome {
                    result: Err(
                        "network transport is only available in the wasm32-wasip2 build".into(),
                    ),
                    latency_ms: 0,
                    skipped: false,
                })
                .collect()
        }
    }
}
