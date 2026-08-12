// bh-lrcw.1 spike demo — a qm agent driving Beadhive under qm's real governance.
//
// Every decision below comes from qm's own modules, unmodified:
//   loadDeploymentLayer      src/deployment/load-layer.ts      parses deploy/layers/beadhive/sandbox
//   evaluateCommandWithLayer src/policy/command-policy.ts      decides allow / require_approval / deny
//
// The ONLY simulated piece is the container boundary: this host has no usable
// container runtime (no docker group, no sudo, newuidmap is not setuid), so an
// allowed command runs here via child_process instead of inside the agent computer.
// Commands, hive, and bead store are all real.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadDeploymentLayer } from "../../../../src/deployment/load-layer.ts";
import { defaultOrgPolicy, evaluateCommandWithLayer } from "../../../../src/policy/command-policy.ts";

const run = promisify(execFile);
const HIVE = process.env.HIVE_DIR ?? `${process.env.HOME}/workspace/github/beadhive/beadhive`;
const PATH_WITH_TOOLS = `${process.env.HOME}/.nix-profile/bin:${process.env.HOME}/.local/bin:${process.env.PATH}`;

const layer = loadDeploymentLayer(new URL("../sandbox", import.meta.url).pathname);
const policy = defaultOrgPolicy();

// What the agent wants to do this turn, in Beadflow order.
const turn = [
  { why: "orient: read the spike bead it was asked to work", cmd: "bh work issue bh-lrcw.1" },
  { why: "read the parent epic's state", cmd: "bd show bh-lrcw" },
  { why: "record what it found, durably, on the bead", cmd: "bd note bh-lrcw.1 spike-demo: qm layer governance verified from a live qm checkout" },
  { why: "try to hand the bead to review", cmd: "bh work submit bh-lrcw.1" },
  { why: "try to destroy the bead", cmd: "bd delete bh-lrcw.1" },
];

const sh = (s) => s.replace(/\s+/g, " ").trim();

for (const step of turn) {
  const verdict = evaluateCommandWithLayer(step.cmd, policy, layer.commandRules);
  console.log(`\n[1m$ ${step.cmd}[0m`);
  console.log(`  intent : ${step.why}`);
  console.log(`  policy : ${verdict.decision}${verdict.reason ? ` — ${verdict.reason}` : ""}`);

  if (verdict.decision === "deny") {
    console.log("  result : REFUSED by the beadhive layer. Not executed.");
    continue;
  }
  if (verdict.decision === "require_approval") {
    console.log("  result : HELD for human approval. Not executed.");
    continue;
  }

  const [bin, ...args] = step.cmd.split(" ");
  try {
    const { stdout } = await run(bin, args, {
      cwd: HIVE,
      env: { ...process.env, PATH: PATH_WITH_TOOLS },
      timeout: 120_000,
      maxBuffer: 8 << 20,
    });
    const first = sh(stdout).slice(0, 220);
    console.log(`  result : EXECUTED against the real hive — ${first || "(no output)"}`);
  } catch (e) {
    console.log(`  result : execution failed — ${sh(String(e.stderr || e.message)).slice(0, 220)}`);
  }
}

console.log(
  `\n${turn.length} steps: ` +
    turn
      .map((s) => evaluateCommandWithLayer(s.cmd, policy, layer.commandRules).decision)
      .reduce((acc, d) => ((acc[d] = (acc[d] ?? 0) + 1), acc), {}) &&
    JSON.stringify(
      turn
        .map((s) => evaluateCommandWithLayer(s.cmd, policy, layer.commandRules).decision)
        .reduce((acc, d) => ((acc[d] = (acc[d] ?? 0) + 1), acc), {}),
    ),
);
