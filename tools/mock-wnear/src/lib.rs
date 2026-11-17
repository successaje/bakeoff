//! Stand-in for wrap.near, the wNEAR token, for sandbox tests.
//!
//! Keeps the parts of wrap.near a challenge uses to pay a winner into NEAR
//! Intents, with the same names, arguments and deposits: `storage_deposit`
//! to register (0.00125 NEAR, refunded to an account already registered),
//! `near_deposit` to wrap, `near_withdraw` to unwrap, and NEP-141's
//! `ft_transfer_call`, which calls the receiver's `ft_on_transfer` and returns
//! to the sender whatever the receiver did not keep, or all of it if the
//! receiver failed.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, require, AccountId, Gas, NearToken, PanicOnDefault,
    Promise, PromiseOrValue,
};

const REGISTRATION: NearToken = NearToken::from_micronear(1_250);
const RESOLVE_GAS: Gas = Gas::from_tgas(5);
/// What `ft_transfer_call` keeps for itself and the resolve; the rest goes to the receiver.
const TRANSFER_CALL_GAS: Gas = Gas::from_tgas(30);

#[ext_contract(ext_receiver)]
pub trait FungibleTokenReceiver {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128>;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockWnear {
    balances: LookupMap<AccountId, u128>,
}

#[near]
impl MockWnear {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
        }
    }

    /// Registers `account_id` (the caller by default). Refunds the deposit to an
    /// account already registered, and anything above the registration otherwise.
    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> Value {
        let _ = registration_only;
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let deposit = env::attached_deposit();
        let refund = if self.balances.contains_key(&account) {
            deposit
        } else {
            require!(deposit >= REGISTRATION, "attach 0.00125 NEAR to register");
            self.balances.insert(account, 0);
            deposit.saturating_sub(REGISTRATION)
        };
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }
        json!({ "total": U128(REGISTRATION.as_yoctonear()), "available": U128(0) })
    }

    /// Wraps the attached NEAR into the caller's wNEAR balance.
    #[payable]
    pub fn near_deposit(&mut self) {
        let account = env::predecessor_account_id();
        let balance = self.balance(&account);
        self.balances
            .insert(account, balance + env::attached_deposit().as_yoctonear());
    }

    /// Unwraps `amount` of the caller's wNEAR and sends it to them as NEAR.
    #[payable]
    pub fn near_withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        self.take(&account, amount.0);
        Promise::new(account).transfer(NearToken::from_yoctonear(amount.0))
    }

    #[payable]
    pub fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = memo;
        assert_one_yocto();
        require!(
            env::prepaid_gas() > TRANSFER_CALL_GAS,
            "more gas is required"
        );
        let sender = env::predecessor_account_id();
        require!(
            sender != receiver_id,
            "sender and receiver should be different"
        );
        require!(
            self.balances.contains_key(&receiver_id),
            format!("The account {receiver_id} is not registered")
        );
        self.take(&sender, amount.0);
        let balance = self.balance(&receiver_id);
        self.balances
            .insert(receiver_id.clone(), balance + amount.0);

        let receiver_gas = env::prepaid_gas()
            .saturating_sub(env::used_gas())
            .saturating_sub(TRANSFER_CALL_GAS);
        ext_receiver::ext(receiver_id.clone())
            .with_static_gas(receiver_gas)
            .ft_on_transfer(sender.clone(), amount, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(RESOLVE_GAS)
                    .ft_resolve_transfer(sender, receiver_id, amount),
            )
            .into()
    }

    /// Returns to the sender what the receiver did not keep, and the amount it kept.
    #[private]
    pub fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let unused = match env::promise_result_checked(0, 64) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes)
                .map(|u| u.0.min(amount.0))
                .unwrap_or(amount.0),
            Err(_) => amount.0,
        };
        let refund = unused.min(self.balance(&receiver_id));
        if refund > 0 {
            self.take(&receiver_id, refund);
            let balance = self.balance(&sender_id);
            self.balances.insert(sender_id, balance + refund);
        }
        U128(amount.0 - refund)
    }

    pub fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.balance(&account_id))
    }

    fn balance(&self, account: &AccountId) -> u128 {
        self.balances
            .get(account)
            .copied()
            .unwrap_or_else(|| env::panic_str(&format!("The account {account} is not registered")))
    }

    fn take(&mut self, account: &AccountId, amount: u128) {
        let balance = self.balance(account);
        require!(balance >= amount, "The account doesn't have enough balance");
        self.balances.insert(account.clone(), balance - amount);
    }
}
