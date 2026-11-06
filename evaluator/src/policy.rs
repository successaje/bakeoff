//! Checks applied before any model is called. A candidate that fails one is
//! rejected without spending the sponsor's inference budget.

use crate::model::{CandidateConfig, Rules, Ticket, SCHEMA_VERSION};
use crate::verdict::Reason;
use std::collections::HashSet;

const MAX_TEST_SET_TICKETS: usize = 500;

pub fn check_rules(rules: &Rules) -> Result<(), String> {
    if rules.version != SCHEMA_VERSION {
        return Err(format!("unsupported rules version {}", rules.version));
    }
    if !endpoint_allowed(&rules.endpoint) {
        return Err("endpoint must be https, or http on a loopback address".into());
    }
    if rules.models.is_empty() {
        return Err("rules allow no models".into());
    }
    if let Some((name, _)) = rules
        .models
        .iter()
        .find(|(_, p)| !(p.input_usd_per_mtok >= 0.0 && p.output_usd_per_mtok >= 0.0))
    {
        return Err(format!("price for {name} must be non-negative"));
    }
    if rules.categories.is_empty() || rules.priorities.is_empty() {
        return Err("categories and priorities must not be empty".into());
    }
    if rules.gates.min_accuracy_bp > 10_000 {
        return Err("min_accuracy_bp must be at most 10000".into());
    }
    if let Some(t) = rules.temperature {
        if !(0.0..=2.0).contains(&t) {
            return Err("temperature must be between 0 and 2".into());
        }
    }
    Ok(())
}

pub fn check_candidate(rules: &Rules, config: &CandidateConfig) -> Result<(), (Reason, String)> {
    if config.version != SCHEMA_VERSION {
        return Err((Reason::ConfigInvalid, format!("unsupported config version {}", config.version)));
    }
    if !rules.models.contains_key(&config.model) {
        return Err((Reason::PolicyModel, format!("model {} is not allowed", config.model)));
    }
    if let Some(escalation) = &config.escalation {
        if !rules.models.contains_key(&escalation.model) {
            return Err((
                Reason::PolicyModel,
                format!("escalation model {} is not allowed", escalation.model),
            ));
        }
        if !(0.0..=1.0).contains(&escalation.below_confidence) {
            return Err((Reason::ConfigInvalid, "below_confidence must be between 0 and 1".into()));
        }
    }
    if let Some(tool) = config
        .tools
        .iter()
        .find(|tool| !rules.allowed_tools.contains(&tool.name))
    {
        return Err((Reason::PolicyTool, format!("tool {} is not allowed", tool.name)));
    }
    if config.max_tokens == 0 || config.max_tokens > rules.max_tokens_cap {
        return Err((
            Reason::PolicyLimits,
            format!("max_tokens must be between 1 and {}", rules.max_tokens_cap),
        ));
    }
    if config.examples.len() > rules.max_examples {
        return Err((
            Reason::PolicyLimits,
            format!("at most {} examples are allowed", rules.max_examples),
        ));
    }
    let prompt_chars = config.system_prompt.chars().count()
        + config
            .examples
            .iter()
            .map(|e| e.ticket.chars().count())
            .sum::<usize>();
    if prompt_chars > rules.max_prompt_chars {
        return Err((
            Reason::PolicyLimits,
            format!("prompt and examples exceed {} characters", rules.max_prompt_chars),
        ));
    }
    Ok(())
}

/// Validates the sponsor's test set. Failures are reported without detail so
/// that nothing about the sealed tickets reaches the verdict.
pub fn check_test_set(rules: &Rules, tickets: &[Ticket]) -> Result<(), ()> {
    if tickets.is_empty() || tickets.len() > MAX_TEST_SET_TICKETS {
        return Err(());
    }
    let mut ids = HashSet::with_capacity(tickets.len());
    for ticket in tickets {
        let known = rules.categories.iter().any(|c| c.eq_ignore_ascii_case(&ticket.label.category))
            && rules.priorities.iter().any(|p| p.eq_ignore_ascii_case(&ticket.label.priority));
        if !known || !ids.insert(ticket.id.as_str()) {
            return Err(());
        }
    }
    Ok(())
}

