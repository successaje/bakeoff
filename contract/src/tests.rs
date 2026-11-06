use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const RULES: &str = r#"{"version":1,"endpoint":"https://cloud-api.near.ai/v1/chat/completions"}"#;
const CONFIG: &str = r#"{"version":1,"model":"z-ai/glm-5.3-flash","system_prompt":"Triage."}"#;
const TEST_SET_SHA: &str = "1b1730710c80057615229d18513308fc0fa3130b8ac281da54d399522ef5b17a";
const EVALUATOR_SHA: &str = "5d3d89ae29b70ee2ddc6e3645bd6239974950a70f2fc0b516ae850907a2fa430";

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(predecessor: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("challenge.bakeoff.testnet"))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .attached_deposit(NearToken::from_millinear(25))
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn new_contract() -> Contract {
    testing_env!(context("owner.testnet").build());
    Contract::new(
        account("outlayer.testnet"),
        EvaluatorBuild {
            url: "https://test.fastfs.io/owner.testnet/outlayer.testnet/evaluator.wasm".into(),
            sha256: EVALUATOR_SHA.into(),
        },
        SecretsLocation {
            profile: "bakeoff".into(),
            owner: account("owner.testnet"),
        },
        RULES.into(),
        TEST_SET_SHA.into(),
    )
}

fn verdict(passed: bool, reasons: &[&str], rules: &str, config: &str, test_set: &str) -> String {
    json!({
        "version": 1,
        "passed": passed,
        "reasons": reasons,
        "metrics": {"tickets": 16, "completed": 16, "accuracy_bp": 10000},
        "rules_sha256": rules,
        "config_sha256": config,
        "test_set_sha256": test_set,
    })
    .to_string()
}

fn settle(contract: &mut Contract, id: u32, result: PromiseResult) -> EvaluationStatus {
    testing_env!(
        context("challenge.bakeoff.testnet").build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
    contract.on_evaluation_result(id)
}

#[test]
fn new_challenge_is_a_draft_with_hashed_rules() {
    let contract = new_contract();
    let view = contract.get_challenge();
    assert_eq!(view.status, ChallengeStatus::Draft);
    assert_eq!(view.owner, account("owner.testnet"));
    assert_eq!(view.rules_sha256, sha256_hex(RULES.as_bytes()));
    assert_eq!(view.evaluations, 0);
}

#[test]
fn sha256_hex_matches_known_vector() {
    testing_env!(context("owner.testnet").build());
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
#[should_panic(expected = "must be 64 lowercase hex characters")]
fn rejects_malformed_commitments() {
    testing_env!(context("owner.testnet").build());
    Contract::new(
        account("outlayer.testnet"),
        EvaluatorBuild {
            url: "https://x".into(),
            sha256: "ABC".into(),
        },
        SecretsLocation {
            profile: "bakeoff".into(),
            owner: account("owner.testnet"),
        },
        RULES.into(),
        TEST_SET_SHA.into(),
    );
}

#[test]
fn owner_can_trial_a_draft_and_the_request_is_recorded() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    let _ = contract.submit(CONFIG.into());

    let evaluation = contract.get_evaluation(0).unwrap().evaluation;
    assert_eq!(evaluation.status, EvaluationStatus::Pending);
    assert_eq!(evaluation.submitter, account("owner.testnet"));
    assert_eq!(evaluation.config_sha256, sha256_hex(CONFIG.as_bytes()));
    assert!(get_logs()
        .iter()
        .any(|log| log.contains("\"event\":\"evaluation_requested\"")));
}

#[test]
#[should_panic(expected = "challenge is not open for submissions")]
fn others_cannot_submit_to_a_draft() {
    let mut contract = new_contract();
    testing_env!(context("contributor.testnet").build());
    let _ = contract.submit(CONFIG.into());
}

#[test]
fn anyone_can_submit_once_open() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    contract.open();
    testing_env!(context("contributor.testnet").build());
    let _ = contract.submit(CONFIG.into());
    assert_eq!(
        contract.get_evaluation(0).unwrap().evaluation.submitter,
        account("contributor.testnet")
    );
}

#[test]
#[should_panic(expected = "attach at least 0.025 NEAR")]
fn submission_requires_the_execution_deposit() {
    let mut contract = new_contract();
    let mut ctx = context("owner.testnet");
    ctx.attached_deposit(NearToken::from_millinear(10));
    testing_env!(ctx.build());
    let _ = contract.submit(CONFIG.into());
}

#[test]
#[should_panic(expected = "attach at least 200 Tgas")]
fn submission_requires_enough_gas() {
    let mut contract = new_contract();
    let mut ctx = context("owner.testnet");
    ctx.prepaid_gas(Gas::from_tgas(100));
    testing_env!(ctx.build());
    let _ = contract.submit(CONFIG.into());
}

