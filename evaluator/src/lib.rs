//! Bakeoff sealed evaluator.
//!
//! Scores one candidate configuration of a support-ticket triage agent
//! against a labelled test set, under rules the challenge sponsor fixed when
//! the challenge was created. `main.rs` runs this inside an OutLayer worker;
//! everything except the network transport lives here so it can be tested
//! natively.

pub mod digest;
pub mod evaluate;
pub mod grading;
pub mod model;
pub mod openai;
pub mod policy;
pub mod verdict;

#[cfg(target_arch = "wasm32")]
pub mod wasi_http;

pub use evaluate::{
    evaluate_request, ChatClient, ChatCompletion, ChatMessage, ChatOutcome, ChatRequest, Clock,
    MonotonicClock,
};
pub use verdict::{Digests, Metrics, Reason, Verdict};
