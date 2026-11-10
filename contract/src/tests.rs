use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const RULES: &str = r#"{"version":1,"endpoint":"https://cloud-api.near.ai/v1/chat/completions"}"#;
const CONFIG: &str = r#"{"version":1,"model":"z-ai/glm-5.3-flash","system_prompt":"Triage."}"#;
const TEST_SET_SHA: &str = "1b1730710c80057615229d18513308fc0fa3130b8ac281da54d399522ef5b17a";
const EVALUATOR_SHA: &str = "5d3d89ae29b70ee2ddc6e3645bd6239974950a70f2fc0b516ae850907a2fa430";
/// Block time in the tests, and the deadline challenges are opened with.
const NOW: u64 = 1_800_000_000_000_000_000;
const CLOSES_AT: u64 = NOW + 3_600_000_000_000;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn context(predecessor: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("challenge.bakeoff.testnet"))
        .predecessor_account_id(account(predecessor))
        .signer_account_id(account(predecessor))
        .attached_deposit(NearToken::from_millinear(35))
        .prepaid_gas(Gas::from_tgas(300))
        .block_timestamp(NOW);
    builder
}

/// A call that runs at `time`, by `predecessor`, with `deposit` attached.
fn call_at(predecessor: &str, time: u64, deposit: NearToken) {
    let mut ctx = context(predecessor);
    ctx.block_timestamp(time).attached_deposit(deposit);
    testing_env!(ctx.build());
}

/// A callback that runs at `time` and sees `result` from the promise it follows.
fn callback_at(time: u64, result: PromiseResult) {
    let mut ctx = context("challenge.bakeoff.testnet");
    ctx.block_timestamp(time)
        .attached_deposit(NearToken::from_yoctonear(0));
    testing_env!(
        ctx.build(),
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Transfers the last call created, as (receiver, amount).
fn transfers() -> Vec<(AccountId, NearToken)> {
    get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let receiver = r.receiver_id.clone();
            r.actions.into_iter().filter_map(move |a| match a {
                MockAction::Transfer { deposit, .. } => Some((receiver.clone(), deposit)),
                _ => None,
            })
        })
        .collect()
}

fn near(amount: u128) -> NearToken {
    NearToken::from_near(amount)
}

/// A draft funded with `bounty` NEAR, then opened until `CLOSES_AT`.
fn open_challenge(bounty: u128) -> Contract {
    let mut contract = new_contract();
    if bounty > 0 {
        call_at("owner.testnet", NOW, near(bounty));
        contract.fund();
    }
    call_at("owner.testnet", NOW, NearToken::from_yoctonear(0));
    contract.open(U64(CLOSES_AT));
    contract
}

fn submit_at(contract: &mut Contract, submitter: &str, time: u64) -> u32 {
    call_at(submitter, time, NearToken::from_millinear(35));
    let _ = contract.submit(CONFIG.into());
    contract.get_challenge().evaluations - 1
}

fn passing_verdict() -> String {
    verdict(
        true,
        &[],
        &sha256_hex(RULES.as_bytes()),
        &sha256_hex(CONFIG.as_bytes()),
        TEST_SET_SHA,
    )
}

fn failing_verdict() -> String {
    verdict(
        false,
        &["gate_accuracy"],
        &sha256_hex(RULES.as_bytes()),
        &sha256_hex(CONFIG.as_bytes()),
        TEST_SET_SHA,
    )
}

fn settle_at(contract: &mut Contract, id: u32, time: u64, verdict: &str) -> EvaluationStatus {
    callback_at(time, PromiseResult::Successful(verdict.as_bytes().to_vec()));
    contract.on_evaluation_result(id)
}

