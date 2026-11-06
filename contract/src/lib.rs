//! Bakeoff challenge contract.
//!
//! Holds one challenge's rules together with commitments to the evaluator
//! build and the sealed test set. Each submitted candidate is sent to
//! OutLayer, scored inside a TEE by the committed evaluator, and the verdict
//! is recorded here. A verdict is accepted only if it names the exact rules,
//! candidate and test set this contract committed to; anything else is
//! recorded as rejected.
//!
//! A challenge starts as a draft, in which the owner may adjust its
//! commitments and run trial evaluations. Opening it freezes the commitments
//! and admits submissions from anyone.

use near_sdk::json_types::U64;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// Gas forwarded to `request_execution`. OutLayer reserves its own response
/// callback out of this.
const OUTLAYER_GAS: Gas = Gas::from_tgas(150);
const RESULT_CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// Prepaid gas a submission needs: this call, OutLayer, and the callback.
const MIN_SUBMIT_GAS: Gas = Gas::from_tgas(200);
/// Covers OutLayer's estimate for the resource limits below (0.019 NEAR at
/// the time of writing). Whatever is unused is refunded to the submitter.
const MIN_EXECUTION_DEPOSIT: NearToken = NearToken::from_millinear(25);

const MAX_INSTRUCTIONS: u64 = 1_000_000_000;
const MAX_MEMORY_MB: u32 = 128;
const MAX_EXECUTION_SECONDS: u64 = 180;

const MAX_CONFIG_BYTES: usize = 16 * 1024;
const MAX_VERDICT_BYTES: usize = 4 * 1024;
const EVENT_STANDARD: &str = "bakeoff";
const EVENT_VERSION: &str = "1.0.0";

/// A published evaluator build, run by URL and pinned by its SHA-256.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvaluatorBuild {
    pub url: String,
    pub sha256: String,
}

