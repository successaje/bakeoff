//! Stand-in for intents.near's token deposits, for sandbox tests.
//!
//! NEAR Intents takes a NEP-141 token through `ft_transfer_call` and credits
//! it to the account named in `msg`, under the token id `nep141:<token>`,
//! where `mt_balance_of` reports it. This mock does the same. `set_refuse`
//! makes deposits fail, as a paused verifier or a bad `msg` would, so tests
//! can watch the token return them.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockIntents {
    /// Keyed by `<token id>/<account>`.
    balances: LookupMap<String, u128>,
    refuse: bool,
}

#[near]
impl MockIntents {
    #[init]
    pub fn new() -> Self {
        Self {
            balances: LookupMap::new(b"b"),
            refuse: false,
        }
    }

    /// Makes deposits fail (true) or succeed (false). Only this account may call it.
    #[private]
    pub fn set_refuse(&mut self, refuse: bool) {
        self.refuse = refuse;
    }

    /// Credits the deposit to the account `msg` names and keeps all of it.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let _ = sender_id;
        require!(!self.refuse, "deposits are refused");
        let owner: AccountId = msg
            .parse()
            .unwrap_or_else(|_| env::panic_str("msg must name the account to credit"));
        let key = Self::key(&format!("nep141:{}", env::predecessor_account_id()), &owner);
        let balance = self.balances.get(&key).copied().unwrap_or(0);
        self.balances.insert(key, balance + amount.0);
        PromiseOrValue::Value(U128(0))
    }

    /// The account's balance of `token_id`, such as `nep141:wrap.near`.
    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        U128(
            self.balances
                .get(&Self::key(&token_id, &account_id))
                .copied()
                .unwrap_or(0),
        )
    }

    fn key(token_id: &str, account: &AccountId) -> String {
        format!("{token_id}/{account}")
    }
}
