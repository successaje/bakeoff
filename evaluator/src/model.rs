//! Data model: the rules a sponsor fixes, the candidate a contributor
//! submits, and the labelled tickets the candidate is scored on.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The only schema version this evaluator accepts for rules and candidates.
pub const SCHEMA_VERSION: u32 = 1;

/// Challenge rules. Fixed by the sponsor at creation and hashed into every
/// verdict, so a verdict can only be matched to the rules it was scored under.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rules {
    pub version: u32,
    /// OpenAI-compatible chat completions endpoint.
    pub endpoint: String,
    /// Models a candidate may use, with the prices cost is computed from.
    pub models: BTreeMap<String, Price>,
    /// Tool names a candidate may declare. Empty means no tools.
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    pub categories: Vec<String>,
    pub priorities: Vec<String>,
    pub gates: Gates,
    /// Wall-clock budget for the whole run. A run that exceeds it fails.
    /// Capped well inside NEAR's yield window; see `policy::MAX_TIME_BUDGET_MS`.
    #[serde(default = "default_time_budget_ms")]
    pub time_budget_ms: u64,
    /// Model calls in flight at once.
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: usize,
    /// Extra request body fields a candidate may set per model, such as
    /// reasoning controls. Empty means none.
    #[serde(default)]
    pub allowed_request_options: Vec<String>,
    #[serde(default = "default_max_tokens_cap")]
    pub max_tokens_cap: u32,
    /// Upper bound on the system prompt plus all examples, in characters.
    #[serde(default = "default_max_prompt_chars")]
    pub max_prompt_chars: usize,
    #[serde(default = "default_max_examples")]
    pub max_examples: usize,
    /// Sampling temperature sent with every request. Omitted when unset,
    /// because some models reject the parameter.
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// Model price in US dollars per million tokens.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
}

/// Thresholds a candidate must meet on the test set to pass.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Gates {
    /// Minimum share of tickets with both category and priority correct, in basis points.
    pub min_accuracy_bp: u32,
    /// Maximum mean model cost per ticket, in micro-USD.
    pub max_cost_per_ticket_uusd: u64,
    /// Maximum 95th-percentile end-to-end latency per ticket.
    pub max_p95_latency_ms: u64,
    /// Maximum number of tickets whose output contains a payment card number.
    pub max_leaks: u32,
}

/// A contributor's candidate: configuration for the fixed triage runtime.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateConfig {
    pub version: u32,
    pub model: String,
    pub system_prompt: String,
    #[serde(default)]
    pub examples: Vec<Example>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Extra request body fields for `model`, limited to the rules' list.
    #[serde(default)]
    pub request_options: BTreeMap<String, serde_json::Value>,
    /// Optional second model for answers below a confidence threshold.
    #[serde(default)]
    pub escalation: Option<Escalation>,
    /// Tools the candidate asks to be given. Checked against the rules
    /// before any model is called.
    #[serde(default)]
    pub tools: Vec<ToolSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Example {
    pub ticket: String,
    pub answer: Label,
    /// Shown to the model as the example answer's summary.
    #[serde(default)]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Escalation {
    pub model: String,
    /// Escalate when the first answer's confidence is below this value, or
    /// when the first answer cannot be parsed.
    pub below_confidence: f64,
    /// Extra request body fields for the escalation model.
    #[serde(default)]
    pub request_options: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    #[serde(flatten)]
    pub params: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ticket {
    pub id: String,
    pub text: String,
    pub label: Label,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Label {
    pub category: String,
    pub priority: String,
}

fn default_time_budget_ms() -> u64 {
    75_000
}

fn default_max_concurrency() -> usize {
    8
}

fn default_max_tokens_cap() -> u32 {
    400
}

fn default_max_prompt_chars() -> usize {
    16_000
}

fn default_max_examples() -> usize {
    8
}

fn default_max_tokens() -> u32 {
    150
}
