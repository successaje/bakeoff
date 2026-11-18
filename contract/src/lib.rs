//! Bakeoff challenge contract.
//!
//! Holds one challenge's rules together with commitments to the evaluator
//! build and the sealed test set. Each submitted candidate is sent to
//! OutLayer, scored inside a TEE by the committed evaluator, and the verdict
//! is recorded here. A verdict is accepted only if it names the exact rules,
//! candidate and test set this contract committed to; anything else is
//! recorded as rejected.
//!
//! A challenge starts as a draft, in which the owner may adjust its
//! commitments, escrow a bounty and run trial evaluations. Opening it
//! freezes the commitments, sets a deadline and admits submissions from
//! anyone. The earliest-requested submission that passes every gate wins the
//! bounty, which the contract pays once every eligible submission requested
//! before it has settled. Verdicts arrive in any order, so this keeps a copy
//! of a public config from winning just because its run finished first. If
//! none passes by the deadline, the owner withdraws the bounty.
//!
//! A challenge may be deployed with a service fee: a share of the bounty, at
//! most 10%, paid to a named account when the bounty is awarded. It is fixed
//! at deployment, so builders see it before they submit, and nothing is taken
//! when nobody wins.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::store::Vector;
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

/// Gas forwarded to `request_execution`. OutLayer reserves its own response
/// callback out of this.
const OUTLAYER_GAS: Gas = Gas::from_tgas(150);
/// Enough to judge the verdict and start a bounty payout.
const RESULT_CALLBACK_GAS: Gas = Gas::from_tgas(30);
const TRANSFER_CALLBACK_GAS: Gas = Gas::from_tgas(5);
/// Prepaid gas a submission needs: this call, OutLayer, and the callback.
const MIN_SUBMIT_GAS: Gas = Gas::from_tgas(220);
/// Covers OutLayer's estimate for the resource limits below (0.019 NEAR at
/// the time of writing). Whatever is unused is refunded to the submitter.
const MIN_EXECUTION_DEPOSIT: NearToken = NearToken::from_millinear(25);
/// Kept from each submission to pay for its evaluation record (1 KB of
/// storage), so submissions cannot lock up the balance that holds the bounty.
const RECORD_FEE: NearToken = NearToken::from_millinear(10);

const MAX_INSTRUCTIONS: u64 = 1_000_000_000;
const MAX_MEMORY_MB: u32 = 128;
/// Below OutLayer's 180 s cap on purpose: the result is delivered by
/// resuming a NEAR yield, which times out after 200 blocks (about 119 s on
/// testnet). A run that outlives the yield produces no verdict at all.
const MAX_EXECUTION_SECONDS: u64 = 110;

const MAX_CONFIG_BYTES: usize = 16 * 1024;
/// The evaluator's verdicts are under 900 bytes. A longer one is rejected
/// rather than stored, which keeps a record within what `RECORD_FEE` pays for.
const MAX_VERDICT_BYTES: usize = 1024;
/// Settled evaluations checked for the award in one call. Bounded so that a
/// flood of submissions cannot push a verdict's callback past its gas;
/// `advance_award` continues from where a call stopped.
const AWARD_CHECKS_PER_CALL: u32 = 50;
const EVENT_STANDARD: &str = "bakeoff";
const EVENT_VERSION: &str = "1.3.0";

/// The largest service fee a challenge can be deployed with: 10% of the bounty.
const MAX_SERVICE_FEE_BPS: u16 = 1_000;

/// wrap.near's storage registration, paid once from a reward sent into NEAR Intents.
const WNEAR_REGISTRATION: NearToken = NearToken::from_micronear(1_250);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const WRAP_GAS: Gas = Gas::from_tgas(10);
/// `ft_transfer_call` to the Intents verifier, with its `ft_on_transfer` and the token's resolve,
/// as NEAR Intents' deposit guide budgets it.
const INTENTS_DEPOSIT_GAS: Gas = Gas::from_tgas(100);
const INTENTS_CALLBACK_GAS: Gas = Gas::from_tgas(15);
/// The unwrap's callback sends the NEAR on and schedules the payment's own callback.
const UNWRAP_CALLBACK_GAS: Gas = Gas::from_tgas(20);
/// What `claim_award` needs to send a reward into NEAR Intents: the wrap, the deposit and the callback.
const MIN_INTENTS_CLAIM_GAS: Gas = Gas::from_tgas(160);

