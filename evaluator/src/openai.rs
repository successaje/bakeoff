//! Request and response bodies for OpenAI-compatible chat completions.

use crate::evaluate::{ChatCompletion, ChatRequest};
use serde::Deserialize;
use serde_json::{json, Map, Value};

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

/// Serializes a request. Request options are written first so the fields the
/// evaluator controls always win, although policy already rejects options
/// that name them.
pub fn request_body(request: &ChatRequest) -> Vec<u8> {
    let mut body: Map<String, Value> = request
        .options
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    body.insert("model".into(), json!(request.model));
    body.insert("messages".into(), json!(request.messages));
    body.insert("max_tokens".into(), json!(request.max_tokens));
    match request.temperature {
        Some(t) => {
            body.insert("temperature".into(), json!(t));
        }
        None => {
            body.remove("temperature");
        }
    }
    serde_json::to_vec(&Value::Object(body)).expect("request body always serializes")
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

    use crate::evaluate::ChatMessage;
    use std::collections::BTreeMap;

    fn request(temperature: Option<f64>, options: &[(&str, Value)]) -> ChatRequest {
        ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user("hi")],
            max_tokens: 10,
            temperature,
            options: options
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect::<BTreeMap<_, _>>(),
        }
    }

    fn body(request: &ChatRequest) -> Value {
        serde_json::from_slice(&request_body(request)).unwrap()
    }

    #[test]
    fn omits_temperature_when_unset() {
        assert!(body(&request(None, &[])).get("temperature").is_none());
        assert_eq!(body(&request(Some(0.0), &[]))["temperature"], json!(0.0));
    }

    #[test]
    fn merges_options_without_overriding_evaluator_fields() {
        let b = body(&request(
            None,
            &[
                ("reasoning_effort", json!("low")),
                ("model", json!("other")),
                ("temperature", json!(2)),
            ],
        ));
        assert_eq!(b["reasoning_effort"], json!("low"));
        assert_eq!(b["model"], json!("m"));
        assert_eq!(b["max_tokens"], json!(10));
        assert!(b.get("temperature").is_none());
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
