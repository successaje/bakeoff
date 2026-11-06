#!/usr/bin/env python3
"""OpenAI-compatible mock chat completions API for local evaluator runs.

Classifies support tickets with keyword rules and simulates two model tiers:

* Models whose id contains "large", "397b", "sonnet" or "opus" answer
  correctly with high confidence, slowly.
* Every other model gets the priority wrong on a deterministic ~30% of
  tickets and reports low confidence on exactly those, quickly.

A system prompt that asks for the card number in the summary makes the
mock copy any card-like number from the ticket into its answer, so the
evaluator's leak gate can be exercised.

This is a simulation for development only. Its accuracy, latency and token
counts say nothing about real models.
"""

import argparse
import hashlib
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CATEGORY_KEYWORDS = [
    ("billing", ["charged", "charge", "refund", "invoice", "payment", "billed"]),
    ("returns", ["return", "exchange", "replacement", "send back"]),
    ("account", ["account", "password", "log in", "newsletter", "preference"]),
    ("shipping", ["deliver", "parcel", "tracking", "shipped", "ship ", "arrive", "courier"]),
    ("technical", ["app ", "website", "site", "error", "button", "basket", "checkout", "check out", "page"]),
]
URGENT_KEYWORDS = ["urgent", "immediately", "asap", "fraud", "today", "hacked"]
HIGH_KEYWORDS = [
    "twice", "can't", "cannot", "still", "again", "broken", "cracked", "chipped",
    "isn't here", "locked out", "error", "never arrives",
]
LOW_KEYWORDS = ["no rush", "whenever", "just wondering", "just asking", "just curious"]
PRIORITIES = ["low", "normal", "high", "urgent"]
STRONG_MARKERS = ("large", "397b", "sonnet", "opus")
CARD_PATTERN = re.compile(r"(?:\d[ -]?){12,18}\d")


def classify(text):
    lowered = text.lower()
    category = next(
        (name for name, words in CATEGORY_KEYWORDS if any(w in lowered for w in words)),
        "other",
    )
    if any(w in lowered for w in URGENT_KEYWORDS):
        priority = "urgent"
    elif any(w in lowered for w in HIGH_KEYWORDS):
        priority = "high"
    elif any(w in lowered for w in LOW_KEYWORDS):
        priority = "low"
    else:
        priority = "normal"
    return category, priority


def answer(model, system_prompt, ticket):
    category, priority = classify(ticket)
    strong = any(marker in model.lower() for marker in STRONG_MARKERS)
    confidence = 0.95
    if not strong:
        bucket = int(hashlib.sha256(f"{model}|{ticket}".encode()).hexdigest(), 16) % 100
        if bucket < 30:
            priority = PRIORITIES[(PRIORITIES.index(priority) + 1) % len(PRIORITIES)]
            confidence = 0.35
        else:
            confidence = 0.92
    summary = f"Customer needs help with {category}."
    if "card number" in system_prompt.lower():
        cards = CARD_PATTERN.findall(ticket)
        if cards:
            summary += f" Card on file: {cards[0]}."
    return json.dumps(
        {"category": category, "priority": priority, "confidence": confidence, "summary": summary}
    ), strong


class Handler(BaseHTTPRequestHandler):
    latency_ms = 250

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self.reply(404, {"error": {"message": "not found"}})
        if not self.headers.get("Authorization", "").startswith("Bearer ") or self.headers[
            "Authorization"
        ] == "Bearer ":
            return self.reply(401, {"error": {"message": "missing API key"}})
        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
            model = body["model"]
            messages = body["messages"]
        except (ValueError, KeyError):
            return self.reply(400, {"error": {"message": "malformed request"}})

        system_prompt = next((m["content"] for m in messages if m["role"] == "system"), "")
        ticket = messages[-1]["content"]
        content, strong = answer(model, system_prompt, ticket)
        time.sleep(self.latency_ms * (3 if strong else 1) / 1000)

        prompt_tokens = sum(len(m["content"]) for m in messages) // 4 + 8
        completion_tokens = len(content) // 4 + 1
        sys.stderr.write(f"mock: {model} -> {content[:60]}\n")
        self.reply(
            200,
            {
                "id": "mock-completion",
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": content}}
                ],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": prompt_tokens + completion_tokens,
                },
            },
        )

    def reply(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--latency-ms", type=int, default=250, help="base latency of the fast tier")
    args = parser.parse_args()
    Handler.latency_ms = args.latency_ms
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    sys.stderr.write(f"mock model API listening on http://127.0.0.1:{args.port}\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
