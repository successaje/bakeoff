//! End-to-end test of a sealed evaluation in a local NEAR sandbox.
//!
//! The challenge contract runs against a mock OutLayer that uses the same
//! yield/resume handoff as the real one. The test plays the TEE worker: it
//! reads the request the contract sent, runs the real evaluator library on
//! it, and resumes the request with the verdict.
//!
//! Needs the contract wasm files; run through `scripts/test-sandbox.sh`.

use anyhow::{ensure, Context, Result};
use bakeoff_evaluator::{
    evaluate_request, ChatClient, ChatCompletion, ChatOutcome, ChatRequest, Clock,
};
use near_workspaces::network::Sandbox;
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
    fn complete_all(&mut self, requests: &[ChatRequest], _limit: Duration) -> Vec<ChatOutcome> {
        requests
            .iter()
            .map(|request| {
                let result = self
                    .answers
                    .get(&request.messages.last().unwrap().content)
                    .map(|(category, priority)| ChatCompletion {
                        content: json!({"category": category, "priority": priority, "confidence": 0.95, "summary": "ok"})
                            .to_string(),
                        prompt_tokens: 300,
                        completion_tokens: 40,
                    })
                    .ok_or_else(|| "unknown ticket".to_string());
                ChatOutcome { result, latency_ms: 0 }
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
        .deposit(NearToken::from_millinear(25))
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
    ensure!(request["deposit"] == json!(NearToken::from_millinear(25).as_yoctonear().to_string()));
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
            .deposit(NearToken::from_millinear(25))
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
        .deposit(NearToken::from_millinear(25))
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