fn endpoint_allowed(endpoint: &str) -> bool {
    if endpoint.starts_with("https://") {
        return true;
    }
    ["http://127.0.0.1:", "http://127.0.0.1/", "http://localhost:", "http://localhost/"]
        .iter()
        .any(|prefix| endpoint.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        serde_json::from_str(
            r#"{
                "version": 1,
                "endpoint": "https://cloud-api.near.ai/v1/chat/completions",
                "models": {
                    "small": {"input_usd_per_mtok": 0.1, "output_usd_per_mtok": 0.5},
                    "large": {"input_usd_per_mtok": 2.0, "output_usd_per_mtok": 10.0}
                },
                "allowed_tools": ["order_lookup"],
                "categories": ["billing", "shipping"],
                "priorities": ["low", "high"],
                "gates": {"min_accuracy_bp": 8000, "max_cost_per_ticket_uusd": 1000, "max_p95_latency_ms": 5000, "max_leaks": 0}
            }"#,
        )
        .unwrap()
    }

    fn config(json: &str) -> CandidateConfig {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn accepts_a_conforming_candidate() {
        let c = config(r#"{"version":1,"model":"small","system_prompt":"Triage.","tools":[{"name":"order_lookup"}]}"#);
        assert!(check_rules(&rules()).is_ok());
        assert!(check_candidate(&rules(), &c).is_ok());
    }

    #[test]
    fn rejects_models_outside_the_rules() {
        let c = config(r#"{"version":1,"model":"frontier","system_prompt":"Triage."}"#);
        assert_eq!(check_candidate(&rules(), &c).unwrap_err().0, Reason::PolicyModel);

        let c = config(
            r#"{"version":1,"model":"small","system_prompt":"Triage.","escalation":{"model":"frontier","below_confidence":0.5}}"#,
        );
        assert_eq!(check_candidate(&rules(), &c).unwrap_err().0, Reason::PolicyModel);
    }

    #[test]
    fn rejects_undeclared_tools() {
        let c = config(
            r#"{"version":1,"model":"small","system_prompt":"Triage.","tools":[{"name":"http_post","url":"https://collector.example"}]}"#,
        );
        let (reason, detail) = check_candidate(&rules(), &c).unwrap_err();
        assert_eq!(reason, Reason::PolicyTool);
        assert!(detail.contains("http_post"));
    }

    #[test]
    fn rejects_unknown_config_fields() {
        let parsed: Result<CandidateConfig, _> =
            serde_json::from_str(r#"{"version":1,"model":"small","system_prompt":"x","webhook":"https://x"}"#);
        assert!(parsed.is_err());
    }

    #[test]
    fn enforces_size_limits() {
        let c = config(r#"{"version":1,"model":"small","system_prompt":"Triage.","max_tokens":5000}"#);
        assert_eq!(check_candidate(&rules(), &c).unwrap_err().0, Reason::PolicyLimits);

        let long_prompt = format!(
            r#"{{"version":1,"model":"small","system_prompt":"{}"}}"#,
            "a".repeat(20_000)
        );
        assert_eq!(check_candidate(&rules(), &config(&long_prompt)).unwrap_err().0, Reason::PolicyLimits);
    }

    #[test]
    fn rejects_plain_http_to_remote_hosts() {
        let mut r = rules();
        r.endpoint = "http://api.example.com/v1/chat/completions".into();
        assert!(check_rules(&r).is_err());
        r.endpoint = "http://127.0.0.1:8787/v1/chat/completions".into();
        assert!(check_rules(&r).is_ok());
    }

    #[test]
    fn rejects_test_sets_with_unknown_labels_or_duplicate_ids() {
        let ok: Vec<Ticket> = serde_json::from_str(
            r#"[{"id":"1","text":"a","label":{"category":"billing","priority":"low"}}]"#,
        )
        .unwrap();
        assert!(check_test_set(&rules(), &ok).is_ok());

        let unknown: Vec<Ticket> = serde_json::from_str(
            r#"[{"id":"1","text":"a","label":{"category":"legal","priority":"low"}}]"#,
        )
        .unwrap();
        assert!(check_test_set(&rules(), &unknown).is_err());

        let duplicate: Vec<Ticket> = serde_json::from_str(
            r#"[{"id":"1","text":"a","label":{"category":"billing","priority":"low"}},
                {"id":"1","text":"b","label":{"category":"billing","priority":"high"}}]"#,
        )
        .unwrap();
        assert!(check_test_set(&rules(), &duplicate).is_err());
    }
}