fn new_contract() -> Contract {
    testing_env!(context("owner.testnet").build());
    Contract::new(
        account("owner.testnet"),
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
fn owner_is_the_named_sponsor_even_when_the_contract_initialises_itself() {
    // near-cli's deploy-with-init signs `new` as the contract account.
    testing_env!(context("challenge.bakeoff.testnet").build());
    let contract = Contract::new(
        account("owner.testnet"),
        account("outlayer.testnet"),
        EvaluatorBuild {
            url: "https://x".into(),
            sha256: EVALUATOR_SHA.into(),
        },
        SecretsLocation {
            profile: "bakeoff".into(),
            owner: account("owner.testnet"),
        },
        RULES.into(),
        TEST_SET_SHA.into(),
    );
    assert_eq!(contract.get_challenge().owner, account("owner.testnet"));
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
        account("owner.testnet"),
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
    contract.open(U64(CLOSES_AT));
    testing_env!(context("contributor.testnet").build());
    let _ = contract.submit(CONFIG.into());
    assert_eq!(
        contract.get_evaluation(0).unwrap().evaluation.submitter,
        account("contributor.testnet")
    );
}

#[test]
#[should_panic(expected = "attach at least 0.035 NEAR")]
fn submission_requires_the_execution_deposit_and_record_fee() {
    let mut contract = new_contract();
    let mut ctx = context("owner.testnet");
    // Enough for OutLayer alone, not for the record as well.
    ctx.attached_deposit(NearToken::from_millinear(30));
    testing_env!(ctx.build());
    let _ = contract.submit(CONFIG.into());
}

#[test]
#[should_panic(expected = "attach at least 220 Tgas")]
fn submission_requires_enough_gas() {
    let mut contract = new_contract();
    let mut ctx = context("owner.testnet");
    ctx.prepaid_gas(Gas::from_tgas(210));
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
    contract.open(U64(CLOSES_AT));
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
    contract.open(U64(CLOSES_AT));
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

#[test]
fn submission_keeps_the_record_fee_and_forwards_the_rest() {
    let mut contract = open_challenge(0);
    call_at("contributor.testnet", NOW, NearToken::from_millinear(50));
    let _ = contract.submit(CONFIG.into());
    let forwarded: Vec<NearToken> = get_created_receipts()
        .into_iter()
        .flat_map(|r| r.actions)
        .filter_map(|a| match a {
            MockAction::FunctionCallWeight {
                method_name,
                attached_deposit,
                ..
            } if method_name == b"request_execution" => Some(attached_deposit),
            _ => None,
        })
        .collect();
    assert_eq!(forwarded, [NearToken::from_millinear(40)]);
    assert_eq!(contract.get_challenge().pending, 1);
}

#[test]
fn owner_funds_the_bounty_in_draft_and_while_open() {
    let mut contract = new_contract();
    call_at("owner.testnet", NOW, near(3));
    contract.fund();
    call_at("owner.testnet", NOW, NearToken::from_yoctonear(0));
    contract.open(U64(CLOSES_AT));
    call_at("owner.testnet", NOW, near(2));
    contract.fund();
    assert_eq!(contract.get_challenge().bounty, near(5));
    assert!(get_logs()
        .iter()
        .any(|log| log.contains("\"event\":\"bounty_funded\"")));
}

#[test]
#[should_panic(expected = "only the challenge owner may do this")]
fn only_the_owner_funds_the_bounty() {
    let mut contract = new_contract();
    call_at("contributor.testnet", NOW, near(1));
    contract.fund();
}

#[test]
#[should_panic(expected = "closes_at must be in the future")]
fn a_challenge_cannot_open_with_a_past_deadline() {
    let mut contract = new_contract();
    testing_env!(context("owner.testnet").build());
    contract.open(U64(NOW));
}

#[test]
fn the_first_eligible_pass_wins_and_is_paid_the_bounty() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "contributor.testnet", NOW);
    assert!(contract.get_evaluation(id).unwrap().evaluation.eligible);

    let status = settle_at(&mut contract, id, NOW + 1, &passing_verdict());
    assert_eq!(status, EvaluationStatus::Passed);
    let challenge = contract.get_challenge();
    assert_eq!(challenge.status, ChallengeStatus::Awarded);
    assert_eq!(challenge.bounty, NearToken::from_yoctonear(0));
    assert_eq!(challenge.pending, 0);
    assert_eq!(
        challenge.award,
        Some(Award {
            evaluation: id,
            winner: account("contributor.testnet"),
            amount: near(5),
            paid: false,
            in_flight: true,
        })
    );
    assert_eq!(transfers(), [(account("contributor.testnet"), near(5))]);

    callback_at(NOW + 2, PromiseResult::Successful(Vec::new()));
    contract.on_award_paid();
    let award = contract.get_challenge().award.unwrap();
    assert!(award.paid && !award.in_flight);
}

#[test]
fn owner_passes_never_win_the_bounty() {
    let mut contract = new_contract();
    call_at("owner.testnet", NOW, near(5));
    contract.fund();
    let draft_trial = submit_at(&mut contract, "owner.testnet", NOW);
    call_at("owner.testnet", NOW, NearToken::from_yoctonear(0));
    contract.open(U64(CLOSES_AT));
    let open_trial = submit_at(&mut contract, "owner.testnet", NOW);

    for id in [draft_trial, open_trial] {
        assert!(!contract.get_evaluation(id).unwrap().evaluation.eligible);
        assert_eq!(
            settle_at(&mut contract, id, NOW + 1, &passing_verdict()),
            EvaluationStatus::Passed
        );
        assert!(transfers().is_empty());
    }
    let challenge = contract.get_challenge();
    assert_eq!(challenge.status, ChallengeStatus::Open);
    assert_eq!(challenge.bounty, near(5));
    assert!(challenge.award.is_none());
}

#[test]
fn a_copied_config_loses_to_the_original_even_when_it_settles_first() {
    // Alice's config is public as soon as her submission lands. Bob submits
    // the same config, and his run happens to finish first.
    let mut contract = open_challenge(5);
    let original = submit_at(&mut contract, "alice.testnet", NOW);
    let copy = submit_at(&mut contract, "bob.testnet", NOW + 1);
    assert_eq!(
        contract
            .get_evaluation(copy)
            .unwrap()
            .evaluation
            .config_sha256,
        contract
            .get_evaluation(original)
            .unwrap()
            .evaluation
            .config_sha256
    );

    settle_at(&mut contract, copy, NOW + 2, &passing_verdict());
    assert!(transfers().is_empty());
    assert_eq!(contract.get_challenge().status, ChallengeStatus::Open);

    settle_at(&mut contract, original, NOW + 3, &passing_verdict());
    let award = contract.get_challenge().award.unwrap();
    assert_eq!(
        (award.evaluation, award.winner),
        (original, account("alice.testnet"))
    );
    assert_eq!(transfers(), [(account("alice.testnet"), near(5))]);
}

#[test]
fn an_earlier_pending_evaluation_holds_a_later_pass() {
    let mut contract = open_challenge(5);
    let earlier = submit_at(&mut contract, "alice.testnet", NOW);
    let later = submit_at(&mut contract, "bob.testnet", NOW + 1);
    assert_eq!(
        settle_at(&mut contract, later, NOW + 2, &passing_verdict()),
        EvaluationStatus::Passed
    );
    let challenge = contract.get_challenge();
    assert_eq!(challenge.status, ChallengeStatus::Open);
    assert_eq!(challenge.bounty, near(5));
    assert!(challenge.award.is_none());
    assert_eq!(challenge.next_award_check, earlier);
    assert!(transfers().is_empty());

    // Alice's run fails, so Bob's held pass is now the earliest and wins.
    settle_at(&mut contract, earlier, NOW + 3, &failing_verdict());
    let award = contract.get_challenge().award.unwrap();
    assert_eq!(
        (award.evaluation, award.winner),
        (later, account("bob.testnet"))
    );
    assert_eq!(transfers(), [(account("bob.testnet"), near(5))]);
}

#[test]
fn owner_trials_do_not_hold_the_award() {
    let mut contract = open_challenge(5);
    submit_at(&mut contract, "owner.testnet", NOW);
    let id = submit_at(&mut contract, "contributor.testnet", NOW + 1);
    settle_at(&mut contract, id, NOW + 2, &passing_verdict());
    assert_eq!(
        contract.get_challenge().award.unwrap().winner,
        account("contributor.testnet")
    );
}

#[test]
fn advance_award_continues_past_a_long_settled_queue() {
    let mut contract = open_challenge(5);
    let first = submit_at(&mut contract, "alice.testnet", NOW);
    for _ in 1..AWARD_CHECKS_PER_CALL + 10 {
        let id = submit_at(&mut contract, "bob.testnet", NOW);
        settle_at(&mut contract, id, NOW + 1, &failing_verdict());
    }
    let winner = submit_at(&mut contract, "carol.testnet", NOW);
    settle_at(&mut contract, winner, NOW + 1, &passing_verdict());
    assert!(contract.get_challenge().award.is_none());

    // The first run fails inside OutLayer. Its callback checks the first 50
    // evaluations and stops there; anyone can continue the check.
    assert_eq!(
        settle(&mut contract, first, PromiseResult::Failed),
        EvaluationStatus::Rejected
    );
    let challenge = contract.get_challenge();
    assert_eq!(challenge.next_award_check, AWARD_CHECKS_PER_CALL);
    assert!(challenge.award.is_none());

    call_at("anyone.testnet", NOW + 2, NearToken::from_yoctonear(0));
    contract.advance_award();
    let award = contract.get_challenge().award.unwrap();
    assert_eq!(
        (award.evaluation, award.winner),
        (winner, account("carol.testnet"))
    );
    assert_eq!(transfers(), [(account("carol.testnet"), near(5))]);
}

#[test]
fn a_failing_verdict_leaves_the_bounty_in_escrow() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "contributor.testnet", NOW);
    let raw = verdict(
        false,
        &["gate_cost"],
        &sha256_hex(RULES.as_bytes()),
        &sha256_hex(CONFIG.as_bytes()),
        TEST_SET_SHA,
    );
    assert_eq!(
        settle_at(&mut contract, id, NOW + 1, &raw),
        EvaluationStatus::Failed
    );
    let challenge = contract.get_challenge();
    assert_eq!(challenge.status, ChallengeStatus::Open);
    assert_eq!(challenge.bounty, near(5));
    assert!(transfers().is_empty());
}