/// The contracts a reward goes through to reach a winner's NEAR Intents balance: the wNEAR token,
/// since the Intents verifier takes NEP-141 tokens rather than NEAR, and the verifier. Set only
/// where NEAR Intents runs: on mainnet, wrap.near and intents.near.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IntentsRoute {
    pub wrap: AccountId,
    pub verifier: AccountId,
}

/// A share of an awarded bounty paid to whoever runs the board the challenge is listed on. Fixed
/// when the challenge is deployed; taken only from a bounty that is won.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ServiceFee {
    pub account: AccountId,
    /// Basis points of the bounty: 250 is 2.5%. Between 1 and 1,000.
    pub bps: u16,
}

impl ServiceFee {
    /// The fee on `amount`, rounded down.
    fn of(&self, amount: NearToken) -> NearToken {
        NearToken::from_yoctonear(amount.as_yoctonear() * u128::from(self.bps) / 10_000)
    }
}

/// How a submitter wants to be paid if they win.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Payout {
    /// NEAR to the winner's account, in the transaction that records the result.
    #[default]
    Near,
    /// wNEAR into the winner's NEAR Intents balance, from which they can take it as another
    /// token or to another chain. Sent by `claim_award`, which anyone may call.
    Intents,
}

/// A published evaluator build, run by URL and pinned by its SHA-256.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EvaluatorBuild {
    pub url: String,
    pub sha256: String,
}

/// Where OutLayer finds the sealed test set and model API key.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SecretsLocation {
    pub profile: String,
    pub owner: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChallengeStatus {
    /// Commitments may change; only the owner may submit.
    Draft,
    /// Commitments are frozen; anyone may submit until the deadline.
    Open,
    /// A submission passed and won the bounty.
    Awarded,
    /// The deadline passed without a winner and the owner withdrew the bounty.
    Closed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvaluationStatus {
    /// Sent to OutLayer, no result yet.
    Pending,
    /// The evaluator scored the candidate and every gate passed.
    Passed,
    /// The evaluator scored or screened the candidate and it did not pass.
    Failed,
    /// No trustworthy verdict: the execution failed, or the verdict does not
    /// match this challenge's commitments.
    Rejected,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Evaluation {
    pub submitter: AccountId,
    pub config_sha256: String,
    /// Whether a pass can win the bounty: submitted while the challenge was
    /// open, by someone other than the owner.
    pub eligible: bool,
    pub status: EvaluationStatus,
    /// Evaluator reason codes for `Failed`, or the contract's reason for `Rejected`.
    pub reasons: Vec<String>,
    /// The verdict exactly as the evaluator printed it, when one was returned.
    pub verdict: Option<String>,
    /// How the submitter is paid if this evaluation wins.
    pub payout: Payout,
    pub requested_at: U64,
    pub settled_at: Option<U64>,
}

/// The bounty won by the earliest-requested eligible pass.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Award {
    pub evaluation: u32,
    pub winner: AccountId,
    pub amount: NearToken,
    pub paid: bool,
    /// A transfer has been sent and its outcome is not known yet.
    pub in_flight: bool,
    /// How the rest is paid. An Intents payout that fails turns to NEAR for the next claim.
    pub payout: Payout,
    /// Deposited into the winner's NEAR Intents balance.
    pub to_intents: NearToken,
    /// Spent registering this contract with the wNEAR token, once, on the way to Intents.
    pub fee: NearToken,
    /// wNEAR this contract holds for the winner: a deposit the verifier refused. The next claim
    /// unwraps it and pays it as NEAR.
    pub wrapped: NearToken,
    /// The service fee taken from `amount`; the winner is paid the rest.
    pub service_fee: NearToken,
    /// The fee has been sent to its account. Back to false if that transfer failed, for
    /// `claim_service_fee` to send again.
    pub service_fee_sent: bool,
}

#[near(serializers = [json])]
pub struct ChallengeView {
    pub owner: AccountId,
    pub status: ChallengeStatus,
    pub outlayer: AccountId,
    pub evaluator: EvaluatorBuild,
    pub secrets: SecretsLocation,
    pub rules_json: String,
    pub rules_sha256: String,
    pub test_set_sha256: String,
    pub evaluations: u32,
    /// Evaluations sent to OutLayer whose verdict has not arrived.
    pub pending: u32,
    /// Escrowed and not yet awarded or withdrawn.
    pub bounty: NearToken,
    /// Nanoseconds since the Unix epoch; set when the challenge opens.
    pub closes_at: Option<U64>,
    pub award: Option<Award>,
    /// Evaluations before this id have been checked for the award, in the
    /// order they were requested. A pass after it waits for earlier ones.
    pub next_award_check: u32,
    /// Where a winner may choose to be paid into NEAR Intents, if anywhere.
    pub intents: Option<IntentsRoute>,
    /// The share of an awarded bounty that goes to the board's operator, if any.
    pub service_fee: Option<ServiceFee>,
}

#[near(serializers = [json])]
pub struct EvaluationView {
    pub id: u32,
    #[serde(flatten)]
    pub evaluation: Evaluation,
}

/// The verdict fields the contract checks. Metrics are kept in the raw
/// verdict and not interpreted here.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct VerdictCommitments {
    passed: bool,
    #[serde(default)]
    reasons: Vec<String>,
    rules_sha256: String,
    config_sha256: String,
    test_set_sha256: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    status: ChallengeStatus,
    outlayer: AccountId,
    evaluator: EvaluatorBuild,
    secrets: SecretsLocation,
    rules_json: String,
    rules_sha256: String,
    test_set_sha256: String,
    evaluations: Vector<Evaluation>,
    pending: u32,
    bounty: NearToken,
    closes_at: Option<U64>,
    award: Option<Award>,
    next_award_check: u32,
    intents: Option<IntentsRoute>,
    service_fee: Option<ServiceFee>,
}