/// Where OutLayer finds the sealed test set and model API key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SecretsLocation {
    pub profile: String,
    pub owner: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChallengeStatus {
    Draft,
    Open,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationStatus {
    /// Sent to OutLayer, no result yet.
    Pending,
    /// The evaluator scored the candidate and every gate passed.
    Passed,
    /// The evaluator scored or screened the candidate and it did not pass.
    Failed,
    /// No trustworthy verdict: the execution failed, or the verdict does not
    /// match this challenge's commitments.
    Rejected,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Evaluation {
    pub submitter: AccountId,
    pub config_sha256: String,
    pub status: EvaluationStatus,
    /// Evaluator reason codes for `Failed`, or the contract's reason for `Rejected`.
    pub reasons: Vec<String>,
    /// The verdict exactly as the evaluator printed it, when one was returned.
    pub verdict: Option<String>,
    pub requested_at: U64,
    pub settled_at: Option<U64>,
}

#[near(serializers = [json])]
pub struct ChallengeView {
    pub owner: AccountId,
    pub status: ChallengeStatus,
    pub outlayer: AccountId,
    pub evaluator: EvaluatorBuild,
    pub secrets: SecretsLocation,
    pub rules_json: String,
    pub rules_sha256: String,
    pub test_set_sha256: String,
    pub evaluations: u32,
}

#[near(serializers = [json])]
pub struct EvaluationView {
    pub id: u32,
    #[serde(flatten)]
    pub evaluation: Evaluation,
}

/// The verdict fields the contract checks. Metrics are kept in the raw
/// verdict and not interpreted here.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VerdictCommitments {
    passed: bool,
    #[serde(default)]
    reasons: Vec<String>,
    rules_sha256: String,
    config_sha256: String,
    test_set_sha256: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    status: ChallengeStatus,
    outlayer: AccountId,
    evaluator: EvaluatorBuild,
    secrets: SecretsLocation,
    rules_json: String,
    rules_sha256: String,
    test_set_sha256: String,
    evaluations: Vector<Evaluation>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        outlayer: AccountId,
        evaluator: EvaluatorBuild,
        secrets: SecretsLocation,
        rules_json: String,
        test_set_sha256: String,
    ) -> Self {
        assert_sha256_hex(&evaluator.sha256, "evaluator.sha256");
        assert_sha256_hex(&test_set_sha256, "test_set_sha256");
        Self {
            owner: env::predecessor_account_id(),
            status: ChallengeStatus::Draft,
            outlayer,
            evaluator,
            secrets,
            rules_sha256: sha256_hex(rules_json.as_bytes()),
            rules_json,
            test_set_sha256,
            evaluations: Vector::new(b"e"),
        }
    }

    /// Sends a candidate configuration for sealed evaluation. Attach at least
    /// 0.025 NEAR for OutLayer and 200 Tgas; unused deposit is refunded to
    /// the caller by OutLayer.
    #[payable]
    pub fn submit(&mut self, config_json: String) -> Promise {
        let submitter = env::predecessor_account_id();
        if self.status == ChallengeStatus::Draft {
            require!(submitter == self.owner, "challenge is not open for submissions");
        }
        require!(!config_json.is_empty(), "config_json is empty");
        require!(config_json.len() <= MAX_CONFIG_BYTES, "config_json exceeds 16 KiB");
        let deposit = env::attached_deposit();
        require!(
            deposit >= MIN_EXECUTION_DEPOSIT,
            "attach at least 0.025 NEAR for the sealed evaluation"
        );
        require!(env::prepaid_gas() >= MIN_SUBMIT_GAS, "attach at least 200 Tgas");

        let config_sha256 = sha256_hex(config_json.as_bytes());
        let id = self.evaluations.len();
        self.evaluations.push(Evaluation {
            submitter: submitter.clone(),
            config_sha256: config_sha256.clone(),
            status: EvaluationStatus::Pending,
            reasons: Vec::new(),
            verdict: None,
            requested_at: U64(env::block_timestamp()),
            settled_at: None,
        });
        emit(
            "evaluation_requested",
            json!({ "id": id, "submitter": submitter, "config_sha256": config_sha256 }),
        );

        let input_data = json!({
            "mode": "sealed",
            "rules_json": self.rules_json,
            "config_json": config_json,
        })
        .to_string();
        let args = json!({
            "source": { "WasmUrl": {
                "url": self.evaluator.url,
                "hash": self.evaluator.sha256,
                "build_target": "wasm32-wasip2",
            }},
            "resource_limits": {
                "max_instructions": MAX_INSTRUCTIONS,
                "max_memory_mb": MAX_MEMORY_MB,
                "max_execution_seconds": MAX_EXECUTION_SECONDS,
            },
            "input_data": input_data,
            "secrets_ref": { "profile": self.secrets.profile, "account_id": self.secrets.owner },
            "response_format": "Json",
            "payer_account_id": submitter,
        });

        Promise::new(self.outlayer.clone())
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                deposit,
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESULT_CALLBACK_GAS)
                    .on_evaluation_result(id),
            )
    }

    /// Records OutLayer's result for evaluation `id`.
    #[private]
    pub fn on_evaluation_result(&mut self, id: u32) -> EvaluationStatus {
        // Bounded read: an oversized result cannot exhaust the callback's gas.
        let output = match env::promise_result_checked(0, MAX_VERDICT_BYTES) {
            Ok(bytes) => OutlayerResult::Returned(bytes),
            Err(PromiseError::TooLong(_)) => OutlayerResult::TooLarge,
            Err(_) => OutlayerResult::CallFailed,
        };
        let evaluation = self.evaluations.get_mut(id).expect("unknown evaluation");
        require!(evaluation.status == EvaluationStatus::Pending, "evaluation already settled");

        let (status, reasons, verdict) = judge_output(
            &output,
            &self.rules_sha256,
            &evaluation.config_sha256,
            &self.test_set_sha256,
        );
        evaluation.status = status;
        evaluation.reasons = reasons.clone();
        evaluation.verdict = verdict;
        evaluation.settled_at = Some(U64(env::block_timestamp()));

        emit(
            "evaluation_settled",
            json!({ "id": id, "status": status, "reasons": reasons }),
        );
        status
    }

    /// Freezes the challenge's commitments and admits submissions from anyone.
    pub fn open(&mut self) {
        self.assert_owner();
        require!(self.status == ChallengeStatus::Draft, "challenge is already open");
        self.status = ChallengeStatus::Open;
        emit("challenge_opened", json!({ "rules_sha256": self.rules_sha256 }));
    }

    /// Replaces the evaluator build while the challenge is a draft.
    pub fn set_evaluator(&mut self, evaluator: EvaluatorBuild) {
        self.assert_draft_owner();
        assert_sha256_hex(&evaluator.sha256, "evaluator.sha256");
        emit("evaluator_changed", json!({ "url": evaluator.url, "sha256": evaluator.sha256 }));
        self.evaluator = evaluator;
    }

    /// Replaces the test set commitment and its secrets location while the
    /// challenge is a draft.
    pub fn set_test_set(&mut self, test_set_sha256: String, secrets: SecretsLocation) {
        self.assert_draft_owner();
        assert_sha256_hex(&test_set_sha256, "test_set_sha256");
        emit("test_set_changed", json!({ "test_set_sha256": test_set_sha256 }));
        self.test_set_sha256 = test_set_sha256;
        self.secrets = secrets;
    }

    /// Replaces the rules while the challenge is a draft.
    pub fn set_rules(&mut self, rules_json: String) {
        self.assert_draft_owner();
        self.rules_sha256 = sha256_hex(rules_json.as_bytes());
        self.rules_json = rules_json;
        emit("rules_changed", json!({ "rules_sha256": self.rules_sha256 }));
    }

    pub fn get_challenge(&self) -> ChallengeView {
        ChallengeView {
            owner: self.owner.clone(),
            status: self.status,
            outlayer: self.outlayer.clone(),
            evaluator: self.evaluator.clone(),
            secrets: self.secrets.clone(),
            rules_json: self.rules_json.clone(),
            rules_sha256: self.rules_sha256.clone(),
            test_set_sha256: self.test_set_sha256.clone(),
            evaluations: self.evaluations.len(),
        }
    }

    pub fn get_evaluation(&self, id: u32) -> Option<EvaluationView> {
        self.evaluations.get(id).map(|evaluation| EvaluationView {
            id,
            evaluation: evaluation.clone(),
        })
    }

    pub fn get_evaluations(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<EvaluationView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.evaluations.len().min(from.saturating_add(limit)))
            .filter_map(|id| self.get_evaluation(id))
            .collect()
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the challenge owner may do this");
    }

    fn assert_draft_owner(&self) {
        self.assert_owner();
        require!(self.status == ChallengeStatus::Draft, "commitments are frozen once a challenge opens");
    }
}

