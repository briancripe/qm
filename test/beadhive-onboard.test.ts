import { test } from "node:test";
import assert from "node:assert/strict";
import {
  onboardCommand,
  onboardingPlan,
  runOnboarding,
  workspaceToml,
  type OnboardStep,
} from "../src/beadhive/onboard.ts";

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
  assert.deepEqual(ids, [
    "setup-check",
    "config-init",
    "hq-init",
    "workspace-toml",
    "hive:github/briancripe/nvidia-hackathon",
    "doctor",
  ]);
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
  assert.equal(result.ok, false, "exit 0 means nothing if the thing it was meant to create is absent");
});

// `bh hq init` creates HQ and then exits non-zero when it cannot push to a remote that
// already has content. The local work succeeded; only the publish step refused. The probe
// is what says whether the step is satisfied, so the exit code must not overrule it.
test("a non-zero command whose probe now passes is a success, not a failure", async () => {
  let created = false;
  const h = execOf((cmd) => {
    if (cmd.startsWith("test")) return { code: created ? 0 : 1 };
    created = true;
    return { code: 1, stderr: "✗ HQ remote already has content — refusing to push over it" };
  });
  const plan: OnboardStep[] = [{ id: "hq", title: "HQ", probe: "test -d /hq", run: "bh hq init" }];
  const result = await runOnboarding(h.exec, plan);
  assert.equal(result.steps[0]!.status, "ran");
  assert.equal(result.ok, true);
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
  assert.equal(seen.length, 6);
  assert.equal(seen[0], "1/6 setup-check");
});

test("a thrown exec is a failed step, never an escaped exception", async () => {
  const exec = async () => {
    throw new Error("sandbox died");
  };
  const result = await runOnboarding(exec, [{ id: "a", title: "A", run: "a" }]);
  assert.equal(result.steps[0]!.status, "failed");
  assert.equal(result.steps[0]!.error, "sandbox died");
});

test("git-workspace is configured before doctor, because doctor's record loop reads it", () => {
  const ids = onboardingPlan(CTX).map((s) => s.id);
  assert.ok(
    ids.indexOf("workspace-toml") < ids.indexOf("doctor"),
    "no repo groups means doctor iterates nothing and hq/hives is never written",
  );
});

test("one provider block per group, listing that group's repos", () => {
  const toml = workspaceToml([
    { provider: "github", org: "beadhive", repo: "beadhive" },
    { provider: "github", org: "beadhive", repo: "infra" },
    { provider: "contrib", org: "briancripe", repo: "orca" },
  ]);
  assert.equal((toml.match(/\[\[provider\]\]/g) ?? []).length, 2, "two groups, two blocks");
  assert.match(toml, /include = \["beadhive", "infra"\]/);
  assert.match(toml, /name = "briancripe"/);
});
