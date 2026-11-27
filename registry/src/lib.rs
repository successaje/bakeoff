//! Bakeoff listing registry.
//!
//! A challenge contract holds its rules, commitments, results and reward, but not what the board
//! shows about it: a title, the team setting the goal, the task in their words, its baseline. Until
//! now those lived in the board's `challenges.json`, so listing a challenge took a pull request.
//! This registry lets a challenge's owner list it themselves.
//!
//! Only the account a challenge was created under can list it. Challenge accounts are
//! sub-accounts of their owner (`<name>.<owner>`), and only an account can create its own
//! sub-accounts, so a caller that is the challenge's parent account controls it. The registry
//! needs no call to the challenge to check this.
//!
//! A listing pays for the storage it takes: the caller attaches a deposit, and whatever the listing
//! does not use is refunded. Shrinking a listing or removing it refunds the storage it frees.
//! Every change is logged as a NEP-297 event, so an indexer can follow the registry.

use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};

const MAX_TITLE: usize = 120;
const MAX_SPONSOR: usize = 80;
const MAX_SUMMARY: usize = 600;
const MAX_PROBLEM: usize = 2_000;
const MAX_TAGS: usize = 8;
const MAX_TAG: usize = 40;
const MAX_URL: usize = 300;
const MAX_TICKETS: u32 = 100_000;
const MAX_PAGE: u32 = 100;

/// The baseline the owner published for their current agent, in the units the contract uses.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Baseline {
    pub accuracy_bp: u32,
    pub cost_per_ticket_uusd: u64,
    pub p95_latency_ms: u64,
}

/// What the board shows about a challenge that the chain does not hold, as in `challenges.json`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    pub title: String,
    pub sponsor: String,
    pub summary: String,
    pub problem: Option<String>,
    pub tags: Vec<String>,
    /// How many hidden test cases the challenge scores on.
    pub tickets: u32,
    pub baseline: Baseline,
    /// SHA-256 of the baseline agent's config, from calibrate.py's report.
    pub baseline_config_sha256: Option<String>,
    /// https URL of the public practice tickets.
    pub practice_set: Option<String>,
    /// https URL of the labeling guide both ticket sets follow.
    pub labeling_guide: Option<String>,
}

#[near(serializers = [borsh])]
pub struct Stored {
    listing: Listing,
    updated_at_ms: u64,
}

/// A listing as the registry serves it.
#[near(serializers = [json])]
pub struct ListingView {
    pub challenge: AccountId,
    pub owner: AccountId,
    pub listing: Listing,
    pub updated_at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    listings: IterableMap<AccountId, Stored>,
}

/// The account `challenge` was created under, if it is a sub-account.
fn parent_of(challenge: &AccountId) -> Option<&str> {
    challenge.as_str().split_once('.').map(|(_, parent)| parent)
}

fn check_text(field: &str, value: &str, max: usize) {
    require!(
        !value.trim().is_empty(),
        format!("{field} must not be empty")
    );
    require!(
        value.chars().count() <= max,
        format!("{field} must be at most {max} characters")
    );
}

fn check_url(field: &str, value: &Option<String>) {
    if let Some(url) = value {
        require!(
            url.starts_with("https://"),
            format!("{field} must be an https URL")
        );
        require!(
            url.len() <= MAX_URL,
            format!("{field} must be at most {MAX_URL} characters")
        );
    }
}

fn check(listing: &Listing) {
    check_text("title", &listing.title, MAX_TITLE);
    check_text("sponsor", &listing.sponsor, MAX_SPONSOR);
    check_text("summary", &listing.summary, MAX_SUMMARY);
    if let Some(problem) = &listing.problem {
        check_text("problem", problem, MAX_PROBLEM);
    }
    require!(
        listing.tags.len() <= MAX_TAGS,
        format!("at most {MAX_TAGS} tags")
    );
    for tag in &listing.tags {
        check_text("a tag", tag, MAX_TAG);
    }
    require!(
        listing.tickets > 0 && listing.tickets <= MAX_TICKETS,
        format!("tickets must be between 1 and {MAX_TICKETS}")
    );
    require!(
        listing.baseline.accuracy_bp <= 10_000,
        "baseline accuracy_bp must be at most 10000"
    );
    if let Some(hash) = &listing.baseline_config_sha256 {
        require!(
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "baseline_config_sha256 must be 64 lowercase hex characters"
        );
    }
    check_url("practice_set", &listing.practice_set);
    check_url("labeling_guide", &listing.labeling_guide);
}

