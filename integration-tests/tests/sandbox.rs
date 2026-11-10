//! End-to-end test of a sealed evaluation in a local NEAR sandbox.
//!
//! The challenge contract runs against a mock OutLayer that uses the same
//! yield/resume handoff as the real one. The test plays the TEE worker: it
//! reads the request the contract sent, runs the real evaluator library on
//! it, and resumes the request with the verdict.
//!
//! The bounty tests follow the money: a funded challenge pays its first
//! passing contributor, a pass whose verdict arrives early waits for the
//! submissions requested before it, and an unwon bounty returns to the owner
//! after the deadline.
//!
//! Needs the contract wasm files; run through `scripts/test-sandbox.sh`.

use anyhow::{ensure, Context, Result};
use bakeoff_evaluator::{
    evaluate_request, ChatClient, ChatCompletion, ChatOutcome, ChatRequest, Clock,
};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

const RULES: &str = "examples/rules/local.json";
const CANDIDATE: &str = "examples/candidates/routed.json";
const TEST_SET: &str = "data/tickets/sealed-sample.json";
const EVALUATOR_SHA256: &str = "5d3d89ae29b70ee2ddc6e3645bd6239974950a70f2fc0b516ae850907a2fa430";
/// 0.025 NEAR for OutLayer plus the contract's 0.01 NEAR record fee.
const SUBMIT_DEPOSIT: NearToken = NearToken::from_millinear(35);
const FORWARDED_DEPOSIT: NearToken = NearToken::from_millinear(25);
/// Storage the record fee pays for, at 0.00001 NEAR per byte.
const RECORD_FEE_BYTES: u64 = 1_000;

fn repo_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

