//! Bakeoff sealed evaluator.
//!
//! Scores one candidate configuration of a support-ticket triage agent
//! against a labelled test set, under rules the challenge sponsor fixed when
//! the challenge was created.

pub mod digest;
pub mod grading;
pub mod model;
pub mod policy;
pub mod verdict;

pub use verdict::{Digests, Metrics, Reason, Verdict};