#[test]
#[should_panic(expected = "the challenge is closed")]
fn submissions_stop_once_the_bounty_is_awarded() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "alice.testnet", NOW);
    settle_at(&mut contract, id, NOW + 1, &passing_verdict());
    submit_at(&mut contract, "bob.testnet", NOW + 2);
}

#[test]
#[should_panic(expected = "the deadline for submissions has passed")]
fn submissions_stop_at_the_deadline() {
    let mut contract = open_challenge(5);
    submit_at(&mut contract, "contributor.testnet", CLOSES_AT);
}

#[test]
fn a_submission_made_before_the_deadline_can_win_after_it() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "contributor.testnet", CLOSES_AT - 1);
    settle_at(
        &mut contract,
        id,
        CLOSES_AT + 60_000_000_000,
        &passing_verdict(),
    );
    assert_eq!(contract.get_challenge().status, ChallengeStatus::Awarded);
    assert_eq!(transfers(), [(account("contributor.testnet"), near(5))]);
}

#[test]
fn a_failed_award_payment_can_be_claimed_again() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "contributor.testnet", NOW);
    settle_at(&mut contract, id, NOW + 1, &passing_verdict());
    callback_at(NOW + 2, PromiseResult::Failed);
    contract.on_award_paid();
    let award = contract.get_challenge().award.unwrap();
    assert!(!award.paid && !award.in_flight);

    call_at("anyone.testnet", NOW + 3, NearToken::from_yoctonear(0));
    contract.claim_award();
    assert_eq!(transfers(), [(account("contributor.testnet"), near(5))]);
    assert!(contract.get_challenge().award.unwrap().in_flight);
}