fn log_event(event: &str, challenge: &AccountId, owner: &AccountId) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "bakeoff_registry", "version": "1.0.0", "event": event, "data": [{ "challenge": challenge, "owner": owner }] })
    ));
}

#[near]
impl Registry {
    #[init]
    pub fn new() -> Self {
        Self {
            listings: IterableMap::new(b"l"),
        }
    }

    /// Lists `challenge` on the board, or updates its listing. Only the account it was created
    /// under may. Attach enough for the listing's storage; the rest is refunded.
    #[payable]
    pub fn list(&mut self, challenge: AccountId, listing: Listing) {
        let owner = env::predecessor_account_id();
        require!(
            parent_of(&challenge) == Some(owner.as_str()),
            format!("only the account {challenge} was created under can list it")
        );
        check(&listing);
        let before = env::storage_usage();
        self.listings.insert(
            challenge.clone(),
            Stored {
                listing,
                updated_at_ms: env::block_timestamp_ms(),
            },
        );
        self.listings.flush();
        self.settle_storage(before, &owner);
        log_event("listed", &challenge, &owner);
    }

    /// Removes the listing of `challenge` and refunds the storage it held. The challenge itself is
    /// untouched.
    pub fn unlist(&mut self, challenge: AccountId) {
        let owner = env::predecessor_account_id();
        require!(
            parent_of(&challenge) == Some(owner.as_str()),
            format!("only the account {challenge} was created under can unlist it")
        );
        require!(
            self.listings.contains_key(&challenge),
            format!("{challenge} is not listed")
        );
        let before = env::storage_usage();
        self.listings.remove(&challenge);
        self.listings.flush();
        self.settle_storage(before, &owner);
        log_event("unlisted", &challenge, &owner);
    }

    pub fn get_listing(&self, challenge: AccountId) -> Option<ListingView> {
        self.listings
            .get(&challenge)
            .map(|stored| view(&challenge, stored))
    }

    /// Listings in the order they were first made, a page at a time (at most 100).
    pub fn get_listings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ListingView> {
        let limit = limit.unwrap_or(MAX_PAGE).min(MAX_PAGE) as usize;
        self.listings
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit)
            .map(|(challenge, stored)| view(challenge, stored))
            .collect()
    }

    pub fn listing_count(&self) -> u32 {
        self.listings.len()
    }

    /// Charges what a change added to storage against the attached deposit, or refunds what it
    /// freed, and returns the rest of the deposit to `owner`.
    fn settle_storage(&self, before: u64, owner: &AccountId) {
        let after = env::storage_usage();
        let attached = env::attached_deposit();
        let byte = env::storage_byte_cost();
        let refund = if after >= before {
            let cost = byte.saturating_mul((after - before) as u128);
            require!(
                attached >= cost,
                format!(
                    "attach at least {cost} for this listing's storage ({} bytes)",
                    after - before
                )
            );
            attached.saturating_sub(cost)
        } else {
            attached.saturating_add(byte.saturating_mul((before - after) as u128))
        };
        if refund > NearToken::from_yoctonear(0) {
            // Scheduled when dropped; the refund does not need a callback.
            Promise::new(owner.clone()).transfer(refund).detach();
        }
    }
}

