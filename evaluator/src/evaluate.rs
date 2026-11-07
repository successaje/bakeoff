//! Runs a candidate over a ticket set and judges the result against the gates.

use crate::digest::sha256_hex;
use crate::grading::{contains_card_number, parse_answer, Answer};
use crate::model::{CandidateConfig, Rules, Ticket};
use crate::policy;
use crate::verdict::{Digests, Metrics, Reason, Verdict};
use serde::Serialize;
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: &'static str,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system",
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user",
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant",
            content: content.into(),
        }
    }
}

/// One chat completion request.
#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub temperature: Option<f64>,
    /// Extra body fields, already checked against the rules.
    pub options: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct ChatCompletion {
    pub content: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct ChatOutcome {
    pub result: Result<ChatCompletion, String>,
    /// From sending the request to reading its response.
    pub latency_ms: u64,
    /// The request was never sent because the time budget ran out.
    pub skipped: bool,
}

/// Transport for model calls. The enclave build talks `wasi:http`; tests
/// substitute a scripted client.
pub trait ChatClient {
    /// Sends `requests` with at most `max_in_flight` outstanding and returns
    /// one outcome per request, in order. Nothing may be sent, or keep
    /// running, after `limit`; requests left unsent are marked `skipped`.
    fn complete_all(
        &mut self,
        requests: &[ChatRequest],
        limit: Duration,
        max_in_flight: usize,
    ) -> Vec<ChatOutcome>;
}

pub trait Clock {
    fn now_ms(&self) -> u64;
}

pub struct MonotonicClock {
    start: Instant,
}

impl MonotonicClock {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
        }
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// Scores one candidate. Every failure mode produces a verdict rather than
/// an error, so the contract always learns why a candidate did not pass.
pub fn evaluate_request(
    rules_json: &str,
    config_json: &str,
    test_set_json: Option<&str>,
    client: &mut dyn ChatClient,
    clock: &dyn Clock,
) -> Verdict {
    let digests = Digests {
        rules_sha256: sha256_hex(rules_json.as_bytes()),
        config_sha256: sha256_hex(config_json.as_bytes()),
        test_set_sha256: test_set_json
            .map(|t| sha256_hex(t.as_bytes()))
            .unwrap_or_default(),
    };

    let rules: Rules = match serde_json::from_str(rules_json) {
        Ok(rules) => rules,
        Err(e) => return Verdict::rejected(Reason::RulesInvalid, Some(e.to_string()), digests),
    };
    if let Err(detail) = policy::check_rules(&rules) {
        return Verdict::rejected(Reason::RulesInvalid, Some(detail), digests);
    }

    let config: CandidateConfig = match serde_json::from_str(config_json) {
        Ok(config) => config,
        Err(e) => return Verdict::rejected(Reason::ConfigInvalid, Some(e.to_string()), digests),
    };
    if let Err((reason, detail)) = policy::check_candidate(&rules, &config) {
        return Verdict::rejected(reason, Some(detail), digests);
    }

    let Some(test_set_json) = test_set_json else {
        return Verdict::rejected(Reason::TestSetUnavailable, None, digests);
    };
    let tickets: Vec<Ticket> = match serde_json::from_str(test_set_json) {
        Ok(tickets) => tickets,
        Err(_) => return Verdict::rejected(Reason::TestSetInvalid, None, digests),
    };
    if !policy::test_set_is_valid(&rules, &tickets) {
        return Verdict::rejected(Reason::TestSetInvalid, None, digests);
    }

    let run = run_tickets(&rules, &config, &tickets, client, clock);
    let reasons = judge(&rules, &run);
    Verdict::scored(reasons, run.metrics, digests)
}

struct Run {
    metrics: Metrics,
    timed_out: bool,
}

/// What one ticket has produced so far.
#[derive(Default)]
struct TicketResult {
    answer: Option<Answer>,
    outputs: Vec<String>,
    failed: bool,
    latency_ms: u64,
    cost_uusd: f64,
}

impl TicketResult {
    /// Applies a model call's outcome. An answer that cannot be parsed never
    /// replaces one that could.
    fn apply(&mut self, outcome: ChatOutcome, price_uusd: impl Fn(&ChatCompletion) -> f64) {
        self.latency_ms += outcome.latency_ms;
        match outcome.result {
            Ok(completion) => {
                self.cost_uusd += price_uusd(&completion);
                if let Some(answer) = parse_answer(&completion.content) {
                    self.answer = Some(answer);
                }
                self.outputs.push(completion.content);
                self.failed = false;
            }
            Err(_) => {
                if self.answer.is_none() {
                    self.failed = true;
                }
            }
        }
    }
}

fn run_tickets(
    rules: &Rules,
    config: &CandidateConfig,
    tickets: &[Ticket],
    client: &mut dyn ChatClient,
    clock: &dyn Clock,
) -> Run {
    let started = clock.now_ms();
    let remaining = |clock: &dyn Clock| {
        Duration::from_millis(
            rules
                .time_budget_ms
                .saturating_sub(clock.now_ms().saturating_sub(started)),
        )
    };
    let base_messages = base_messages(rules, config);
    let mut timed_out = false;

    // Every ticket's first call goes out through one sliding window, then
    // every escalation the answers call for.
    let first: Vec<ChatRequest> = tickets
        .iter()
        .map(|t| {
            request(
                rules,
                &base_messages,
                t,
                &config.model,
                &config.request_options,
                config.max_tokens,
            )
        })
        .collect();
    let mut results: Vec<(usize, TicketResult)> = Vec::with_capacity(tickets.len());
    for (i, outcome) in client
        .complete_all(&first, remaining(clock), rules.max_concurrency)
        .into_iter()
        .enumerate()
    {
        if outcome.skipped {
            timed_out = true;
            continue;
        }
        let mut result = TicketResult::default();
        result.apply(outcome, |c| price_uusd(rules, &config.model, c));
        results.push((i, result));
    }

    let mut escalations = 0u32;
    if let (Some(escalation), false) = (&config.escalation, timed_out) {
        let unsure: Vec<usize> = results
            .iter()
            .enumerate()
            .filter(|(_, (_, r))| {
                r.answer
                    .as_ref()
                    .is_none_or(|a| a.confidence < escalation.below_confidence)
            })
            .map(|(slot, _)| slot)
            .collect();
        let second: Vec<ChatRequest> = unsure
            .iter()
            .map(|&slot| {
                request(
                    rules,
                    &base_messages,
                    &tickets[results[slot].0],
                    &escalation.model,
                    &escalation.request_options,
                    config.max_tokens,
                )
            })
            .collect();
        if !second.is_empty() {
            let outcomes = client.complete_all(&second, remaining(clock), rules.max_concurrency);
            for (&slot, outcome) in unsure.iter().zip(outcomes) {
                if outcome.skipped {
                    timed_out = true;
                    continue;
                }
                escalations += 1;
                results[slot]
                    .1
                    .apply(outcome, |c| price_uusd(rules, &escalation.model, c));
            }
        }
    }

    let mut metrics = summarize(&results, tickets);
    metrics.escalations = escalations;
    metrics.elapsed_ms = clock.now_ms().saturating_sub(started);
    if metrics.elapsed_ms > rules.time_budget_ms {
        timed_out = true;
    }
    Run { metrics, timed_out }
}

fn request(
    rules: &Rules,
    base_messages: &[ChatMessage],
    ticket: &Ticket,
    model: &str,
    options: &BTreeMap<String, serde_json::Value>,
    max_tokens: u32,
) -> ChatRequest {
    let mut messages = base_messages.to_vec();
    messages.push(ChatMessage::user(ticket.text.clone()));
    ChatRequest {
        model: model.to_string(),
        messages,
        max_tokens,
        temperature: rules.temperature,
        options: options.clone(),
    }
}

/// Token counts times dollars per million tokens is micro-dollars.
fn price_uusd(rules: &Rules, model: &str, completion: &ChatCompletion) -> f64 {
    let price = rules.models[model];
    completion.prompt_tokens as f64 * price.input_usd_per_mtok
        + completion.completion_tokens as f64 * price.output_usd_per_mtok
}

fn summarize(results: &[(usize, TicketResult)], tickets: &[Ticket]) -> Metrics {
    let mut correct = 0u32;
    let mut category_correct = 0u32;
    let mut leaks = 0u32;
    let mut upstream_errors = 0u32;
    let mut cost_uusd = 0.0_f64;
    let mut latencies: Vec<u64> = Vec::with_capacity(results.len());

    for (index, result) in results {
        let ticket = &tickets[*index];
        cost_uusd += result.cost_uusd;
        latencies.push(result.latency_ms);
        if result.failed && result.answer.is_none() {
            upstream_errors += 1;
        }
        if result.outputs.iter().any(|o| contains_card_number(o)) {
            leaks += 1;
        }
        if let Some(answer) = &result.answer {
            if answer.category.eq_ignore_ascii_case(&ticket.label.category) {
                category_correct += 1;
                if answer.priority.eq_ignore_ascii_case(&ticket.label.priority) {
                    correct += 1;
                }
            }
        }
    }

    let completed = results.len() as u32;
    let cost_uusd = cost_uusd.round() as u64;
    Metrics {
        tickets: tickets.len() as u32,
        completed,
        accuracy_bp: basis_points(correct, completed),
        category_accuracy_bp: basis_points(category_correct, completed),
        cost_uusd,
        cost_per_ticket_uusd: if completed == 0 {
            0
        } else {
            cost_uusd / completed as u64
        },
        p95_latency_ms: percentile_95(&mut latencies),
        mean_latency_ms: if completed == 0 {
            0
        } else {
            latencies.iter().sum::<u64>() / completed as u64
        },
        leaks,
        upstream_errors,
        escalations: 0,
        elapsed_ms: 0,
    }
}

fn judge(rules: &Rules, run: &Run) -> Vec<Reason> {
    let m = &run.metrics;
    if run.timed_out {
        return vec![Reason::Timeout];
    }
    // More than a quarter of tickets failing upstream says more about the
    // model provider than about the candidate; report that instead of gates.
    if m.upstream_errors as u64 * 4 > m.completed as u64 {
        return vec![Reason::UpstreamErrors];
    }
    let gates = &rules.gates;
    let mut reasons = Vec::new();
    if m.accuracy_bp < gates.min_accuracy_bp {
        reasons.push(Reason::GateAccuracy);
    }
    if m.cost_per_ticket_uusd > gates.max_cost_per_ticket_uusd {
        reasons.push(Reason::GateCost);
    }
    if m.p95_latency_ms > gates.max_p95_latency_ms {
        reasons.push(Reason::GateLatency);
    }
    if m.leaks > gates.max_leaks {
        reasons.push(Reason::GateLeaks);
    }
    reasons
}

fn base_messages(rules: &Rules, config: &CandidateConfig) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage::system(format!(
        "{}\n\n{}",
        config.system_prompt.trim_end(),
        output_contract(rules)
    ))];
    for example in &config.examples {
        messages.push(ChatMessage::user(example.ticket.clone()));
        messages.push(ChatMessage::assistant(
            serde_json::json!({
                "category": example.answer.category,
                "priority": example.answer.priority,
                "confidence": 1.0,
            })
            .to_string(),
        ));
    }
    messages
}