#[near]
impl Contract {
    #[init]
    #[allow(clippy::too_many_arguments)]
    /// `owner` is explicit because deploy-and-initialise transactions are
    /// signed by the contract account itself, so the caller is not the sponsor.
    /// `service_fee` is fixed here and never changes.
    pub fn new(
        owner: AccountId,
        outlayer: AccountId,
        evaluator: EvaluatorBuild,
        secrets: SecretsLocation,
        rules_json: String,
        test_set_sha256: String,
        intents: Option<IntentsRoute>,
        service_fee: Option<ServiceFee>,
    ) -> Self {
        assert_sha256_hex(&evaluator.sha256, "evaluator.sha256");
        assert_sha256_hex(&test_set_sha256, "test_set_sha256");
        if let Some(fee) = &service_fee {
            require!(
                fee.bps >= 1 && fee.bps <= MAX_SERVICE_FEE_BPS,
                "the service fee is between 1 and 1000 basis points (10%)"
            );
            require!(
                fee.account != env::current_account_id(),
                "the service fee must go to another account"
            );
        }
        Self {
            owner,
            status: ChallengeStatus::Draft,
            outlayer,
            evaluator,
            secrets,
            rules_sha256: sha256_hex(rules_json.as_bytes()),
            rules_json,
            test_set_sha256,
            evaluations: Vector::new(b"e"),
            pending: 0,
            bounty: NearToken::from_yoctonear(0),
            closes_at: None,
            award: None,
            next_award_check: 0,
            intents,
            service_fee,
        }
    }