#[test]
#[should_panic(expected = "a payment is already in flight")]
fn an_award_is_not_sent_twice_while_a_payment_is_in_flight() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "contributor.testnet", NOW);
    settle_at(&mut contract, id, NOW + 1, &passing_verdict());
    call_at("contributor.testnet", NOW + 2, NearToken::from_yoctonear(0));
    contract.claim_award();
}

#[test]
fn the_owner_may_withdraw_a_draft_bounty() {
    let mut contract = new_contract();
    call_at("owner.testnet", NOW, near(3));
    contract.fund();
    call_at("owner.testnet", NOW, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
    assert_eq!(transfers(), [(account("owner.testnet"), near(3))]);
    let challenge = contract.get_challenge();
    assert_eq!(challenge.status, ChallengeStatus::Draft);
    assert_eq!(challenge.bounty, NearToken::from_yoctonear(0));
}

#[test]
#[should_panic(expected = "the challenge is open until its deadline")]
fn an_open_bounty_cannot_be_withdrawn_before_the_deadline() {
    let mut contract = open_challenge(5);
    call_at("owner.testnet", CLOSES_AT - 1, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
}

#[test]
#[should_panic(expected = "evaluations submitted before the deadline are still pending")]
fn the_bounty_waits_for_pending_evaluations() {
    let mut contract = open_challenge(5);
    submit_at(&mut contract, "contributor.testnet", CLOSES_AT - 1);
    call_at("owner.testnet", CLOSES_AT, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
}

#[test]
#[should_panic(expected = "call advance_award first")]
fn the_bounty_waits_until_every_settled_evaluation_is_checked() {
    let mut contract = open_challenge(5);
    let first = submit_at(&mut contract, "alice.testnet", NOW);
    for _ in 0..AWARD_CHECKS_PER_CALL {
        let id = submit_at(&mut contract, "bob.testnet", NOW);
        settle_at(&mut contract, id, NOW + 1, &failing_verdict());
    }
    settle_at(&mut contract, first, NOW + 2, &failing_verdict());
    call_at("owner.testnet", CLOSES_AT, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
}

#[test]
fn an_unwon_bounty_returns_to_the_owner_after_the_deadline() {
    let mut contract = open_challenge(5);
    let id = submit_at(&mut contract, "contributor.testnet", NOW);
    let raw = verdict(
        false,
        &["gate_accuracy"],
        &sha256_hex(RULES.as_bytes()),
        &sha256_hex(CONFIG.as_bytes()),
        TEST_SET_SHA,
    );
    settle_at(&mut contract, id, NOW + 1, &raw);

    call_at("owner.testnet", CLOSES_AT, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
    assert_eq!(transfers(), [(account("owner.testnet"), near(5))]);
    let challenge = contract.get_challenge();
    assert_eq!(challenge.status, ChallengeStatus::Closed);
    assert_eq!(challenge.bounty, NearToken::from_yoctonear(0));
}

#[test]
fn a_failed_withdrawal_returns_to_the_bounty() {
    let mut contract = new_contract();
    call_at("owner.testnet", NOW, near(3));
    contract.fund();
    call_at("owner.testnet", NOW, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
    callback_at(NOW + 1, PromiseResult::Failed);
    contract.on_bounty_withdrawn(near(3));
    assert_eq!(contract.get_challenge().bounty, near(3));
}

#[test]
#[should_panic(expected = "the challenge is closed")]
fn a_closed_challenge_takes_no_more_funds() {
    let mut contract = open_challenge(5);
    call_at("owner.testnet", CLOSES_AT, NearToken::from_yoctonear(0));
    contract.withdraw_bounty();
    call_at("owner.testnet", CLOSES_AT + 1, near(1));
    contract.fund();
}