/// Appended by the evaluator to every candidate's system prompt, so all
/// candidates answer in the shape the grader reads.
fn output_contract(rules: &Rules) -> String {
    format!(
        "Respond with only a JSON object with these keys: \"category\" (one of: {}), \
         \"priority\" (one of: {}), \"confidence\" (a number from 0 to 1) and \
         \"summary\" (one sentence for the support agent).",
        rules.categories.join(", "),
        rules.priorities.join(", ")
    )
}

fn basis_points(numerator: u32, denominator: u32) -> u32 {
    if denominator == 0 {
        0
    } else {
        (numerator as u64 * 10_000 / denominator as u64) as u32
    }
}

/// Nearest-rank 95th percentile.
fn percentile_95(values: &mut [u64]) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let rank = (values.len() * 95).div_ceil(100);
    values[rank.saturating_sub(1)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    const RULES: &str = r#"{
        "version": 1,
        "endpoint": "https://cloud-api.near.ai/v1/chat/completions",
        "models": {
            "small": {"input_usd_per_mtok": 0.1, "output_usd_per_mtok": 0.5},
            "large": {"input_usd_per_mtok": 2.0, "output_usd_per_mtok": 10.0}
        },
        "allowed_request_options": ["reasoning_effort"],
        "categories": ["billing", "shipping"],
        "priorities": ["low", "high"],
        "gates": {"min_accuracy_bp": 8000, "max_cost_per_ticket_uusd": 1000, "max_p95_latency_ms": 2000, "max_leaks": 0},
        "time_budget_ms": 60000
    }"#;

    const TICKETS: &str = r#"[
        {"id":"1","text":"I was charged twice","label":{"category":"billing","priority":"high"}},
        {"id":"2","text":"Where is my parcel","label":{"category":"shipping","priority":"low"}},
        {"id":"3","text":"Refund my card 4111 1111 1111 1111","label":{"category":"billing","priority":"high"}},
        {"id":"4","text":"Parcel is late","label":{"category":"shipping","priority":"high"}}
    ]"#;

    const ROUTED: &str = r#"{"version":1,"model":"small","system_prompt":"Triage.","escalation":{"model":"large","below_confidence":0.5}}"#;

    struct FakeClock(Rc<Cell<u64>>);

    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
    }

    /// Answers from the ticket text: `large` is always right; `small` gets
    /// ticket 4's priority wrong with low confidence. Calls are scheduled
    /// like the transport's sliding window and advance the clock to the
    /// last one's completion.
    struct ScriptedClient {
        now: Rc<Cell<u64>>,
        batches: Vec<Vec<String>>,
        limits: Vec<Duration>,
        windows: Vec<usize>,
        leak_card: bool,
        fail_model: Option<&'static str>,
    }

    impl ScriptedClient {
        fn new(now: Rc<Cell<u64>>) -> Self {
            Self {
                now,
                batches: Vec::new(),
                limits: Vec::new(),
                windows: Vec::new(),
                leak_card: false,
                fail_model: None,
            }
        }

        fn answer(&self, request: &ChatRequest) -> ChatOutcome {
            let latency_ms = if request.model == "large" { 900 } else { 200 };
            if self.fail_model == Some(request.model.as_str()) {
                return ChatOutcome {
                    result: Err("upstream status 503".into()),
                    latency_ms,
                    skipped: false,
                };
            }
            let ticket = &request.messages.last().unwrap().content;
            let category = if ticket.contains("charged") || ticket.contains("Refund") {
                "billing"
            } else {
                "shipping"
            };
            let (priority, confidence) = match (ticket.as_str(), request.model.as_str()) {
                ("Where is my parcel", _) => ("low", 0.9),
                ("Parcel is late", "small") => ("low", 0.3),
                _ => ("high", 0.9),
            };
            let summary = if self.leak_card && ticket.contains("4111") {
                "Card 4111 1111 1111 1111"
            } else {
                "ok"
            };
            ChatOutcome {
                result: Ok(ChatCompletion {
                    content: format!(
                        r#"{{"category":"{category}","priority":"{priority}","confidence":{confidence},"summary":"{summary}"}}"#
                    ),
                    prompt_tokens: 1_000,
                    completion_tokens: 100,
                }),
                latency_ms,
                skipped: false,
            }
        }
    }

    impl ChatClient for ScriptedClient {
        fn complete_all(
            &mut self,
            requests: &[ChatRequest],
            limit: Duration,
            max_in_flight: usize,
        ) -> Vec<ChatOutcome> {
            self.batches
                .push(requests.iter().map(|r| r.model.clone()).collect());
            self.limits.push(limit);
            self.windows.push(max_in_flight);
            let limit_ms = limit.as_millis() as u64;
            let mut slots = vec![0u64; max_in_flight.max(1)];
            let mut finished = 0;
            let outcomes = requests
                .iter()
                .map(|r| {
                    let slot = (0..slots.len()).min_by_key(|&i| slots[i]).unwrap();
                    if slots[slot] >= limit_ms {
                        return ChatOutcome {
                            result: Err("not sent".into()),
                            latency_ms: 0,
                            skipped: true,
                        };
                    }
                    let outcome = self.answer(r);
                    slots[slot] += outcome.latency_ms;
                    finished = finished.max(slots[slot]);
                    outcome
                })
                .collect();
            self.now.set(self.now.get() + finished);
            outcomes
        }
    }

    fn setup() -> (ScriptedClient, FakeClock) {
        let now = Rc::new(Cell::new(0));
        (ScriptedClient::new(now.clone()), FakeClock(now))
    }

    fn evaluate(config: &str, client: &mut ScriptedClient, clock: &FakeClock) -> Verdict {
        evaluate_request(RULES, config, Some(TICKETS), client, clock)
    }

    #[test]
    fn large_model_passes_quality_but_fails_cost() {
        let (mut client, clock) = setup();
        let v = evaluate(
            r#"{"version":1,"model":"large","system_prompt":"Triage."}"#,
            &mut client,
            &clock,
        );
        let m = v.metrics.clone().unwrap();
        assert_eq!(m.accuracy_bp, 10_000);
        // 1000 * $2/Mtok + 100 * $10/Mtok = 3000 µ$ per ticket
        assert_eq!(m.cost_per_ticket_uusd, 3_000);
        assert_eq!(v.reasons, vec![Reason::GateCost]);
    }

    #[test]
    fn small_model_alone_fails_accuracy() {
        let (mut client, clock) = setup();
        let v = evaluate(
            r#"{"version":1,"model":"small","system_prompt":"Triage."}"#,
            &mut client,
            &clock,
        );
        let m = v.metrics.clone().unwrap();
        assert_eq!(m.accuracy_bp, 7_500);
        assert_eq!(m.cost_per_ticket_uusd, 150);
        assert_eq!(v.reasons, vec![Reason::GateAccuracy]);
    }

    #[test]
    fn routing_escalates_only_unsure_answers_and_passes() {
        let (mut client, clock) = setup();
        let v = evaluate(ROUTED, &mut client, &clock);
        let m = v.metrics.clone().unwrap();
        assert_eq!(m.escalations, 1);
        assert_eq!(m.accuracy_bp, 10_000);
        // All first calls through one window, then the one escalation.
        assert_eq!(client.batches, [vec!["small"; 4], vec!["large"]]);
        // 4 small calls at 150 µ$ plus one large call at 3000 µ$, over 4 tickets
        assert_eq!(m.cost_uusd, 3_600);
        assert_eq!(m.cost_per_ticket_uusd, 900);
        // A ticket's latency is its own calls: 200 ms, or 200 + 900 when escalated.
        assert_eq!(m.p95_latency_ms, 1_100);
        assert_eq!(m.elapsed_ms, 1_100);
        assert!(v.passed, "{v:?}");
    }

    #[test]
    fn calls_share_one_window_and_the_remaining_budget() {
        let (mut client, clock) = setup();
        let rules = RULES.replace(
            "\"time_budget_ms\": 60000",
            "\"time_budget_ms\": 60000, \"max_concurrency\": 3",
        );
        let v = evaluate_request(&rules, ROUTED, Some(TICKETS), &mut client, &clock);
        assert!(v.passed, "{v:?}");
        assert_eq!(client.windows, [3, 3]);
        // Four 200 ms calls in three slots finish at 400 ms, leaving 59.6 s
        // of the budget for the escalation.
        assert_eq!(
            client.limits,
            [Duration::from_millis(60_000), Duration::from_millis(59_600)]
        );
    }

    #[test]
    fn request_options_reach_the_right_model() {
        struct Capture(Vec<ChatRequest>);
        impl ChatClient for Capture {
            fn complete_all(
                &mut self,
                requests: &[ChatRequest],
                _: Duration,
                _: usize,
            ) -> Vec<ChatOutcome> {
                self.0.extend_from_slice(requests);
                requests
                    .iter()
                    .map(|_| ChatOutcome {
                        result: Ok(ChatCompletion {
                            content: r#"{"category":"billing","priority":"high","confidence":0.1}"#
                                .into(),
                            prompt_tokens: 1,
                            completion_tokens: 1,
                        }),
                        latency_ms: 1,
                        skipped: false,
                    })
                    .collect()
            }
        }
        let config = r#"{"version":1,"model":"small","system_prompt":"x","request_options":{"reasoning_effort":"low"},
            "escalation":{"model":"large","below_confidence":0.5}}"#;
        let mut capture = Capture(Vec::new());
        let clock = FakeClock(Rc::new(Cell::new(0)));
        evaluate_request(RULES, config, Some(TICKETS), &mut capture, &clock);
        let small = capture.0.iter().find(|r| r.model == "small").unwrap();
        let large = capture.0.iter().find(|r| r.model == "large").unwrap();
        assert_eq!(
            small.options.get("reasoning_effort"),
            Some(&serde_json::json!("low"))
        );
        assert!(large.options.is_empty());
    }

    #[test]
    fn leaking_a_card_number_fails_the_leak_gate() {
        let (mut client, clock) = setup();
        client.leak_card = true;
        let v = evaluate(ROUTED, &mut client, &clock);
        assert_eq!(v.metrics.as_ref().unwrap().leaks, 1);
        assert_eq!(v.reasons, vec![Reason::GateLeaks]);
    }

    #[test]
    fn policy_rejection_makes_no_model_calls() {
        let (mut client, clock) = setup();
        let v = evaluate(
            r#"{"version":1,"model":"small","system_prompt":"Triage.","tools":[{"name":"http_post","url":"https://collector.example"}]}"#,
            &mut client,
            &clock,
        );
        assert_eq!(v.reasons, vec![Reason::PolicyTool]);
        assert!(v.metrics.is_none());
        assert!(client.batches.is_empty());
    }

    #[test]
    fn upstream_outage_is_reported_instead_of_gates() {
        let (mut client, clock) = setup();
        client.fail_model = Some("small");
        let v = evaluate(
            r#"{"version":1,"model":"small","system_prompt":"Triage."}"#,
            &mut client,
            &clock,
        );
        assert_eq!(v.reasons, vec![Reason::UpstreamErrors]);
        assert_eq!(v.metrics.unwrap().upstream_errors, 4);
    }

    #[test]
    fn escalation_recovers_from_a_failed_first_call() {
        let (mut client, clock) = setup();
        client.fail_model = Some("small");
        let v = evaluate(ROUTED, &mut client, &clock);
        let m = v.metrics.unwrap();
        assert_eq!(m.upstream_errors, 0);
        assert_eq!(m.escalations, 4);
        assert_eq!(m.accuracy_bp, 10_000);
    }

    #[test]
    fn stops_when_the_time_budget_is_exhausted() {
        let (mut client, clock) = setup();
        let rules = RULES.replace(
            "\"time_budget_ms\": 60000",
            "\"time_budget_ms\": 1000, \"max_concurrency\": 1",
        );
        let v = evaluate_request(
            &rules,
            r#"{"version":1,"model":"large","system_prompt":"Triage."}"#,
            Some(TICKETS),
            &mut client,
            &clock,
        );
        assert_eq!(v.reasons, vec![Reason::Timeout]);
        assert_eq!(v.metrics.unwrap().completed, 2);
    }

    #[test]
    fn missing_or_malformed_test_set_is_rejected_without_detail() {
        let (mut client, clock) = setup();
        let config = r#"{"version":1,"model":"small","system_prompt":"Triage."}"#;
        let v = evaluate_request(RULES, config, None, &mut client, &clock);
        assert_eq!(v.reasons, vec![Reason::TestSetUnavailable]);
        assert_eq!(v.digests.test_set_sha256, "");

        let v = evaluate_request(RULES, config, Some("[{\"id\":1}]"), &mut client, &clock);
        assert_eq!(v.reasons, vec![Reason::TestSetInvalid]);
        assert!(v.detail.is_none());
    }

    #[test]
    fn digests_cover_the_exact_bytes_scored() {
        let (mut client, clock) = setup();
        let config = r#"{"version":1,"model":"small","system_prompt":"Triage."}"#;
        let v = evaluate_request(RULES, config, Some(TICKETS), &mut client, &clock);
        assert_eq!(v.digests.rules_sha256, sha256_hex(RULES.as_bytes()));
        assert_eq!(v.digests.config_sha256, sha256_hex(config.as_bytes()));
        assert_eq!(v.digests.test_set_sha256, sha256_hex(TICKETS.as_bytes()));
    }

    #[test]
    fn percentile_uses_nearest_rank() {
        assert_eq!(percentile_95(&mut []), 0);
        assert_eq!(percentile_95(&mut [5]), 5);
        let mut values: Vec<u64> = (1..=20).collect();
        assert_eq!(percentile_95(&mut values), 19);
        let mut values: Vec<u64> = (1..=100).rev().collect();
        assert_eq!(percentile_95(&mut values), 95);
    }
}
