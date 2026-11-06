//! Stand-in for OutLayer's `request_execution`, for sandbox tests.
//!
//! Mirrors how OutLayer hands a result back to the calling contract: the
//! request creates a yielded promise and returns it, a worker later resumes
//! it with the output, and the yield callback returns that output as the
//! call's value (`null` when the run failed or timed out). Here the test
//! harness plays the worker by calling `resolve`.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_sdk::store::Vector;
use near_sdk::{env, near, AccountId, Gas, GasWeight, PanicOnDefault};

const DATA_ID_REGISTER: u64 = 0;
const YIELD_CALLBACK_GAS: Gas = Gas::from_tgas(10);
/// `promise_yield_resume` accepts at most 1024 bytes.
const MAX_RESUME_BYTES: usize = 1024;

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    pub predecessor: AccountId,
    pub signer: AccountId,
    pub deposit: U128,
    /// The call's arguments, re-serialized as JSON.
    pub args_json: String,
    pub resolved: bool,
    #[serde(skip)]
    data_id: Vec<u8>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockOutlayer {
    requests: Vector<Request>,
}

#[near]
impl MockOutlayer {
    #[init]
    pub fn new() -> Self {
        Self {
            requests: Vector::new(b"r"),
        }
    }

    /// Same parameters as OutLayer's method. Records the request and returns
    /// a yielded promise that `resolve` completes.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<Value>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        assert!(
            resource_limits.is_some(),
            "without resource_limits OutLayer only compiles"
        );
        let request_id = self.requests.len();
        let promise = env::promise_yield_create(
            "on_resolved",
            json!({ "request_id": request_id }).to_string(),
            YIELD_CALLBACK_GAS,
            GasWeight(1),
            DATA_ID_REGISTER,
        );
        let data_id = env::read_register(DATA_ID_REGISTER).expect("yield created a data id");
        self.requests.push(Request {
            predecessor: env::predecessor_account_id(),
            signer: env::signer_account_id(),
            deposit: U128(env::attached_deposit().as_yoctonear()),
            args_json: json!({
                "source": source,
                "resource_limits": resource_limits,
                "input_data": input_data,
                "secrets_ref": secrets_ref,
                "response_format": response_format,
                "payer_account_id": payer_account_id,
                "params": params,
            })
            .to_string(),
            resolved: false,
            data_id,
        });
        env::promise_return(promise);
    }

    /// Completes request `request_id` with `output`, the evaluator's stdout,
    /// or with a failed run when `output` is `None`.
    pub fn resolve(&mut self, request_id: u32, output: Option<String>) {
        let request = self.requests.get_mut(request_id).expect("unknown request");
        assert!(!request.resolved, "request already resolved");
        let payload = output.unwrap_or_else(|| "null".to_string());
        assert!(
            payload.len() <= MAX_RESUME_BYTES,
            "output exceeds 1024 bytes"
        );
        let data_id: [u8; 32] = request.data_id.clone().try_into().expect("32-byte data id");
        assert!(
            env::promise_yield_resume(&data_id, payload),
            "yield already timed out"
        );
        request.resolved = true;
    }

    /// Yield callback: returns the resumed output, or `null` on timeout.
    #[private]
    pub fn on_resolved(&mut self, request_id: u32) {
        let _ = request_id;
        let output = env::promise_result_checked(0, MAX_RESUME_BYTES)
            .ok()
            .filter(|bytes| !bytes.is_empty())
            .unwrap_or_else(|| b"null".to_vec());
        // Passed through byte for byte, as OutLayer does for Json responses.
        env::value_return(&output);
    }

    pub fn get_request(&self, request_id: u32) -> Option<Request> {
        self.requests.get(request_id).cloned()
    }

    pub fn request_count(&self) -> u32 {
        self.requests.len()
    }
}
