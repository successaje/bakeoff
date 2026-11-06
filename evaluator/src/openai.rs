//! Request and response bodies for OpenAI-compatible chat completions.

use crate::evaluate::{ChatCompletion, ChatMessage};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct RequestBody<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
}

#[derive(Deserialize)]
struct ResponseBody {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Choice {
    message: ResponseMessage,
}

#[derive(Deserialize)]
struct ResponseMessage {
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
}

pub fn request_body(
    model: &str,
    messages: &[ChatMessage],
    max_tokens: u32,
    temperature: Option<f64>,
) -> Vec<u8> {
    serde_json::to_vec(&RequestBody {
        model,
        messages,
        max_tokens,
        temperature,
    })
    .expect("request body always serializes")
}

/// Parses a completion. A response without token usage is an error: cost is
/// a pass gate, so a call that cannot be priced cannot be scored.
pub fn parse_response(body: &[u8]) -> Result<ChatCompletion, String> {
    let parsed: ResponseBody =
        serde_json::from_slice(body).map_err(|e| format!("malformed completion: {e}"))?;
    let usage = parsed.usage.ok_or("completion has no usage")?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .ok_or("completion has no choices")?
        .message
        .content
        .unwrap_or_default();
    Ok(ChatCompletion {
        content,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn omits_temperature_when_unset() {
        let messages = [ChatMessage::user("hi")];
        let body = String::from_utf8(request_body("m", &messages, 10, None)).unwrap();
        assert!(!body.contains("temperature"));
        let body = String::from_utf8(request_body("m", &messages, 10, Some(0.0))).unwrap();
        assert!(body.contains("\"temperature\":0.0"));
    }

    #[test]
    fn parses_content_and_usage() {
        let c = parse_response(
            br#"{"choices":[{"message":{"role":"assistant","content":"{}"}}],"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}"#,
        )
        .unwrap();
        assert_eq!(c.content, "{}");
        assert_eq!((c.prompt_tokens, c.completion_tokens), (12, 3));
    }

    #[test]
    fn requires_usage() {
        assert!(parse_response(br#"{"choices":[{"message":{"content":"{}"}}]}"#).is_err());
    }
}