#[test]
#[should_panic(expected = "config_json exceeds 16 KiB")]
fn submission_size_is_bounded() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    let _ = contract.submit("x".repeat(MAX_CONFIG_BYTES + 1));
}

#[test]
fn matching_passing_verdict_is_recorded_as_passed() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    let _ = contract.submit(CONFIG.into());

    let raw = verdict(
        true,
        &[],
        &sha256_hex(RULES.as_bytes()),
        &sha256_hex(CONFIG.as_bytes()),
        TEST_SET_SHA,
    );
    let status = settle(
        &mut contract,
        0,
        PromiseResult::Successful(raw.clone().into_bytes()),
    );

    assert_eq!(status, EvaluationStatus::Passed);
    let evaluation = contract.get_evaluation(0).unwrap().evaluation;
    assert_eq!(evaluation.verdict.as_deref(), Some(raw.as_str()));
    assert!(evaluation.settled_at.is_some());
    assert!(get_logs()
        .iter()
        .any(|log| log.contains("\"event\":\"evaluation_settled\"")));
}

#[test]
fn failing_verdict_keeps_the_evaluator_reasons() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    let _ = contract.submit(CONFIG.into());

    let raw = verdict(
        false,
        &["gate_accuracy", "gate_cost"],
        &sha256_hex(RULES.as_bytes()),
        &sha256_hex(CONFIG.as_bytes()),
        TEST_SET_SHA,
    );
    assert_eq!(
        settle(
            &mut contract,
            0,
            PromiseResult::Successful(raw.into_bytes())
        ),
        EvaluationStatus::Failed
    );
    assert_eq!(
        contract.get_evaluation(0).unwrap().evaluation.reasons,
        ["gate_accuracy", "gate_cost"]
    );
}

#[test]
#[should_panic(expected = "evaluation already settled")]
fn an_evaluation_settles_once() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    let _ = contract.submit(CONFIG.into());
    settle(&mut contract, 0, PromiseResult::Failed);
    settle(&mut contract, 0, PromiseResult::Failed);
}

#[test]
fn judge_rejects_results_that_do_not_match_the_commitments() {
    testing_env!(context("owner.testnet").build());
    let rules = sha256_hex(RULES.as_bytes());
    let config = sha256_hex(CONFIG.as_bytes());
    let other = "0".repeat(64);
    let judge = |output: OutlayerResult| judge_output(&output, &rules, &config, TEST_SET_SHA);
    let returned = |bytes: Vec<u8>| OutlayerResult::Returned(bytes);

    let cases: Vec<(OutlayerResult, &str)> = vec![
        (OutlayerResult::CallFailed, "outlayer_call_failed"),
        (OutlayerResult::TooLarge, "verdict_too_large"),
        (returned(b"null".to_vec()), "execution_failed"),
        (returned(Vec::new()), "execution_failed"),
        (returned(b"{\"passed\":true}".to_vec()), "verdict_malformed"),
        (
            returned(verdict(true, &[], &other, &config, TEST_SET_SHA).into_bytes()),
            "rules_mismatch",
        ),
        (
            returned(verdict(true, &[], &rules, &other, TEST_SET_SHA).into_bytes()),
            "config_mismatch",
        ),
        (
            returned(verdict(true, &[], &rules, &config, "").into_bytes()),
            "test_set_mismatch",
        ),
    ];
    for (output, expected) in cases {
        let (status, reasons, _) = judge(output);
        assert_eq!(status, EvaluationStatus::Rejected, "{expected}");
        assert_eq!(reasons, [expected]);
    }
}

#[test]
#[should_panic(expected = "commitments are frozen once a challenge opens")]
fn opening_freezes_commitments() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    contract.open();
    contract.set_rules("{}".into());
}

#[test]
fn draft_commitments_can_be_updated_by_the_owner() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    let replacement = EvaluatorBuild {
        url: "https://example.com/e.wasm".into(),
        sha256: "f".repeat(64),
    };
    contract.set_evaluator(replacement.clone());
    contract.set_rules("{\"version\":1}".into());
    assert_eq!(contract.get_challenge().evaluator, replacement);
    assert_eq!(
        contract.get_challenge().rules_sha256,
        sha256_hex(b"{\"version\":1}")
    );
}

#[test]
#[should_panic(expected = "only the challenge owner may do this")]
fn only_the_owner_can_open() {
    let mut contract = new_contract();
    testing_env!(context("contributor.testnet").build());
    contract.open();
}

#[test]
fn evaluations_are_paginated() {
    let mut contract = new_contract();
    for _ in 0..5 {
        // Each submission is its own transaction with its own gas.
        testing_env!(context("owner.testnet").build());
        let _ = contract.submit(CONFIG.into());
    }
    let page = contract.get_evaluations(Some(1), Some(2));
    assert_eq!(page.iter().map(|e| e.id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(contract.get_evaluations(Some(4), None).len(), 1);
    assert!(contract.get_evaluations(Some(9), None).is_empty());
}
