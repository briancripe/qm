import { test } from "node:test";
import assert from "node:assert/strict";
import { onboardCommand, onboardingPlan, runOnboarding, type OnboardStep } from "../src/beadhive/onboard.ts";

const CTX = {
  bhHome: "/home/bees/.beadhive",
  workspacePath: "/home/bees/workspace",
  hives: [
    {
      provider: "github",
      org: "briancripe",
      repo: "nvidia-hackathon",
      prefix: "nvhack",
      cloneUrl: "git@github.com:briancripe/nvidia-hackathon.git",
    },
  ],
};

const execOf = (fn: (cmd: string) => { code: number; stdout?: string; stderr?: string }) => {
  const seen: string[] = [];
  return {
    seen,
    exec: async (cmd: string) => {
      seen.push(cmd);
      const r = fn(cmd);
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code };
    },
  };
};

test("HQ is stood up before any hive, because a bare computer has no bead store to start Dolt from", () => {
  const ids = onboardingPlan(CTX).map((s) => s.id);
  assert.deepEqual(ids, ["setup-check", "config-init", "hq-init", "hive:github/briancripe/nvidia-hackathon", "doctor"]);
  assert.ok(ids.indexOf("hq-init") < ids.indexOf("hive:github/briancripe/nvidia-hackathon"));
  assert.equal(ids[ids.length - 1], "doctor", "the observation records are what QM reads, so doctor runs last");
});

test("the onboard command carries the clone url and the real prefix", () => {
  assert.equal(
    onboardCommand(CTX, CTX.hives[0]!),
    "bh hive onboard 'github/briancripe/nvidia-hackathon' --clone-url 'git@github.com:briancripe/nvidia-hackathon.git' --prefix 'nvhack'",
  );
  assert.equal(
    onboardCommand(CTX, { provider: "github", org: "o", repo: "r" }),
    "bh hive onboard 'github/o/r'",
    "a local hive needs no clone url, and no prefix means let bh derive one",
  );
});

test("a satisfied probe skips the command entirely", async () => {
  const h = execOf(() => ({ code: 0 }));
  const plan: OnboardStep[] = [{ id: "hq", title: "HQ", probe: "test -d /hq", run: "bh hq init" }];
  const result = await runOnboarding(h.exec, plan);
  assert.deepEqual(result.steps[0]!.status, "satisfied");
  assert.deepEqual(h.seen, ["test -d /hq"], "never re-runs work that is already done");
});

test("a step that reports success but leaves the probe failing is a failure, not a pass", async () => {
  const h = execOf((cmd) => (cmd.startsWith("test") ? { code: 1 } : { code: 0 }));
  const plan: OnboardStep[] = [{ id: "hq", title: "HQ", probe: "test -d /hq", run: "bh hq init" }];
  const result = await runOnboarding(h.exec, plan);
  assert.equal(result.ok, false);
  assert.match(result.steps[0]!.error!, /reported success but/);
});

test("a failure stops the walk and marks the rest skipped rather than running them blind", async () => {
  const h = execOf((cmd) => (cmd === "b" ? { code: 1, stderr: "Error: boom" } : { code: 0 }));
  const plan: OnboardStep[] = [
    { id: "a", title: "A", run: "a" },
    { id: "b", title: "B", run: "b" },
    { id: "c", title: "C", run: "c" },
  ];
  const result = await runOnboarding(h.exec, plan);
  assert.deepEqual(
    result.steps.map((s) => s.status),
    ["ran", "failed", "skipped"],
  );
  assert.equal(result.steps[1]!.error, "Error: boom");
  assert.equal(h.seen.includes("c"), false, "never run a step whose prerequisite failed");
});

test("progress is reported per step so a multi-minute clone is not a silent wait", async () => {
  const h = execOf(() => ({ code: 0 }));
  const seen: string[] = [];
  await runOnboarding(h.exec, onboardingPlan(CTX), {
    onStep: (r, i, total) => seen.push(`${i + 1}/${total} ${r.id}`),
  });
  assert.equal(seen.length, 5);
  assert.equal(seen[0], "1/5 setup-check");
});

test("a thrown exec is a failed step, never an escaped exception", async () => {
  const exec = async () => {
    throw new Error("sandbox died");
  };
  const result = await runOnboarding(exec, [{ id: "a", title: "A", run: "a" }]);
  assert.equal(result.steps[0]!.status, "failed");
  assert.equal(result.steps[0]!.error, "sandbox died");
});