fn view(challenge: &AccountId, stored: &Stored) -> ListingView {
    let owner: AccountId = parent_of(challenge)
        .and_then(|p| p.parse().ok())
        .expect("listed challenges are sub-accounts");
    ListingView {
        challenge: challenge.clone(),
        owner,
        listing: stored.listing.clone(),
        updated_at_ms: stored.updated_at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn listing() -> Listing {
        Listing {
            title: "Support ticket triage".into(),
            sponsor: "Kettle & Kiln".into(),
            summary: "Route each message to the right team and urgency.".into(),
            problem: None,
            tags: vec!["Classification".into(), "Customer support".into()],
            tickets: 100,
            baseline: Baseline {
                accuracy_bp: 8_700,
                cost_per_ticket_uusd: 128,
                p95_latency_ms: 18_159,
            },
            baseline_config_sha256: Some(
                "8bb2ccb0aa24288c6be335432488ea7dddd16b52a31c03e084ee8d9c0f86bf58".into(),
            ),
            practice_set: Some("https://bakeoff-near.vercel.app/data/practice.json".into()),
            labeling_guide: None,
        }
    }

    fn as_account(account: &str, deposit: NearToken) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(account.parse().unwrap())
            .attached_deposit(deposit)
            .build());
    }

    const DEPOSIT: NearToken = NearToken::from_millinear(50);

    #[test]
    fn the_account_a_challenge_was_created_under_lists_it() {
        as_account("kettle.near", DEPOSIT);
        let mut registry = Registry::new();
        registry.list("triage.kettle.near".parse().unwrap(), listing());
        let view = registry
            .get_listing("triage.kettle.near".parse().unwrap())
            .unwrap();
        assert_eq!(view.owner.as_str(), "kettle.near");
        assert_eq!(view.listing, listing());
        assert_eq!(registry.listing_count(), 1);
        assert!(get_logs()
            .iter()
            .any(|l| l.contains(r#""event":"listed""#) && l.contains("triage.kettle.near")));
    }

    #[test]
    #[should_panic(expected = "only the account triage.kettle.near was created under can list it")]
    fn nobody_else_can_list_it() {
        as_account("mallory.near", DEPOSIT);
        Registry::new().list("triage.kettle.near".parse().unwrap(), listing());
    }

    #[test]
    #[should_panic(expected = "only the account")]
    fn a_grandparent_cannot_list_it_either() {
        as_account("near", DEPOSIT);
        Registry::new().list("triage.kettle.near".parse().unwrap(), listing());
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn a_listing_pays_for_its_storage() {
        as_account("kettle.near", NearToken::from_yoctonear(1));
        Registry::new().list("triage.kettle.near".parse().unwrap(), listing());
    }

    #[test]
    fn the_owner_updates_and_unlists() {
        as_account("kettle.near", DEPOSIT);
        let mut registry = Registry::new();
        registry.list("triage.kettle.near".parse().unwrap(), listing());
        let updated = Listing {
            title: "Support triage under 40 µ$".into(),
            ..listing()
        };
        registry.list("triage.kettle.near".parse().unwrap(), updated.clone());
        assert_eq!(
            registry
                .get_listing("triage.kettle.near".parse().unwrap())
                .unwrap()
                .listing,
            updated
        );
        assert_eq!(registry.listing_count(), 1);
        registry.unlist("triage.kettle.near".parse().unwrap());
        assert!(registry
            .get_listing("triage.kettle.near".parse().unwrap())
            .is_none());
        assert_eq!(registry.listing_count(), 0);
    }

    #[test]
    fn listings_page_in_the_order_they_were_made() {
        let mut registry = {
            as_account("a.near", DEPOSIT);
            Registry::new()
        };
        for owner in ["a.near", "b.near", "c.near"] {
            as_account(owner, DEPOSIT);
            registry.list(format!("challenge.{owner}").parse().unwrap(), listing());
        }
        let page: Vec<String> = registry
            .get_listings(Some(1), Some(5))
            .into_iter()
            .map(|v| v.challenge.to_string())
            .collect();
        assert_eq!(page, ["challenge.b.near", "challenge.c.near"]);
    }

    #[test]
    fn listings_are_checked_before_they_are_stored() {
        let cases: Vec<(Listing, &str)> = vec![
            (
                Listing {
                    title: " ".into(),
                    ..listing()
                },
                "title must not be empty",
            ),
            (
                Listing {
                    summary: "x".repeat(601),
                    ..listing()
                },
                "summary must be at most 600",
            ),
            (
                Listing {
                    tags: vec!["t".into(); 9],
                    ..listing()
                },
                "at most 8 tags",
            ),
            (
                Listing {
                    tickets: 0,
                    ..listing()
                },
                "tickets must be between",
            ),
            (
                Listing {
                    baseline: Baseline {
                        accuracy_bp: 10_001,
                        ..listing().baseline
                    },
                    ..listing()
                },
                "accuracy_bp must be at most 10000",
            ),
            (
                Listing {
                    baseline_config_sha256: Some("ABC".into()),
                    ..listing()
                },
                "64 lowercase hex",
            ),
            (
                Listing {
                    practice_set: Some("http://insecure.example/p.json".into()),
                    ..listing()
                },
                "practice_set must be an https URL",
            ),
        ];
        for (bad, expected) in cases {
            as_account("kettle.near", DEPOSIT);
            let result = std::panic::catch_unwind(move || {
                Registry::new().list("triage.kettle.near".parse().unwrap(), bad)
            });
            let message = result
                .expect_err(expected)
                .downcast::<String>()
                .map(|s| *s)
                .unwrap_or_default();
            assert!(
                message.contains(expected),
                "expected {expected:?}, got {message:?}"
            );
        }
    }
}
