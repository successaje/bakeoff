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
//! after the deadline. A winner who asked to be paid into NEAR Intents gets
//! the bounty as wNEAR in their Intents balance, through mocks of wrap.near
//! and intents.near, and a deposit the verifier refuses comes back as NEAR.
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
    setup_on(near_workspaces::sandbox().await?, None).await
}

/// A challenge on `worker`, initialised with the Intents route `intents` if one is given.
async fn setup_on(worker: Worker<Sandbox>, intents: Option<Value>) -> Result<Setup> {
    setup_with(worker, intents, None).await
}

/// `setup_on`, with a service fee (`{"account", "bps"}`) if one is given.
async fn setup_with(
    worker: Worker<Sandbox>,
    intents: Option<Value>,
    service_fee: Option<Value>,
) -> Result<Setup> {
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
            "intents": intents,
            "service_fee": service_fee,
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
    evaluate_paid_as(submitter, setup, request_id, client, None).await
}

/// `evaluate_as`, with the submitter asking to be paid by `payout` ("Near" or "Intents").
async fn evaluate_paid_as(
    submitter: &Account,
    setup: &Setup,
    request_id: u32,
    client: &mut LabelledClient,
    payout: Option<&str>,
) -> Result<Value> {
    let candidate = read(CANDIDATE)?;
    let submission = submitter
        .call(setup.challenge.id(), "submit")
        .args_json(json!({"config_json": candidate, "payout": payout}))
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
    // With a service fee, so the award callback also sends the fee: the costliest it can be.
    let worker = near_workspaces::sandbox().await?;
    let board = worker.dev_create_account().await?;
    let fee = json!({"account": board.id(), "bps": 250});
    let setup = setup_with(worker, None, Some(fee)).await?;
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
    // The callback has 30 Tgas, 10 of which go to the callbacks of the fee and of the payment.
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
    ensure!(view["award"]["service_fee_sent"] == json!(true));
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

/// 0.00125 NEAR: wrap.near's storage registration, paid once on the way into Intents.
const WNEAR_REGISTRATION: NearToken = NearToken::from_micronear(1_250);

struct IntentsSetup {
    setup: Setup,
    wnear: Contract,
    intents: Contract,
}

/// A challenge whose winners may be paid into NEAR Intents, through mocks of
/// wrap.near and intents.near. The verifier is registered with the token, as
/// intents.near is with wrap.near.
async fn setup_with_intents() -> Result<IntentsSetup> {
    let worker = near_workspaces::sandbox().await?;
    let wnear = worker.dev_deploy(&wasm("mock_wnear")?).await?;
    wnear.call("new").transact().await?.into_result()?;
    let intents = worker.dev_deploy(&wasm("mock_intents")?).await?;
    intents.call("new").transact().await?.into_result()?;
    wnear
        .call("storage_deposit")
        .args_json(json!({"account_id": intents.id(), "registration_only": true}))
        .deposit(WNEAR_REGISTRATION)
        .transact()
        .await?
        .into_result()?;
    let route = json!({"wrap": wnear.id(), "verifier": intents.id()});
    let setup = setup_on(worker, Some(route)).await?;
    Ok(IntentsSetup {
        setup,
        wnear,
        intents,
    })
}

/// Runs a passing evaluation for a new contributor who asked to be paid into
/// Intents, and returns them once the challenge has recorded the award.
async fn win_into_intents(setup: &Setup, bounty: NearToken) -> Result<Account> {
    let closes_at = block_time_ns(&setup.worker).await? + 3_600_000_000_000;
    fund_and_open(&setup.owner, &setup.challenge, bounty, closes_at).await?;
    let contributor = setup.worker.dev_create_account().await?;
    let recorded = evaluate_paid_as(
        &contributor,
        setup,
        0,
        &mut LabelledClient::new(&setup.test_set)?,
        Some("Intents"),
    )
    .await?;
    ensure!(
        recorded["status"] == json!("Passed") && recorded["payout"] == json!("Intents"),
        "unexpected evaluation: {recorded}"
    );
    let view = settled_award(&setup.challenge).await?;
    ensure!(
        view["status"] == json!("Awarded"),
        "unexpected challenge: {view}"
    );
    ensure!(view["award"]["payout"] == json!("Intents"));
    ensure!(
        view["award"]["paid"] == json!(false),
        "an Intents award waits for a claim: {view}"
    );
    Ok(contributor)
}

/// The challenge once its award exists and no payment is in flight.
async fn settled_award(challenge: &Contract) -> Result<Value> {
    let mut view = challenge_view(challenge).await?;
    for _ in 0..40 {
        if view["award"].is_object() && view["award"]["in_flight"] == json!(false) {
            return Ok(view);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        view = challenge_view(challenge).await?;
    }
    anyhow::bail!("the award never settled: {view}")
}

async fn claim(caller: &Account, challenge: &Contract, tgas: u64) -> Result<Value> {
    let outcome = caller
        .call(challenge.id(), "claim_award")
        .gas(Gas::from_tgas(tgas))
        .transact()
        .await?;
    ensure!(outcome.is_success(), "claim_award failed: {outcome:?}");
    settled_award(challenge).await
}

async fn wnear_balance(wnear: &Contract, account: &near_workspaces::AccountId) -> Result<u128> {
    let balance: String = wnear
        .view("ft_balance_of")
        .args_json(json!({"account_id": account}))
        .await?
        .json()?;
    Ok(balance.parse()?)
}

async fn intents_balance(
    mocks: &IntentsSetup,
    account: &near_workspaces::AccountId,
) -> Result<u128> {
    let balance: String = mocks
        .intents
        .view("mt_balance_of")
        .args_json(
            json!({"account_id": account, "token_id": format!("nep141:{}", mocks.wnear.id())}),
        )
        .await?
        .json()?;
    Ok(balance.parse()?)
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn a_winner_can_take_the_bounty_into_near_intents() -> Result<()> {
    let mocks = setup_with_intents().await?;
    let setup = &mocks.setup;
    let bounty = NearToken::from_near(5);
    let contributor = win_into_intents(setup, bounty).await?;
    let deposit = bounty.as_yoctonear() - WNEAR_REGISTRATION.as_yoctonear();

    // Anyone may send it; the owner does here, with the gas the deposit needs.
    let view = claim(&setup.owner, &setup.challenge, 200).await?;
    ensure!(
        view["award"]["paid"] == json!(true),
        "award not paid: {view}"
    );
    ensure!(view["award"]["to_intents"] == json!(deposit.to_string()));
    ensure!(view["award"]["fee"] == json!(WNEAR_REGISTRATION.as_yoctonear().to_string()));
    ensure!(view["award"]["wrapped"] == json!("0"));

    ensure!(intents_balance(&mocks, contributor.id()).await? == deposit);
    ensure!(wnear_balance(&mocks.wnear, mocks.intents.id()).await? == deposit);
    ensure!(wnear_balance(&mocks.wnear, setup.challenge.id()).await? == 0);

    let again = setup
        .owner
        .call(setup.challenge.id(), "claim_award")
        .gas(Gas::from_tgas(200))
        .transact()
        .await?;
    ensure!(again.is_failure() && format!("{again:?}").contains("the award has been paid"));
    Ok(())
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn a_refused_intents_deposit_comes_back_and_is_paid_as_near() -> Result<()> {
    let mocks = setup_with_intents().await?;
    let setup = &mocks.setup;
    mocks
        .intents
        .call("set_refuse")
        .args_json(json!({"refuse": true}))
        .transact()
        .await?
        .into_result()?;
    let bounty = NearToken::from_near(5);
    let contributor = win_into_intents(setup, bounty).await?;
    let deposit = bounty.as_yoctonear() - WNEAR_REGISTRATION.as_yoctonear();

    // The verifier refuses, so the token returns the wNEAR to the challenge,
    // which owes it to the winner as NEAR.
    let view = claim(&setup.owner, &setup.challenge, 200).await?;
    ensure!(
        view["award"]["paid"] == json!(false),
        "unexpected award: {view}"
    );
    ensure!(view["award"]["payout"] == json!("Near"));
    ensure!(view["award"]["wrapped"] == json!(deposit.to_string()));
    ensure!(view["award"]["to_intents"] == json!("0"));
    ensure!(wnear_balance(&mocks.wnear, setup.challenge.id()).await? == deposit);
    ensure!(intents_balance(&mocks, contributor.id()).await? == 0);

    // The next claim unwraps it and sends it as NEAR, with ordinary gas.
    let before = contributor.view_account().await?.balance.as_yoctonear();
    let view = claim(&setup.owner, &setup.challenge, 100).await?;
    ensure!(
        view["award"]["paid"] == json!(true),
        "award not paid: {view}"
    );
    ensure!(view["award"]["wrapped"] == json!("0"));
    ensure!(wnear_balance(&mocks.wnear, setup.challenge.id()).await? == 0);
    let gained = contributor.view_account().await?.balance.as_yoctonear() - before;
    ensure!(
        gained == deposit,
        "contributor gained {gained} yoctoNEAR, expected {deposit}"
    );
    Ok(())
}

/// Waits until the award's payment and its service fee have both settled.
async fn settled_with_fee(challenge: &Contract) -> Result<Value> {
    let mut view = challenge_view(challenge).await?;
    for _ in 0..40 {
        let award = &view["award"];
        if award["paid"] == json!(true) && award["in_flight"] == json!(false) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            return challenge_view(challenge).await;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
        view = challenge_view(challenge).await?;
    }
    anyhow::bail!("the award was not paid: {view}")
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn a_won_bounty_pays_the_service_fee_and_the_rest_to_the_winner() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let board = worker.dev_create_account().await?;
    let setup = setup_with(
        worker,
        None,
        Some(json!({"account": board.id(), "bps": 250})),
    )
    .await?;
    let bounty = NearToken::from_near(5);
    let fee = NearToken::from_millinear(125);
    let closes_at = block_time_ns(&setup.worker).await? + 3_600_000_000_000;
    fund_and_open(&setup.owner, &setup.challenge, bounty, closes_at).await?;
    ensure!(
        challenge_view(&setup.challenge).await?["service_fee"]
            == json!({"account": board.id(), "bps": 250})
    );
    let board_before = board.view_account().await?.balance;
    let contributor = setup.worker.dev_create_account().await?;
    let before = contributor.view_account().await?.balance;

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
    let view = settled_with_fee(&setup.challenge).await?;
    ensure!(view["award"]["amount"] == json!(bounty.as_yoctonear().to_string()));
    ensure!(view["award"]["service_fee"] == json!(fee.as_yoctonear().to_string()));
    ensure!(
        view["award"]["service_fee_sent"] == json!(true),
        "fee not sent: {view}"
    );

    // The fee arrives whole; the winner gets the rest, less their own submission's costs.
    let board_gained =
        board.view_account().await?.balance.as_yoctonear() - board_before.as_yoctonear();
    ensure!(
        board_gained == fee.as_yoctonear(),
        "the fee account gained {board_gained} yoctoNEAR"
    );
    let gained = contributor.view_account().await?.balance.as_yoctonear() as i128
        - before.as_yoctonear() as i128;
    let rest = (bounty.as_yoctonear() - fee.as_yoctonear()) as i128;
    let floor = rest - NearToken::from_millinear(500).as_yoctonear() as i128;
    ensure!(
        gained > floor && gained < rest,
        "contributor gained {gained} yoctoNEAR"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "needs built contract wasm; run scripts/test-sandbox.sh"]
async fn a_fee_that_cannot_be_delivered_waits_to_be_sent_again() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    // An account that does not exist yet, so the first transfer to it fails.
    let missing = "board-fee.test.near";
    let setup = setup_with(
        worker,
        None,
        Some(json!({"account": missing, "bps": 1_000})),
    )
    .await?;
    let bounty = NearToken::from_near(2);
    let closes_at = block_time_ns(&setup.worker).await? + 3_600_000_000_000;
    fund_and_open(&setup.owner, &setup.challenge, bounty, closes_at).await?;
    let contributor = setup.worker.dev_create_account().await?;
    evaluate_as(
        &contributor,
        &setup,
        0,
        &mut LabelledClient::new(&setup.test_set)?,
    )
    .await?;
    let view = settled_with_fee(&setup.challenge).await?;
    ensure!(
        view["award"]["service_fee_sent"] == json!(false),
        "fee marked sent: {view}"
    );

    // Once the account exists, anyone can send the fee again, and only once.
    let board = setup
        .worker
        .root_account()?
        .create_subaccount("board-fee")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    let before = board.view_account().await?.balance;
    let claim = contributor
        .call(setup.challenge.id(), "claim_service_fee")
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    ensure!(claim.is_success(), "claim failed: {claim:?}");
    ensure!(challenge_view(&setup.challenge).await?["award"]["service_fee_sent"] == json!(true));
    let gained = board.view_account().await?.balance.as_yoctonear() - before.as_yoctonear();
    ensure!(
        gained == NearToken::from_millinear(200).as_yoctonear(),
        "the fee account gained {gained} yoctoNEAR"
    );
    let again = contributor
        .call(setup.challenge.id(), "claim_service_fee")
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    ensure!(again.is_failure() && format!("{again:?}").contains("the service fee has been sent"));
    Ok(())
}