    /// Adds the attached deposit to the bounty. Only the owner funds a
    /// challenge, so a withdrawal can only ever return money to its source.
    #[payable]
    pub fn fund(&mut self) {
        self.assert_owner();
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "attach the amount to add to the bounty");
        match self.status {
            ChallengeStatus::Draft => {}
            ChallengeStatus::Open => require!(!self.deadline_passed(), "the deadline has passed"),
            _ => env::panic_str("the challenge is closed"),
        }
        self.bounty = self.bounty.saturating_add(amount);
        emit(
            "bounty_funded",
            json!({ "amount": amount, "bounty": self.bounty }),
        );
    }

    /// Sends a candidate configuration for sealed evaluation. Attach at least
    /// 0.035 NEAR and 220 Tgas: 0.01 NEAR pays for the evaluation record, and
    /// the rest goes to OutLayer, which refunds what the run did not use.
    /// `payout` says how to pay the submitter if they win: NEAR (the default),
    /// or into their NEAR Intents balance where the challenge has a route.
    #[payable]
    pub fn submit(&mut self, config_json: String, payout: Option<Payout>) -> Promise {
        let submitter = env::predecessor_account_id();
        let payout = payout.unwrap_or_default();
        require!(
            payout == Payout::Near || self.intents.is_some(),
            "this challenge cannot pay into NEAR Intents"
        );
        match self.status {
            ChallengeStatus::Draft => require!(
                submitter == self.owner,
                "challenge is not open for submissions"
            ),
            ChallengeStatus::Open => require!(
                !self.deadline_passed(),
                "the deadline for submissions has passed"
            ),
            ChallengeStatus::Awarded | ChallengeStatus::Closed => {
                env::panic_str("the challenge is closed")
            }
        }
        require!(!config_json.is_empty(), "config_json is empty");
        require!(
            config_json.len() <= MAX_CONFIG_BYTES,
            "config_json exceeds 16 KiB"
        );
        let deposit = env::attached_deposit();
        require!(
            deposit >= MIN_EXECUTION_DEPOSIT.saturating_add(RECORD_FEE),
            "attach at least 0.035 NEAR: 0.025 for the sealed evaluation and 0.01 for its record"
        );
        require!(
            env::prepaid_gas() >= MIN_SUBMIT_GAS,
            "attach at least 220 Tgas"
        );
        let execution_deposit = deposit.saturating_sub(RECORD_FEE);

        let config_sha256 = sha256_hex(config_json.as_bytes());
        let id = self.evaluations.len();
        let eligible = self.status == ChallengeStatus::Open && submitter != self.owner;
        self.evaluations.push(Evaluation {
            submitter: submitter.clone(),
            config_sha256: config_sha256.clone(),
            eligible,
            status: EvaluationStatus::Pending,
            reasons: Vec::new(),
            verdict: None,
            payout,
            requested_at: U64(env::block_timestamp()),
            settled_at: None,
        });
        self.pending += 1;
        emit(
            "evaluation_requested",
            json!({
                "id": id,
                "submitter": submitter,
                "config_sha256": config_sha256,
                "eligible": eligible,
                "payout": payout,
            }),
        );

        let input_data = json!({
            "mode": "sealed",
            "rules_json": self.rules_json,
            "config_json": config_json,
        })
        .to_string();
        let args = json!({
            "source": { "WasmUrl": {
                "url": self.evaluator.url,
                "hash": self.evaluator.sha256,
                "build_target": "wasm32-wasip2",
            }},
            "resource_limits": {
                "max_instructions": MAX_INSTRUCTIONS,
                "max_memory_mb": MAX_MEMORY_MB,
                "max_execution_seconds": MAX_EXECUTION_SECONDS,
            },
            "input_data": input_data,
            "secrets_ref": { "profile": self.secrets.profile, "account_id": self.secrets.owner },
            "response_format": "Json",
            "payer_account_id": submitter,
        });

        Promise::new(self.outlayer.clone())
            .function_call(
                "request_execution".to_string(),
                args.to_string().into_bytes(),
                execution_deposit,
                OUTLAYER_GAS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESULT_CALLBACK_GAS)
                    .on_evaluation_result(id),
            )
    }

    /// Records OutLayer's result for evaluation `id`.
    #[private]
    pub fn on_evaluation_result(&mut self, id: u32) -> EvaluationStatus {
        // Bounded read: an oversized result cannot exhaust the callback's gas.
        let output = match env::promise_result_checked(0, MAX_VERDICT_BYTES) {
            Ok(bytes) => OutlayerResult::Returned(bytes),
            Err(PromiseError::TooLong(_)) => OutlayerResult::TooLarge,
            Err(_) => OutlayerResult::CallFailed,
        };
        let evaluation = self.evaluations.get_mut(id).expect("unknown evaluation");
        require!(
            evaluation.status == EvaluationStatus::Pending,
            "evaluation already settled"
        );

        let (status, reasons, verdict) = judge_output(
            &output,
            &self.rules_sha256,
            &evaluation.config_sha256,
            &self.test_set_sha256,
        );
        evaluation.status = status;
        evaluation.reasons = reasons.clone();
        evaluation.verdict = verdict;
        evaluation.settled_at = Some(U64(env::block_timestamp()));
        self.pending = self.pending.saturating_sub(1);

        emit(
            "evaluation_settled",
            json!({ "id": id, "status": status, "reasons": reasons }),
        );
        // A verdict for a submission made before the deadline still counts
        // after it: OutLayer answers within the yield window either way.
        self.check_award();
        status
    }

    /// Continues the award check where a verdict's callback stopped, after
    /// more than 50 evaluations settled while an earlier one was pending.
    /// Anyone may call it; it can only award the earliest eligible pass.
    pub fn advance_award(&mut self) {
        self.check_award();
    }

    /// Sends an award into NEAR Intents, or retries a payment that failed. Anyone may call it;
    /// the money only ever goes to the winner. Attach 160 Tgas to send into Intents.
    pub fn claim_award(&mut self) {
        let award = self.award.as_ref().expect("no bounty has been awarded");
        require!(!award.paid, "the award has been paid");
        require!(!award.in_flight, "a payment is already in flight");
        if award.payout == Payout::Intents && award.wrapped.is_zero() {
            require!(
                env::prepaid_gas() >= MIN_INTENTS_CLAIM_GAS,
                "attach at least 160 Tgas to pay into NEAR Intents"
            );
        }
        self.pay_award();
    }

    /// Sends a service fee whose transfer failed again. Anyone may call it; the fee only ever goes
    /// to the account the challenge was deployed with.
    pub fn claim_service_fee(&mut self) {
        let award = self.award.as_ref().expect("no bounty has been awarded");
        require!(
            !award.service_fee.is_zero(),
            "this award has no service fee"
        );
        require!(!award.service_fee_sent, "the service fee has been sent");
        self.pay_service_fee();
    }

    #[private]
    pub fn on_service_fee_paid(&mut self) {
        let paid = env::promise_result_checked(0, 0).is_ok();
        let account = self.service_fee.as_ref().map(|fee| fee.account.clone());
        let award = self.award.as_mut().expect("no bounty has been awarded");
        award.service_fee_sent = paid;
        emit(
            if paid {
                "service_fee_paid"
            } else {
                "service_fee_payment_failed"
            },
            json!({ "id": award.evaluation, "account": account, "amount": award.service_fee }),
        );
    }

    /// The end of a deposit into NEAR Intents. `ft_transfer_call` returns the amount the verifier
    /// kept; the token returned the rest to this contract as wNEAR. If the batch failed as a whole,
    /// NEAR reverted all of it and nothing moved. Either way, what is left is paid as NEAR.
    #[private]
    pub fn on_intents_deposit(&mut self, deposit: U128) {
        let kept = env::promise_result_checked(0, 64).map(|bytes| {
            serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0.min(deposit.0))
                .unwrap_or(0)
        });
        let award = self.award.as_mut().expect("no bounty has been awarded");
        award.in_flight = false;
        match kept {
            Err(_) => {
                award.payout = Payout::Near;
                emit(
                    "award_payment_failed",
                    json!({ "id": award.evaluation, "winner": award.winner, "amount": award.amount, "to": "intents" }),
                );
            }
            Ok(kept) => {
                let kept = NearToken::from_yoctonear(kept);
                award.fee = award.fee.saturating_add(WNEAR_REGISTRATION);
                award.to_intents = award.to_intents.saturating_add(kept);
                award.wrapped = award
                    .wrapped
                    .saturating_add(NearToken::from_yoctonear(deposit.0).saturating_sub(kept));
                if award.wrapped.is_zero() {
                    award.paid = true;
                    emit(
                        "award_paid",
                        json!({ "id": award.evaluation, "winner": award.winner, "amount": kept, "to": "intents" }),
                    );
                } else {
                    award.payout = Payout::Near;
                    emit(
                        "award_payment_failed",
                        json!({ "id": award.evaluation, "winner": award.winner, "amount": award.wrapped, "to": "intents", "returned_as": "wNEAR" }),
                    );
                }
            }
        }
    }

    /// wNEAR a refused deposit returned has been unwrapped into NEAR; send it to the winner.
    #[private]
    pub fn on_award_unwrapped(&mut self, amount: U128) {
        let unwrapped = env::promise_result_checked(0, 0).is_ok();
        let award = self.award.as_mut().expect("no bounty has been awarded");
        if !unwrapped {
            award.in_flight = false;
            emit(
                "award_payment_failed",
                json!({ "id": award.evaluation, "winner": award.winner, "amount": award.wrapped, "to": "unwrap" }),
            );
            return;
        }
        award.wrapped = award
            .wrapped
            .saturating_sub(NearToken::from_yoctonear(amount.0));
        Promise::new(award.winner.clone())
            .transfer(NearToken::from_yoctonear(amount.0))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(TRANSFER_CALLBACK_GAS)
                    .on_award_paid(),
            )
            .detach();
    }

    #[private]
    pub fn on_award_paid(&mut self) {
        let paid = env::promise_result_checked(0, 0).is_ok();
        let award = self.award.as_mut().expect("no bounty has been awarded");
        award.in_flight = false;
        award.paid = paid;
        emit(
            if paid {
                "award_paid"
            } else {
                "award_payment_failed"
            },
            json!({ "id": award.evaluation, "winner": award.winner, "amount": award.amount }),
        );
    }

    /// Returns the bounty to the owner: at any time while the challenge is a
    /// draft, or once the deadline has passed with no winner and no
    /// evaluation still waiting for its verdict.
    pub fn withdraw_bounty(&mut self) {
        self.assert_owner();
        match self.status {
            ChallengeStatus::Draft => {}
            ChallengeStatus::Open => {
                require!(
                    self.deadline_passed(),
                    "the challenge is open until its deadline"
                );
                require!(
                    self.pending == 0,
                    "evaluations submitted before the deadline are still pending"
                );
                require!(
                    self.next_award_check == self.evaluations.len(),
                    "some settled evaluations are not yet checked for the award: call advance_award first"
                );
                self.status = ChallengeStatus::Closed;
                emit("challenge_closed", json!({}));
            }
            _ => env::panic_str("the challenge is closed"),
        }
        let amount = self.bounty;
        require!(!amount.is_zero(), "there is no bounty to withdraw");
        self.bounty = NearToken::from_yoctonear(0);
        emit("bounty_withdrawn", json!({ "amount": amount }));
        Promise::new(self.owner.clone())
            .transfer(amount)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(TRANSFER_CALLBACK_GAS)
                    .on_bounty_withdrawn(amount),
            )
            .detach();
    }

    /// Puts a withdrawal that did not arrive back into the bounty.
    #[private]
    pub fn on_bounty_withdrawn(&mut self, amount: NearToken) {
        if env::promise_result_checked(0, 0).is_err() {
            self.bounty = self.bounty.saturating_add(amount);
            emit("bounty_withdrawal_failed", json!({ "amount": amount }));
        }
    }

    /// Freezes the challenge's commitments and admits submissions from anyone
    /// until `closes_at`, in nanoseconds since the Unix epoch.
    pub fn open(&mut self, closes_at: U64) {
        self.assert_owner();
        require!(
            self.status == ChallengeStatus::Draft,
            "challenge is already open"
        );
        require!(
            closes_at.0 > env::block_timestamp(),
            "closes_at must be in the future"
        );
        self.status = ChallengeStatus::Open;
        self.closes_at = Some(closes_at);
        emit(
            "challenge_opened",
            json!({
                "rules_sha256": self.rules_sha256,
                "closes_at": closes_at,
                "bounty": self.bounty,
            }),
        );
    }

    /// Replaces the evaluator build while the challenge is a draft.
    pub fn set_evaluator(&mut self, evaluator: EvaluatorBuild) {
        self.assert_draft_owner();
        assert_sha256_hex(&evaluator.sha256, "evaluator.sha256");
        emit(
            "evaluator_changed",
            json!({ "url": evaluator.url, "sha256": evaluator.sha256 }),
        );
        self.evaluator = evaluator;
    }

    /// Replaces the test set commitment and its secrets location while the
    /// challenge is a draft.
    pub fn set_test_set(&mut self, test_set_sha256: String, secrets: SecretsLocation) {
        self.assert_draft_owner();
        assert_sha256_hex(&test_set_sha256, "test_set_sha256");
        emit(
            "test_set_changed",
            json!({ "test_set_sha256": test_set_sha256 }),
        );
        self.test_set_sha256 = test_set_sha256;
        self.secrets = secrets;
    }

    /// Replaces the rules while the challenge is a draft.
    pub fn set_rules(&mut self, rules_json: String) {
        self.assert_draft_owner();
        self.rules_sha256 = sha256_hex(rules_json.as_bytes());
        self.rules_json = rules_json;
        emit(
            "rules_changed",
            json!({ "rules_sha256": self.rules_sha256 }),
        );
    }

    pub fn get_challenge(&self) -> ChallengeView {
        ChallengeView {
            owner: self.owner.clone(),
            status: self.status,
            outlayer: self.outlayer.clone(),
            evaluator: self.evaluator.clone(),
            secrets: self.secrets.clone(),
            rules_json: self.rules_json.clone(),
            rules_sha256: self.rules_sha256.clone(),
            test_set_sha256: self.test_set_sha256.clone(),
            evaluations: self.evaluations.len(),
            pending: self.pending,
            bounty: self.bounty,
            closes_at: self.closes_at,
            award: self.award.clone(),
            next_award_check: self.next_award_check,
            intents: self.intents.clone(),
            service_fee: self.service_fee.clone(),
        }
    }

    pub fn get_evaluation(&self, id: u32) -> Option<EvaluationView> {
        self.evaluations.get(id).map(|evaluation| EvaluationView {
            id,
            evaluation: evaluation.clone(),
        })
    }

    pub fn get_evaluations(
        &self,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<EvaluationView> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.evaluations.len().min(from.saturating_add(limit)))
            .filter_map(|id| self.get_evaluation(id))
            .collect()
    }

    /// Walks settled evaluations in the order they were requested and awards
    /// the bounty to the first eligible pass. It stops at an eligible
    /// evaluation that is still pending, since that one may yet pass, and
    /// after `AWARD_CHECKS_PER_CALL` evaluations.
    fn check_award(&mut self) {
        let mut checked = 0;
        while self.status == ChallengeStatus::Open
            && self.next_award_check < self.evaluations.len()
            && checked < AWARD_CHECKS_PER_CALL
        {
            let id = self.next_award_check;
            let evaluation = &self.evaluations[id];
            if evaluation.eligible {
                match evaluation.status {
                    EvaluationStatus::Pending => return,
                    EvaluationStatus::Passed => {
                        let winner = evaluation.submitter.clone();
                        self.award_to(id, winner);
                        return;
                    }
                    EvaluationStatus::Failed | EvaluationStatus::Rejected => {}
                }
            }
            self.next_award_check += 1;
            checked += 1;
        }
    }

    fn award_to(&mut self, id: u32, winner: AccountId) {
        self.status = ChallengeStatus::Awarded;
        let payout = self.evaluations[id].payout;
        let service_fee = self
            .service_fee
            .as_ref()
            .map_or(NearToken::from_yoctonear(0), |fee| fee.of(self.bounty));
        let award = Award {
            evaluation: id,
            winner,
            amount: self.bounty,
            paid: false,
            in_flight: false,
            payout,
            to_intents: NearToken::from_yoctonear(0),
            fee: NearToken::from_yoctonear(0),
            wrapped: NearToken::from_yoctonear(0),
            service_fee,
            service_fee_sent: false,
        };
        emit(
            "bounty_awarded",
            json!({ "id": id, "winner": award.winner, "amount": award.amount, "payout": payout, "service_fee": service_fee }),
        );
        self.award = Some(award);
        self.bounty = NearToken::from_yoctonear(0);
        if !service_fee.is_zero() {
            self.pay_service_fee();
        }
        // A payment into NEAR Intents takes more gas than this verdict's callback holds, so it is
        // sent by `claim_award`, which anyone may call; a NEAR payment goes now.
        if payout == Payout::Near {
            self.pay_award();
        }
    }

    /// Pays what is still owed to the winner: unwraps wNEAR a refused Intents deposit returned,
    /// sends the reward into NEAR Intents if the winner chose that, or sends it as NEAR. A payment
    /// that fails leaves it owed, to be retried with `claim_award`.
    fn pay_award(&mut self) {
        let route = self.intents.clone();
        let me = env::current_account_id();
        let award = self.award.as_mut().expect("no bounty has been awarded");
        let owed = award
            .amount
            .saturating_sub(award.service_fee)
            .saturating_sub(award.to_intents)
            .saturating_sub(award.fee);
        if owed.is_zero() {
            award.paid = true;
            return;
        }
        award.in_flight = true;
        if !award.wrapped.is_zero() {
            let wrap = route
                .expect("wNEAR is only held on a challenge with an Intents route")
                .wrap;
            let amount = U128(award.wrapped.as_yoctonear());
            Promise::new(wrap)
                .function_call(
                    "near_withdraw",
                    json!({ "amount": amount }).to_string().into_bytes(),
                    ONE_YOCTO,
                    WRAP_GAS,
                )
                .then(
                    Self::ext(me)
                        .with_static_gas(UNWRAP_CALLBACK_GAS)
                        .on_award_unwrapped(amount),
                )
                .detach();
            return;
        }
        match route {
            Some(route) if award.payout == Payout::Intents && owed > WNEAR_REGISTRATION => {
                let deposit = owed.saturating_sub(WNEAR_REGISTRATION);
                let amount = U128(deposit.as_yoctonear());
                Promise::new(route.wrap)
                    .function_call("storage_deposit", json!({ "account_id": me, "registration_only": true }).to_string().into_bytes(), WNEAR_REGISTRATION, WRAP_GAS)
                    .function_call("near_deposit", b"{}".to_vec(), deposit, WRAP_GAS)
                    .function_call(
                        "ft_transfer_call",
                        json!({ "receiver_id": route.verifier, "amount": amount, "msg": award.winner }).to_string().into_bytes(),
                        ONE_YOCTO,
                        INTENTS_DEPOSIT_GAS,
                    )
                    .then(Self::ext(me).with_static_gas(INTENTS_CALLBACK_GAS).on_intents_deposit(amount))
                    .detach();
            }
            _ => {
                Promise::new(award.winner.clone())
                    .transfer(owed)
                    .then(
                        Self::ext(me)
                            .with_static_gas(TRANSFER_CALLBACK_GAS)
                            .on_award_paid(),
                    )
                    .detach();
            }
        }
    }

    /// Sends the award's service fee to its account. The flag is set before the transfer lands so
    /// a second call cannot send it twice; the callback clears it if the transfer failed.
    fn pay_service_fee(&mut self) {
        let account = self
            .service_fee
            .as_ref()
            .expect("a service fee is set")
            .account
            .clone();
        let award = self.award.as_mut().expect("no bounty has been awarded");
        award.service_fee_sent = true;
        Promise::new(account)
            .transfer(award.service_fee)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(TRANSFER_CALLBACK_GAS)
                    .on_service_fee_paid(),
            )
            .detach();
    }

    fn deadline_passed(&self) -> bool {
        self.closes_at
            .is_some_and(|closes_at| env::block_timestamp() >= closes_at.0)
    }

    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the challenge owner may do this"
        );
    }

    fn assert_draft_owner(&self) {
        self.assert_owner();
        require!(
            self.status == ChallengeStatus::Draft,
            "commitments are frozen once a challenge opens"
        );
    }
}

