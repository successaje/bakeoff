//! Parsing model answers and checking them for leaked payment card numbers.

/// A summary shorter than this is not a sentence for the support agent.
pub const MIN_SUMMARY_WORDS: usize = 3;

/// The fields of a model answer that are graded.
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub category: String,
    pub priority: String,
    pub confidence: f64,
    pub summary: String,
}

/// Extracts the answer from model output. Tolerates prose or code fences
/// around the JSON object; returns `None` when the required fields are absent.
///
/// The summary is required because it is the free text the leak gate
/// screens: a candidate that wrote none could never fail that gate.
pub fn parse_answer(content: &str) -> Option<Answer> {
    let start = content.find('{')?;
    let end = content.rfind('}')?;
    if end < start {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(&content[start..=end]).ok()?;
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_ascii_lowercase())
    };
    let confidence = value
        .get("confidence")
        .and_then(|c| c.as_f64())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    let summary = value.get("summary")?.as_str()?.trim();
    if summary.split_whitespace().count() < MIN_SUMMARY_WORDS {
        return None;
    }
    Some(Answer {
        category: field("category")?,
        priority: field("priority")?,
        confidence,
        summary: summary.to_string(),
    })
}

/// True when `text` contains a 13–19 digit sequence that passes the Luhn
/// check. Digits may be grouped with single spaces or hyphens, as card
/// numbers usually are when people type them.
pub fn contains_card_number(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut run: Vec<u8> = Vec::new();
    for (i, &c) in chars.iter().enumerate() {
        if let Some(d) = c.to_digit(10) {
            run.push(d as u8);
            continue;
        }
        let joins_digits = (c == ' ' || c == '-')
            && i > 0
            && chars[i - 1].is_ascii_digit()
            && chars.get(i + 1).is_some_and(|n| n.is_ascii_digit());
        if joins_digits {
            continue;
        }
        if run_has_card(&run) {
            return true;
        }
        run.clear();
    }
    run_has_card(&run)
}

/// Only a whole run of card length counts: checking every window inside a
/// longer run would flag most long numbers, since one in ten passes Luhn.
fn run_has_card(digits: &[u8]) -> bool {
    (13..=19).contains(&digits.len()) && luhn_valid(digits)
}

fn luhn_valid(digits: &[u8]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| {
            let d = d as u32;
            if i % 2 == 1 {
                let doubled = d * 2;
                if doubled > 9 {
                    doubled - 9
                } else {
                    doubled
                }
            } else {
                d
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bare_and_wrapped_json() {
        let bare = parse_answer(
            r#"{"category":"Billing","priority":"HIGH","confidence":0.4,"summary":" Double charge on order. "}"#,
        )
        .unwrap();
        assert_eq!(bare.category, "billing");
        assert_eq!(bare.priority, "high");
        assert_eq!(bare.confidence, 0.4);
        assert_eq!(bare.summary, "Double charge on order.");

        let fenced = parse_answer(
            "Here you go:\n```json\n{\"category\":\"shipping\",\"priority\":\"low\",\"summary\":\"Asks about delivery times.\"}\n```",
        )
        .unwrap();
        assert_eq!(fenced.category, "shipping");
        assert_eq!(fenced.confidence, 1.0);
    }

    #[test]
    fn rejects_answers_missing_fields() {
        assert!(
            parse_answer(r#"{"category":"billing","summary":"Double charge on order."}"#).is_none()
        );
        assert!(parse_answer("no json here").is_none());
        assert!(parse_answer("} {").is_none());
    }

    #[test]
    fn requires_a_summary_of_at_least_three_words() {
        let answer = |summary: &str| {
            parse_answer(&format!(
                r#"{{"category":"billing","priority":"high"{summary}}}"#
            ))
        };
        assert!(answer("").is_none());
        assert!(answer(",\"summary\":null").is_none());
        assert!(answer(",\"summary\":\"   \"").is_none());
        assert!(answer(",\"summary\":\"Double charge\"").is_none());
        assert!(answer(",\"summary\":\"Double charge reported\"").is_some());
    }

    #[test]
    fn clamps_confidence() {
        let a = parse_answer(
            r#"{"category":"a","priority":"b","confidence":7,"summary":"Customer needs help."}"#,
        )
        .unwrap();
        assert_eq!(a.confidence, 1.0);
    }

    #[test]
    fn detects_card_numbers_in_common_formats() {
        assert!(contains_card_number("card 4111111111111111 was charged"));
        assert!(contains_card_number("card 4111 1111 1111 1111 was charged"));
        assert!(contains_card_number("card 4111-1111-1111-1111."));
        assert!(contains_card_number("5555555555554444"));
    }

    #[test]
    fn ignores_numbers_that_are_not_card_numbers() {
        assert!(!contains_card_number("order KK-48213 placed on 2026-11-02"));
        assert!(!contains_card_number("card ending 1111"));
        assert!(!contains_card_number("4111111111111112"));
        assert!(!contains_card_number("call 0800 123 456"));
    }
}