/// What came back from `request_execution`.
enum OutlayerResult {
    Returned(Vec<u8>),
    TooLarge,
    CallFailed,
}

/// Decides what an OutLayer result means for this challenge. OutLayer
/// returns the evaluator's JSON output, or `null` when the run failed.
fn judge_output(
    output: &OutlayerResult,
    rules_sha256: &str,
    config_sha256: &str,
    test_set_sha256: &str,
) -> (EvaluationStatus, Vec<String>, Option<String>) {
    let rejected = |reason: &str, verdict: Option<String>| {
        (EvaluationStatus::Rejected, vec![reason.to_string()], verdict)
    };
    let bytes = match output {
        OutlayerResult::Returned(bytes) => bytes.as_slice(),
        OutlayerResult::TooLarge => return rejected("verdict_too_large", None),
        OutlayerResult::CallFailed => return rejected("outlayer_call_failed", None),
    };
    if bytes.is_empty() || bytes == b"null" {
        return rejected("execution_failed", None);
    }
    let raw = String::from_utf8_lossy(bytes).into_owned();
    let Ok(verdict) = serde_json::from_slice::<VerdictCommitments>(bytes) else {
        return rejected("verdict_malformed", Some(raw));
    };
    if verdict.rules_sha256 != rules_sha256 {
        return rejected("rules_mismatch", Some(raw));
    }
    if verdict.config_sha256 != config_sha256 {
        return rejected("config_mismatch", Some(raw));
    }
    if verdict.test_set_sha256 != test_set_sha256 {
        // Includes the case where the sealed test set was not injected.
        return rejected("test_set_mismatch", Some(raw));
    }
    if verdict.passed {
        (EvaluationStatus::Passed, Vec::new(), Some(raw))
    } else {
        (EvaluationStatus::Failed, verdict.reasons, Some(raw))
    }
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
            "event": event,
            "data": [data],
        })
    ));
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    env::sha256_array(bytes)
        .iter()
        .flat_map(|b| [HEX[(b >> 4) as usize] as char, HEX[(b & 0xf) as usize] as char])
        .collect()
}

fn assert_sha256_hex(value: &str, field: &str) {
    require!(
        value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        format!("{field} must be 64 lowercase hex characters")
    );
}

#[cfg(test)]
mod tests;
