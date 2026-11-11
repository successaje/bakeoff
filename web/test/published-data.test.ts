import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the board publishes the same practice tickets and labeling guide as the repository", () => {
  assert.equal(read("../public/data/practice.json"), read("../../data/tickets/practice.json"));
  assert.equal(read("../public/data/labeling-guide.md"), read("../../docs/labeling-guide.md"));
});

test("every listed challenge points at files the board publishes", () => {
  const registry = JSON.parse(read("../public/challenges.json")) as Record<string, { id: string; practice_set?: string; labeling_guide?: string }[]>;
  for (const challenge of Object.values(registry).flat()) {
    for (const path of [challenge.practice_set, challenge.labeling_guide].filter(Boolean)) {
      assert.doesNotThrow(() => read(`../public/${path}`), `${challenge.id}: ${path}`);
    }
  }
});
