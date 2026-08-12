import { test } from "node:test";
import assert from "node:assert/strict";
import { failureReason, onboardingHint, summarizeFailures } from "../src/beadhive/failure.ts";
import type { WorkSource } from "../src/beadhive/state.ts";

const failed = (key: string, error: string): WorkSource => ({
  key,
  name: key.split("/").pop()!,
  state: "failed",
  items: [],
  total: 0,
  error,
});
const ok = (key: string): WorkSource => ({ key, name: "x", state: "ok", items: [], total: 3 });

const CD = "/bin/sh: 1: cd: can't cd to /home/bees/workspace/github/beadhive/infra";
const CONFIG = '{"command": "work", "error_type": "ConfigError", "error": "hive not configured"}';
const DOLT = "Error: failed to open database: Dolt server unreachable at 127.0.0.1:3308";

test("each failure is named by cause, not by its raw shell noise", () => {
  assert.equal(failureReason(CD), "not checked out");
  assert.equal(failureReason(CONFIG), "not a working hive");
  assert.equal(failureReason(DOLT), "Dolt is not running");
  assert.equal(failureReason("something nobody predicted"), "unreachable");
});

test("failures collapse by cause with a count, instead of one section each", () => {
  const summaries = summarizeFailures([failed("a/b/c", CD), failed("a/b/d", CD), failed("a/b/e", CONFIG), ok("a/b/f")]);
  assert.deepEqual(
    summaries.map((s) => `${s.reason}:${s.count}`),
    ["not checked out:2", "not a working hive:1"],
    "most common cause first, and a healthy source is never counted as a failure",
  );
  assert.deepEqual(summaries[0]!.sources, ["a/b/c", "a/b/d"], "the keys survive for the tooltip");
});

test("the onboarding hint fires only when the whole computer is unusable", () => {
  const all = [failed("a/b/c", CD), failed("a/b/d", CD)];
  assert.match(onboardingHint(summarizeFailures(all), 2), /never onboarded/);
  assert.equal(onboardingHint(summarizeFailures([...all, ok("a/b/e")]), 3), "", "one working hive means it is set up");
  assert.equal(onboardingHint([], 0), "", "no failures, no hint");
});

test("a dead bead store is called out rather than blamed on onboarding", () => {
  const summaries = summarizeFailures([failed("a/b/c", DOLT)]);
  assert.match(onboardingHint(summaries, 1), /bead store is not running/);
});
