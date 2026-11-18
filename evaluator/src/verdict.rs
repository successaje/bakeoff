//! The verdict: the only thing that leaves the enclave.
//!
//! It carries aggregate metrics and the hashes of the exact rules, candidate
//! and test set that were scored, never per-ticket results, so a verdict
//! reveals nothing about individual sealed tickets. OutLayer returns small
//! outputs inline to the calling contract, which records at most 1,024 bytes,
//! so the serialized form is kept under 1,000: 350 to 550 bytes in practice,
//! about 100 more where the rules require attested model answers.

use crate::attestation::ModelTee;
use serde::{Deserialize, Serialize};

pub const VERDICT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    InputInvalid,
    RulesInvalid,
    ConfigInvalid,
    PolicyModel,
    PolicyTool,
    PolicyLimits,
    TestSetUnavailable,
    TestSetInvalid,
    Timeout,
    UpstreamErrors,
    GateAccuracy,
    GateCost,
    GateLatency,
    GateLeaks,
    /// The rules require attested model answers, and this run's could not all be shown to
    /// come from the provider's attested TEEs.
    ModelUnattested,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metrics {
    pub tickets: u32,
    pub completed: u32,
    pub accuracy_bp: u32,
    pub category_accuracy_bp: u32,
    pub cost_uusd: u64,
    pub cost_per_ticket_uusd: u64,
    pub p95_latency_ms: u64,
    pub mean_latency_ms: u64,
    pub leaks: u32,
    pub upstream_errors: u32,
    /// Replies that were not a valid answer: no JSON object, a missing field
    /// or no summary. They are graded as wrong.
    pub invalid_answers: u32,
    pub escalations: u32,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Digests {
    pub rules_sha256: String,
    pub config_sha256: String,
    pub test_set_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Verdict {
    pub version: u32,
    pub passed: bool,
    pub reasons: Vec<Reason>,
    /// Short explanation for rejections caused by the rules or the
    /// candidate. Never derived from the test set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Metrics>,
    /// Where the rules require attested model answers: which TEEs signed them. Present only
    /// when every signer's TDX quote and GPU evidence checked out with this run's nonce.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_tee: Option<ModelTee>,
    #[serde(flatten)]
    pub digests: Digests,
}

const MAX_DETAIL_CHARS: usize = 160;

impl Verdict {
    /// A verdict for a candidate that was refused before any model call.
    pub fn rejected(reason: Reason, detail: Option<String>, digests: Digests) -> Self {
        Self {
            version: VERDICT_VERSION,
            passed: false,
            reasons: vec![reason],
            detail: detail.map(|d| truncate(&d, MAX_DETAIL_CHARS)),
            metrics: None,
            model_tee: None,
            digests,
        }
    }

    pub fn scored(reasons: Vec<Reason>, metrics: Metrics, digests: Digests) -> Self {
        Self {
            version: VERDICT_VERSION,
            passed: reasons.is_empty(),
            reasons,
            detail: None,
            metrics: Some(metrics),
            model_tee: None,
            digests,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("verdict always serializes")
    }
}

fn truncate(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((index, _)) => format!("{}…", &text[..index]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_digests() -> Digests {
        Digests {
            rules_sha256: "a".repeat(64),
            config_sha256: "b".repeat(64),
            test_set_sha256: "c".repeat(64),
        }
    }

    #[test]
    fn worst_case_verdict_fits_outlayer_inline_output() {
        let verdict = Verdict::scored(
            vec![
                Reason::GateAccuracy,
                Reason::GateCost,
                Reason::GateLatency,
                Reason::GateLeaks,
            ],
            Metrics {
                tickets: u32::MAX,
                completed: u32::MAX,
                accuracy_bp: 10_000,
                category_accuracy_bp: 10_000,
                cost_uusd: u64::MAX,
                cost_per_ticket_uusd: u64::MAX,
                p95_latency_ms: u64::MAX,
                mean_latency_ms: u64::MAX,
                leaks: u32::MAX,
                upstream_errors: u32::MAX,
                invalid_answers: u32::MAX,
                escalations: u32::MAX,
                elapsed_ms: u64::MAX,
            },
            full_digests(),
        );
        let json = verdict.to_json();
        assert!(json.len() < 900, "verdict is {} bytes", json.len());

        // With attested model answers from two models with their own keys, and the longest TCB
        // status Intel reports.
        let mut attested = verdict.clone();
        attested.reasons.push(Reason::ModelUnattested);
        attested.model_tee = Some(ModelTee {
            signed: u32::MAX,
            answers: u32::MAX,
            signers: vec![
                format!("0x{}", "a".repeat(40)),
                format!("0x{}", "b".repeat(40)),
            ],
            tdx: "OutOfDateConfigurationNeeded".into(),
        });
        let json = attested.to_json();
        assert!(json.len() < 1_000, "verdict is {} bytes", json.len());

        let rejected =
            Verdict::rejected(Reason::PolicyTool, Some("x".repeat(1_000)), full_digests());
        assert!(rejected.to_json().len() < 900);
    }

    #[test]
    fn round_trips_through_json() {
        let verdict = Verdict::rejected(
            Reason::PolicyModel,
            Some("model not allowed".into()),
            full_digests(),
        );
        let parsed: Verdict = serde_json::from_str(&verdict.to_json()).unwrap();
        assert_eq!(parsed, verdict);
        assert!(verdict.to_json().contains("\"reasons\":[\"policy_model\"]"));
    }
}