/// What came back from `request_execution`.
enum OutlayerResult {
    Returned(Vec<u8>),
    TooLarge,
    CallFailed,
}

/// Decides what an OutLayer result means for this challenge. OutLayer
/// returns the evaluator's JSON output, or `null` when the run failed.
fn judge_output(
    output: &OutlayerResult,
    rules_sha256: &str,
    config_sha256: &str,
    test_set_sha256: &str,
) -> (EvaluationStatus, Vec<String>, Option<String>) {
    let rejected = |reason: &str, verdict: Option<String>| {
        (
            EvaluationStatus::Rejected,
            vec![reason.to_string()],
            verdict,
        )
    };
    let bytes = match output {
        OutlayerResult::Returned(bytes) => bytes.as_slice(),
        OutlayerResult::TooLarge => return rejected("verdict_too_large", None),
        OutlayerResult::CallFailed => return rejected("outlayer_call_failed", None),
    };
    if bytes.is_empty() || bytes == b"null" {
        return rejected("execution_failed", None);
    }
    let raw = String::from_utf8_lossy(bytes).into_owned();
    let Ok(verdict) = serde_json::from_slice::<VerdictCommitments>(bytes) else {
        return rejected("verdict_malformed", Some(raw));
    };
    if verdict.rules_sha256 != rules_sha256 {
        return rejected("rules_mismatch", Some(raw));
    }
    if verdict.config_sha256 != config_sha256 {
        return rejected("config_mismatch", Some(raw));
    }
    if verdict.test_set_sha256 != test_set_sha256 {
        // Includes the case where the sealed test set was not injected.
        return rejected("test_set_mismatch", Some(raw));
    }
    if verdict.passed {
        (EvaluationStatus::Passed, Vec::new(), Some(raw))
    } else {
        (EvaluationStatus::Failed, verdict.reasons, Some(raw))
    }
}

fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": EVENT_STANDARD,
            "version": EVENT_VERSION,
            "event": event,
            "data": [data],
        })
    ));
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    env::sha256_array(bytes)
        .iter()
        .flat_map(|b| {
            [
                HEX[(b >> 4) as usize] as char,
                HEX[(b & 0xf) as usize] as char,
            ]
        })
        .collect()
}

fn assert_sha256_hex(value: &str, field: &str) {
    require!(
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        format!("{field} must be 64 lowercase hex characters")
    );
}

#[cfg(test)]
mod tests;
