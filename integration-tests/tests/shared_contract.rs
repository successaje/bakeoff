//! Sandbox test of challenges that run on one shared copy of the contract, published once as a
//! NEAR global contract (NEP-591) and referenced by its code hash. The board's setup form creates
//! such a challenge in one transaction: create the account, send its storage, use the shared
//! code, and call `new`. Needs target/near/bakeoff_contract.wasm; run through
//! `scripts/test-sandbox.sh`.
//!
//! near-workspaces has no helper for global contracts, so the transactions are built and signed
//! here with the nearcore crates it uses.

use anyhow::{bail, Context, Result};
use near_crypto::{InMemorySigner, SecretKey, Signer};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_primitives::types::query::QueryResponseKind;
use near_primitives::action::{
    Action, CreateAccountAction, DeployGlobalContractAction, FunctionCallAction,
    GlobalContractDeployMode, GlobalContractIdentifier, TransferAction, UseGlobalContractAction,
};
use near_primitives::hash::CryptoHash;
use near_primitives::transaction::{SignedTransaction, Transaction, TransactionV0};
use near_primitives::types::{AccountId, Balance, BlockReference, Finality, Gas};
use near_primitives::views::{FinalExecutionStatus, QueryRequest};
use near_workspaces::network::Sandbox;
use near_workspaces::{Account, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::str::FromStr;

fn repo(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = repo(&format!("target/near/{name}.wasm"));
    std::fs::read(&path)
        .with_context(|| format!("{} is missing; run scripts/test-sandbox.sh", path.display()))
}

/// What the board's setup form sends a challenge on the shared code: its rules, its starting
/// state and the account record, at 0.00001 NEAR a byte, rounded up to 0.01 NEAR.
fn shared_storage_deposit(rules_json: &str) -> Balance {
    let bytes = rules_json.len() as u128 + 4_000 + 200;
    let yocto = bytes * 10u128.pow(19);
    let cent = 10u128.pow(22);
    Balance::from_yoctonear(yocto.div_ceil(cent) * cent)
}

async fn send(
    worker: &Worker<Sandbox>,
    signer: &Account,
    receiver: &str,
    actions: Vec<Action>,
) -> Result<()> {
    let client = JsonRpcClient::connect(worker.rpc_addr());
    let secret = SecretKey::from_str(&signer.secret_key().to_string())?;
    let signer_id: AccountId = signer.id().as_str().parse()?;
    let key: Signer = InMemorySigner::from_secret_key(signer_id.clone(), secret.clone());
    let access_key = client
        .call(methods::query::RpcQueryRequest {
            // The latest block: a key added moments ago may not be final yet.
            block_reference: BlockReference::Finality(Finality::None),
            request: QueryRequest::ViewAccessKey {
                account_id: signer_id.clone(),
                public_key: secret.public_key(),
            },
        })
        .await?;
    let QueryResponseKind::AccessKey(view) = access_key.kind else {
        bail!("no access key view")
    };
    let transaction = Transaction::V0(TransactionV0 {
        signer_id,
        public_key: secret.public_key(),
        nonce: view.nonce + 1,
        receiver_id: receiver.parse()?,
        block_hash: access_key.block_hash,
        actions,
    });
    let signature = key.sign(transaction.get_hash_and_size().0.as_ref());
    let outcome = client
        .call(methods::broadcast_tx_commit::RpcBroadcastTxCommitRequest {
            signed_transaction: SignedTransaction::new(signature, transaction),
        })
        .await?;
    match outcome.status {
        FinalExecutionStatus::SuccessValue(_) => Ok(()),
        other => bail!("transaction to {receiver} failed: {other:?}"),
    }
}

#[tokio::test]
#[ignore = "needs the sandbox; run scripts/test-sandbox.sh"]
async fn a_challenge_runs_on_the_shared_code_for_its_storage_alone() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let code = wasm("bakeoff_contract")?;
    let code_hash = CryptoHash::hash_bytes(&code);

    // Published once, by anyone, referenced by its hash: nobody can change what it runs.
    let publisher = worker.dev_create_account().await?;
    send(
        &worker,
        &publisher,
        publisher.id().as_str(),
        vec![Action::DeployGlobalContract(DeployGlobalContractAction {
            code: code.clone().into(),
            deploy_mode: GlobalContractDeployMode::CodeHash,
        })],
    )
    .await?;

    // A host creates a challenge in one transaction, as the setup form does.
    let owner = worker.dev_create_account().await?;
    let challenge = format!("triage.{}", owner.id());
    let rules_json = std::fs::read_to_string(repo("examples/rules/local.json"))?;
    let deposit = shared_storage_deposit(&rules_json);
    let args = json!({
        "owner": owner.id(),
        "outlayer": publisher.id(),
        "evaluator": { "url": "https://example.com/evaluator.wasm", "sha256": "5d3d89ae29b70ee2ddc6e3645bd6239974950a70f2fc0b516ae850907a2fa430" },
        "secrets": { "profile": "bakeoff", "owner": owner.id() },
        "rules_json": rules_json,
        "test_set_sha256": "1b1730710c80057615229d18513308fc0fa3130b8ac281da54d399522ef5b17a",
    });
    send(
        &worker,
        &owner,
        &challenge,
        vec![
            Action::CreateAccount(CreateAccountAction {}),
            Action::Transfer(TransferAction { deposit }),
            Action::UseGlobalContract(Box::new(UseGlobalContractAction {
                contract_identifier: GlobalContractIdentifier::CodeHash(code_hash),
            })),
            Action::FunctionCall(Box::new(FunctionCallAction {
                method_name: "new".into(),
                args: serde_json::to_vec(&args)?,
                gas: Gas::from_teragas(100),
                deposit: Balance::from_yoctonear(0),
            })),
        ],
    )
    .await?;

    // It is a working challenge, locked from the start, that stores only its own state.
    let view: Value = worker
        .view(&challenge.parse()?, "get_challenge")
        .await?
        .json()?;
    if view["status"] != "Draft" || view["owner"] != owner.id().as_str() {
        bail!("unexpected challenge view: {view}");
    }
    let account = worker.view_account(&challenge.parse()?).await?;
    let keys = worker.view_access_keys(&challenge.parse()?).await?;
    if !keys.is_empty() {
        bail!(
            "the challenge has {} access keys; it should have none",
            keys.len()
        );
    }
    if account.storage_usage > 6_000 {
        bail!(
            "the challenge stores {} bytes; with shared code it should store only its state",
            account.storage_usage
        );
    }
    if deposit > Balance::from_millinear(80) {
        bail!("the storage deposit is {deposit}; it should be well under 0.1 NEAR");
    }
    match account.contract_state {
        near_workspaces::ContractState::GlobalHash(hash) if hash.0 == code_hash.0 => Ok(()),
        other => bail!("the challenge does not reference the shared code by hash: {other:?}"),
    }
}