fn read(relative: &str) -> Result<String> {
    std::fs::read_to_string(repo_path(relative)).with_context(|| format!("reading {relative}"))
}

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = repo_path(&format!("target/near/{name}.wasm"));
    std::fs::read(&path)
        .with_context(|| format!("{} is missing; run scripts/test-sandbox.sh", path.display()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Answers every ticket correctly from its label, like a perfect model.
struct LabelledClient {
    answers: HashMap<String, (String, String)>,
}

impl LabelledClient {
    /// Answers every ticket as "other", so the candidate fails accuracy.
    fn wrong(test_set: &str) -> Result<Self> {
        let mut client = Self::new(test_set)?;
        for answer in client.answers.values_mut() {
            answer.0 = "other".into();
        }
        Ok(client)
    }

    fn new(test_set: &str) -> Result<Self> {
        let tickets: Vec<Value> = serde_json::from_str(test_set)?;
        let answers = tickets
            .iter()
            .map(|t| {
                (
                    t["text"].as_str().unwrap().to_string(),
                    (
                        t["label"]["category"].as_str().unwrap().to_string(),
                        t["label"]["priority"].as_str().unwrap().to_string(),
                    ),
                )
            })
            .collect();
        Ok(Self { answers })
    }
}

impl ChatClient for LabelledClient {
    fn complete_all(
        &mut self,
        requests: &[ChatRequest],
        _limit: Duration,
        _max_in_flight: usize,
    ) -> Vec<ChatOutcome> {
        requests
            .iter()
            .map(|request| {
                let result = self
                    .answers
                    .get(&request.messages.last().unwrap().content)
                    .map(|(category, priority)| ChatCompletion {
                        content: json!({"category": category, "priority": priority, "confidence": 0.95, "summary": "Customer needs help."})
                            .to_string(),
                        prompt_tokens: 300,
                        completion_tokens: 40,
                    })
                    .ok_or_else(|| "unknown ticket".to_string());
                ChatOutcome {
                    result,
                    latency_ms: 0,
                    skipped: false,
                }
            })
            .collect()
    }
}

struct StoppedClock;

impl Clock for StoppedClock {
    fn now_ms(&self) -> u64 {
        0
    }
}

struct Setup {
    worker: Worker<Sandbox>,
    owner: Account,
    outlayer: Contract,
    challenge: Contract,
    test_set: String,
}

async fn setup() -> Result<Setup> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let outlayer = worker.dev_deploy(&wasm("mock_outlayer")?).await?;
    outlayer.call("new").transact().await?.into_result()?;

    // Canonical form, as stored in the OutLayer secret: no trailing newlines.
    let test_set = read(TEST_SET)?.trim_end_matches('\n').to_string();
    let challenge = worker.dev_deploy(&wasm("bakeoff_contract")?).await?;
    // Initialised by the contract account itself, as near-cli's
    // deploy-with-init does; the owner is named explicitly.
    challenge
        .call("new")
        .args_json(json!({
            "owner": owner.id(),
            "outlayer": outlayer.id(),
            "evaluator": {
                "url": format!("https://test.fastfs.io/{}/outlayer.testnet/{EVALUATOR_SHA256}.wasm", owner.id()),
                "sha256": EVALUATOR_SHA256,
            },
            "secrets": {"profile": "bakeoff", "owner": owner.id()},
            "rules_json": read(RULES)?,
            "test_set_sha256": sha256_hex(test_set.as_bytes()),
        }))
        .transact()
        .await?
        .into_result()?;
    Ok(Setup {
        worker,
        owner,
        outlayer,
        challenge,
        test_set,
    })
}

/// Waits until the mock has recorded `count` requests.
async fn wait_for_requests(outlayer: &Contract, count: u32) -> Result<()> {
    for _ in 0..60 {
        let seen: u32 = outlayer.view("request_count").await?.json()?;
        if seen >= count {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    anyhow::bail!("OutLayer request never arrived")
}

async fn request_args(outlayer: &Contract, id: u32) -> Result<(Value, Value)> {
    let request: Value = outlayer
        .view("get_request")
        .args_json(json!({"request_id": id}))
        .await?
        .json()?;
    let args: Value = serde_json::from_str(request["args_json"].as_str().unwrap())?;
    Ok((request, args))
}

async fn challenge_view(challenge: &Contract) -> Result<Value> {
    Ok(challenge.view("get_challenge").await?.json()?)
}

async fn block_time_ns(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp())
}

/// Funds the challenge with `bounty` and opens it until `closes_at`.
async fn fund_and_open(
    owner: &Account,
    challenge: &Contract,
    bounty: NearToken,
    closes_at: u64,
) -> Result<()> {
    owner
        .call(challenge.id(), "fund")
        .deposit(bounty)
        .transact()
        .await?
        .into_result()?;
    owner
        .call(challenge.id(), "open")
        .args_json(json!({"closes_at": closes_at.to_string()}))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

/// Submits the candidate as `submitter`, plays the worker with `client`, and
/// waits for the verdict to be recorded.
async fn evaluate_as(
    submitter: &Account,
    setup: &Setup,
    request_id: u32,
    client: &mut LabelledClient,
) -> Result<Value> {
    let candidate = read(CANDIDATE)?;
    let submission = submitter
        .call(setup.challenge.id(), "submit")
        .args_json(json!({"config_json": candidate}))
        .deposit(SUBMIT_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    wait_for_requests(&setup.outlayer, request_id + 1).await?;
    let verdict = evaluate_request(
        &read(RULES)?,
        &candidate,
        Some(&setup.test_set),
        client,
        &StoppedClock,
    );
    setup
        .owner
        .call(setup.outlayer.id(), "resolve")
        .args_json(json!({"request_id": request_id, "output": verdict.to_json()}))
        .transact()
        .await?
        .into_result()?;
    let outcome = submission.await?;
    ensure!(outcome.is_success(), "submit failed: {outcome:?}");
    evaluation(&setup.challenge, request_id).await
}

async fn evaluation(challenge: &Contract, id: u32) -> Result<Value> {
    Ok(challenge
        .view("get_evaluation")
        .args_json(json!({"id": id}))
        .await?
        .json()?)
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn sealed_evaluation_round_trip() -> Result<()> {
    let Setup {
        worker,
        owner,
        outlayer,
        challenge,
        test_set,
    } = setup().await?;
    let candidate = read(CANDIDATE)?;

    // 1. Submit. The transaction stays open until the mock is resumed.
    let submission = owner
        .call(challenge.id(), "submit")
        .args_json(json!({"config_json": candidate}))
        .deposit(SUBMIT_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    wait_for_requests(&outlayer, 1).await?;

    // 2. The request carries everything the worker needs, and nothing else.
    let (request, args) = request_args(&outlayer, 0).await?;
    ensure!(
        request["predecessor"] == json!(challenge.id()),
        "request must come from the challenge"
    );
    ensure!(request["deposit"] == json!(FORWARDED_DEPOSIT.as_yoctonear().to_string()));
    ensure!(args["source"]["WasmUrl"]["hash"] == json!(EVALUATOR_SHA256));
    ensure!(args["source"]["WasmUrl"]["build_target"] == json!("wasm32-wasip2"));
    ensure!(args["resource_limits"]["max_execution_seconds"] == json!(110));
    ensure!(args["response_format"] == json!("Json"));
    ensure!(args["payer_account_id"] == json!(owner.id()));
    ensure!(args["secrets_ref"] == json!({"profile": "bakeoff", "account_id": owner.id()}));
    let input: Value = serde_json::from_str(args["input_data"].as_str().unwrap())?;
    ensure!(input["mode"] == json!("sealed"));
    ensure!(
        input.get("test_set_json").is_none(),
        "the sealed set must never travel in the request"
    );
    ensure!(
        input["config_json"] == json!(candidate),
        "candidate must arrive byte for byte"
    );
    ensure!(
        input["rules_json"] == json!(read(RULES)?),
        "rules must arrive byte for byte"
    );

    // 3. Play the worker: run the real evaluator on exactly what was sent.
    let verdict = evaluate_request(
        input["rules_json"].as_str().unwrap(),
        input["config_json"].as_str().unwrap(),
        Some(&test_set),
        &mut LabelledClient::new(&test_set)?,
        &StoppedClock,
    );
    ensure!(verdict.passed, "labelled answers should pass: {verdict:?}");
    owner
        .call(outlayer.id(), "resolve")
        .args_json(json!({"request_id": 0, "output": verdict.to_json()}))
        .transact()
        .await?
        .into_result()?;

    // 4. The submission settles with the recorded verdict.
    let outcome = submission.await?;
    ensure!(outcome.is_success(), "submit failed: {outcome:?}");
    let recorded = evaluation(&challenge, 0).await?;
    ensure!(
        recorded["status"] == json!("Passed"),
        "unexpected evaluation: {recorded}"
    );
    ensure!(recorded["verdict"] == json!(verdict.to_json()));
    ensure!(!recorded["settled_at"].is_null());

    drop(worker);
    Ok(())
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn untrusted_results_are_rejected() -> Result<()> {
    let Setup {
        worker,
        owner,
        outlayer,
        challenge,
        test_set,
    } = setup().await?;
    let candidate = read(CANDIDATE)?;

    // A verdict scored on a different test set, as if the secrets were swapped.
    let mut tampered: Vec<Value> = serde_json::from_str(&test_set)?;
    tampered.truncate(4);
    let tampered = serde_json::to_string(&tampered)?;

    let cases = [
        (
            Some(
                evaluate_request(
                    &read(RULES)?,
                    &candidate,
                    Some(&tampered),
                    &mut LabelledClient::new(&tampered)?,
                    &StoppedClock,
                )
                .to_json(),
            ),
            "test_set_mismatch",
        ),
        (None, "execution_failed"),
    ];

    for (id, (output, reason)) in cases.into_iter().enumerate() {
        let id = id as u32;
        let submission = owner
            .call(challenge.id(), "submit")
            .args_json(json!({"config_json": candidate}))
            .deposit(SUBMIT_DEPOSIT)
            .gas(Gas::from_tgas(300))
            .transact_async()
            .await?;
        wait_for_requests(&outlayer, id + 1).await?;
        owner
            .call(outlayer.id(), "resolve")
            .args_json(json!({"request_id": id, "output": output}))
            .transact()
            .await?
            .into_result()?;
        ensure!(submission.await?.is_success());
        let recorded = evaluation(&challenge, id).await?;
        ensure!(
            recorded["status"] == json!("Rejected"),
            "case {reason}: {recorded}"
        );
        ensure!(
            recorded["reasons"] == json!([reason]),
            "case {reason}: {recorded}"
        );
    }

    drop(worker);
    Ok(())
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn drafts_refuse_outside_submissions() -> Result<()> {
    let Setup {
        worker, challenge, ..
    } = setup().await?;
    let stranger = worker.dev_create_account().await?;
    let result = stranger
        .call(challenge.id(), "submit")
        .args_json(json!({"config_json": read(CANDIDATE)?}))
        .deposit(SUBMIT_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(
        result.is_failure(),
        "a draft must refuse submissions from non-owners"
    );
    ensure!(format!("{result:?}").contains("challenge is not open for submissions"));
    Ok(())
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn the_first_passing_contributor_is_paid_the_bounty() -> Result<()> {
    let setup = setup().await?;
    let bounty = NearToken::from_near(5);
    let closes_at = block_time_ns(&setup.worker).await? + 3_600_000_000_000;
    fund_and_open(&setup.owner, &setup.challenge, bounty, closes_at).await?;
    let contributor = setup.worker.dev_create_account().await?;
    let before = contributor.view_account().await?.balance;
    let storage_before = setup.challenge.view_account().await?.storage_usage;

    let recorded = evaluate_as(
        &contributor,
        &setup,
        0,
        &mut LabelledClient::new(&setup.test_set)?,
    )
    .await?;
    ensure!(
        recorded["status"] == json!("Passed"),
        "unexpected evaluation: {recorded}"
    );
    ensure!(recorded["eligible"] == json!(true));

    // The payout is its own transfer and callback, which land a block or
    // two after the verdict.
    let mut view = challenge_view(&setup.challenge).await?;
    for _ in 0..40 {
        if view["award"]["paid"] == json!(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        view = challenge_view(&setup.challenge).await?;
    }
    ensure!(
        view["status"] == json!("Awarded"),
        "unexpected challenge: {view}"
    );
    ensure!(view["award"]["in_flight"] == json!(false));
    ensure!(view["award"]["winner"] == json!(contributor.id()));
    ensure!(view["award"]["amount"] == json!(bounty.as_yoctonear().to_string()));
    ensure!(
        view["award"]["paid"] == json!(true),
        "award not paid: {view}"
    );
    ensure!(view["bounty"] == json!("0"));

    // The bounty arrived, less the submission's deposit and its 300 Tgas of
    // prepaid gas, whose unused part may still be on its way back. Without
    // the bounty the balance would have gone down.
    let gained = contributor.view_account().await?.balance.as_yoctonear() as i128
        - before.as_yoctonear() as i128;
    let floor = (bounty.as_yoctonear() - NearToken::from_millinear(500).as_yoctonear()) as i128;
    ensure!(gained > floor, "contributor gained only {gained} yoctoNEAR");

    // The record fee covers the storage the evaluation added.
    let grown = setup.challenge.view_account().await?.storage_usage - storage_before;
    ensure!(
        grown <= RECORD_FEE_BYTES,
        "an evaluation record took {grown} bytes"
    );

    let late = contributor
        .call(setup.challenge.id(), "submit")
        .args_json(json!({"config_json": read(CANDIDATE)?}))
        .deposit(SUBMIT_DEPOSIT)
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(late.is_failure() && format!("{late:?}").contains("the challenge is closed"));
    Ok(())
}

/// Verdicts arrive in any order. A pass waits while an earlier eligible
/// submission is pending, and wins once that one fails. The callback that
/// releases it checks 50 evaluations, the most one call checks, then awards
/// and pays the bounty: the costliest callback the contract can run.
#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn a_pass_waits_for_earlier_submissions_then_wins() -> Result<()> {
    let setup = setup().await?;
    let bounty = NearToken::from_near(5);
    let closes_at = block_time_ns(&setup.worker).await? + 3_600_000_000_000;
    fund_and_open(&setup.owner, &setup.challenge, bounty, closes_at).await?;
    let first = setup.worker.dev_create_account().await?;
    let others = setup.worker.dev_create_account().await?;
    let winner = setup.worker.dev_create_account().await?;

    let rules = read(RULES)?;
    let candidate = read(CANDIDATE)?;
    let pass = evaluate_request(
        &rules,
        &candidate,
        Some(&setup.test_set),
        &mut LabelledClient::new(&setup.test_set)?,
        &StoppedClock,
    )
    .to_json();
    let fail = evaluate_request(
        &rules,
        &candidate,
        Some(&setup.test_set),
        &mut LabelledClient::wrong(&setup.test_set)?,
        &StoppedClock,
    )
    .to_json();

    // Evaluation 0 is `first`'s, 1 to 48 are `others`', and 49 is `winner`'s.
    let mut submissions = Vec::new();
    for (account, count) in [(&first, 1), (&others, 48), (&winner, 1)] {
        for _ in 0..count {
            submissions.push(
                account
                    .call(setup.challenge.id(), "submit")
                    .args_json(json!({"config_json": candidate}))
                    .deposit(SUBMIT_DEPOSIT)
                    .gas(Gas::from_tgas(300))
                    .transact_async()
                    .await?,
            );
        }
        wait_for_requests(&setup.outlayer, submissions.len() as u32).await?;
    }

    // Settle everything but `first`'s submission, failing all but the winner.
    let mut first_request = None;
    let mut resolves = Vec::new();
    for request_id in 0..50 {
        let (_, args) = request_args(&setup.outlayer, request_id).await?;
        let payer = args["payer_account_id"].as_str().context("payer")?;
        if payer == first.id().as_str() {
            first_request = Some(request_id);
        } else {
            let output = if payer == winner.id().as_str() {
                &pass
            } else {
                &fail
            };
            resolves.push(
                Function::new("resolve")
                    .args_json(json!({"request_id": request_id, "output": output}))
                    .gas(Gas::from_tgas(12)),
            );
        }
    }
    while !resolves.is_empty() {
        let batch = resolves
            .drain(..resolves.len().min(20))
            .fold(setup.owner.batch(setup.outlayer.id()), |tx, f| tx.call(f));
        batch.transact().await?.into_result()?;
    }
    let mut view = challenge_view(&setup.challenge).await?;
    for _ in 0..40 {
        if view["pending"] == json!(1) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        view = challenge_view(&setup.challenge).await?;
    }
    ensure!(
        view["pending"] == json!(1),
        "verdicts still pending: {view}"
    );
    ensure!(evaluation(&setup.challenge, 49).await?["status"] == json!("Passed"));
    ensure!(
        view["status"] == json!("Open") && view["award"].is_null(),
        "a pass won while an earlier submission was pending: {view}"
    );
    ensure!(view["next_award_check"] == json!(0));

    setup
        .owner
        .call(setup.outlayer.id(), "resolve")
        .args_json(json!({"request_id": first_request.context("first request")?, "output": fail}))
        .transact()
        .await?
        .into_result()?;
    let mut outcomes = Vec::new();
    for submission in submissions {
        let outcome = submission.await?;
        ensure!(outcome.is_success(), "submit failed: {outcome:?}");
        outcomes.push(outcome);
    }
    let settled = outcomes[0]
        .receipt_outcomes()
        .iter()
        .find(|o| {
            o.executor_id == *setup.challenge.id()
                && o.logs.iter().any(|l| l.contains("\"bounty_awarded\""))
        })
        .context("the award callback")?;
    // The callback has 30 Tgas, 5 of which go to the payment's own callback.
    let burnt = settled.gas_burnt.as_tgas();
    println!("award check over 50 evaluations burnt {burnt} Tgas");
    ensure!(burnt < 20, "the award check burnt {burnt} Tgas");

    for _ in 0..40 {
        view = challenge_view(&setup.challenge).await?;
        if view["award"]["paid"] == json!(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ensure!(
        view["status"] == json!("Awarded"),
        "unexpected challenge: {view}"
    );
    ensure!(view["award"]["evaluation"] == json!(49));
    ensure!(view["award"]["winner"] == json!(winner.id()));
    ensure!(
        view["award"]["paid"] == json!(true),
        "award not paid: {view}"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn an_unwon_bounty_returns_to_the_owner_after_the_deadline() -> Result<()> {
    let setup = setup().await?;
    let bounty = NearToken::from_near(5);
    let closes_at = block_time_ns(&setup.worker).await? + 30_000_000_000;
    fund_and_open(&setup.owner, &setup.challenge, bounty, closes_at).await?;
    let contributor = setup.worker.dev_create_account().await?;
    let recorded = evaluate_as(
        &contributor,
        &setup,
        0,
        &mut LabelledClient::wrong(&setup.test_set)?,
    )
    .await?;
    ensure!(
        recorded["status"] == json!("Failed"),
        "unexpected evaluation: {recorded}"
    );

    let early = setup
        .owner
        .call(setup.challenge.id(), "withdraw_bounty")
        .transact()
        .await?;
    ensure!(early.is_failure() && format!("{early:?}").contains("open until its deadline"));

    while block_time_ns(&setup.worker).await? <= closes_at {
        setup.worker.fast_forward(50).await?;
    }
    let before = setup.owner.view_account().await?.balance;
    setup
        .owner
        .call(setup.challenge.id(), "withdraw_bounty")
        .transact()
        .await?
        .into_result()?;
    let gained = setup.owner.view_account().await?.balance.as_yoctonear() - before.as_yoctonear();
    ensure!(
        gained > bounty.as_yoctonear() - NearToken::from_millinear(10).as_yoctonear(),
        "owner gained only {gained}"
    );
    let view = challenge_view(&setup.challenge).await?;
    ensure!(
        view["status"] == json!("Closed"),
        "unexpected challenge: {view}"
    );
    ensure!(view["bounty"] == json!("0"));
    Ok(())
}
