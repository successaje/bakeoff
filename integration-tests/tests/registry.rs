//! Sandbox tests of the listing registry on a local NEAR node: who may list a challenge, and what
//! a listing costs. Needs target/near/bakeoff_registry.wasm; run through `scripts/test-sandbox.sh`.

use anyhow::{ensure, Context, Result};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};
use std::path::PathBuf;

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("../target/near/{name}.wasm"));
    std::fs::read(&path)
        .with_context(|| format!("{} is missing; run scripts/test-sandbox.sh", path.display()))
}

fn listing() -> Value {
    json!({
        "title": "Support ticket triage",
        "sponsor": "Kettle & Kiln",
        "summary": "Route each message to the right team and urgency.",
        "problem": null,
        "tags": ["Classification", "Customer support"],
        "tickets": 100,
        "baseline": { "accuracy_bp": 8700, "cost_per_ticket_uusd": 128, "p95_latency_ms": 18159 },
        "baseline_config_sha256": "8bb2ccb0aa24288c6be335432488ea7dddd16b52a31c03e084ee8d9c0f86bf58",
        "practice_set": "https://bakeoff-near.vercel.app/data/practice.json",
        "labeling_guide": "https://bakeoff-near.vercel.app/data/labeling-guide.md"
    })
}

#[tokio::test]
#[ignore = "needs the sandbox; run scripts/test-sandbox.sh"]
async fn owners_list_their_own_challenges_and_pay_only_for_storage() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let registry = worker.dev_deploy(&wasm("bakeoff_registry")?).await?;
    registry.call("new").transact().await?.into_result()?;
    let owner = worker.dev_create_account().await?;
    // A challenge account is a sub-account of its owner, as both deploy paths create it.
    let challenge = owner
        .create_subaccount("triage")
        .initial_balance(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;

    let before = owner.view_account().await?.balance;
    let listed = owner
        .call(registry.id(), "list")
        .args_json(json!({ "challenge": challenge.id(), "listing": listing() }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    ensure!(listed.is_success(), "listing failed: {listed:?}");
    let spent = before.as_yoctonear() - owner.view_account().await?.balance.as_yoctonear();
    // The listing's storage (well under 0.02 NEAR) and gas, not the whole attached NEAR.
    ensure!(
        spent < NearToken::from_millinear(20).as_yoctonear(),
        "listing kept {spent} yoctoNEAR of a 1 NEAR deposit"
    );
    ensure!(
        listed
            .logs()
            .iter()
            .any(|l| l.contains(r#""event":"listed""#)),
        "no listed event"
    );

    let view: Value = registry
        .view("get_listing")
        .args_json(json!({ "challenge": challenge.id() }))
        .await?
        .json()?;
    ensure!(
        view["owner"] == owner.id().as_str(),
        "owner is {}",
        view["owner"]
    );
    ensure!(view["listing"]["title"] == "Support ticket triage");

    let stranger = worker.dev_create_account().await?;
    let refused = stranger
        .call(registry.id(), "list")
        .args_json(json!({ "challenge": challenge.id(), "listing": listing() }))
        .deposit(NearToken::from_near(1))
        .max_gas()
        .transact()
        .await?;
    ensure!(
        refused.is_failure(),
        "a stranger listed someone else's challenge"
    );

    let before_unlist = owner.view_account().await?.balance;
    owner
        .call(registry.id(), "unlist")
        .args_json(json!({ "challenge": challenge.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    ensure!(
        owner.view_account().await?.balance > before_unlist,
        "unlisting did not refund the freed storage"
    );
    let gone: Value = registry
        .view("get_listing")
        .args_json(json!({ "challenge": challenge.id() }))
        .await?
        .json()?;
    ensure!(gone.is_null(), "the listing is still there");
    Ok(())
}
