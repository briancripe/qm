// bh-lrcw.1 spike demo — qm's governance deciding, a CONTAINER agent computer executing.
//
// Everything that decides comes from qm's own modules, unmodified:
//   loadDeploymentLayer      src/deployment/load-layer.ts      parses ../sandbox
//   evaluateCommandWithLayer src/policy/command-policy.ts      allow / require_approval / deny
//
// Everything that executes runs INSIDE a container built from the beadhive layer's own
// install recipe (see agent-computer-probe.Dockerfile) — `docker exec` into the agent
// computer, not a host shell.
//
// Two documented substitutions, both forced by this host having no root:
//   1. The container runtime is rootless podman behind a Docker-compatible socket
//      (../../../../../.local/share/qmpodman/start-service.sh). qm's OWN sandbox
//      provisioning is not used, because it needs a bridge network and netavark cannot
//      setns in a single-UID user namespace.
//   2. `bd` comes from the host's nix store (beads HEAD), lent in via -v /nix:/nix:ro.
//      The released bd 1.1.2 the layer Dockerfile pins knows schema v53; this hive's
//      store is at v62, so the release cannot open it at all.
//
// The hive is a COPY. The container's bd must never touch the real store.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadDeploymentLayer } from "../../../../src/deployment/load-layer.ts";
import { defaultOrgPolicy, evaluateCommandWithLayer } from "../../../../src/policy/command-policy.ts";

const run = promisify(execFile);
const CONTAINER = process.env.BH_AGENT_CONTAINER ?? "bh-agent";
const BD_DIR = process.env.BH_BD_DIR ?? "";
const CONTAINER_PATH = `${BD_DIR ? BD_DIR + ":" : ""}/usr/local/bin:/usr/bin:/bin`;

const layer = loadDeploymentLayer(new URL("../sandbox", import.meta.url).pathname);
const policy = defaultOrgPolicy();

const turn = [
  { why: "orient: read the spike bead it was told to work", cmd: "bh work issue bh-lrcw.1" },
  { why: "read the parent epic", cmd: "bd show bh-lrcw" },
  { why: "record a finding on the bead, durably", cmd: "bd note bh-lrcw.1 spike-demo: written from inside the qm agent computer" },
  { why: "hand the bead to review", cmd: "bh work submit bh-lrcw.1" },
  { why: "destroy the bead", cmd: "bd delete bh-lrcw.1" },
];

const NOISE = /otel|metrics|Thanks for using|Curious what|Prefer to opt|issues, paths|just which|for everyone|bd is how|^\s*$/;
const clean = (s) => s.split("\n").filter((l) => !NOISE.test(l)).join(" ").replace(/\s+/g, " ").trim();

let executed = 0, held = 0, refused = 0;

for (const step of turn) {
  const verdict = evaluateCommandWithLayer(step.cmd, policy, layer.commandRules);
  console.log(`\n$ ${step.cmd}`);
  console.log(`  intent : ${step.why}`);
  console.log(`  policy : ${verdict.decision}${verdict.reason ? ` — ${verdict.reason.split(".")[0]}.` : ""}`);

  if (verdict.decision === "deny") { refused++; console.log("  result : REFUSED by the beadhive layer — never reached the container."); continue; }
  if (verdict.decision === "require_approval") { held++; console.log("  result : HELD for human approval — never reached the container."); continue; }

  try {
    const { stdout } = await run(
      "docker",
      ["exec", "-w", "/hive", "-e", "BH_SKIP_SETUP_CHECK=1", "-e", `PATH=${CONTAINER_PATH}`,
       CONTAINER, ...step.cmd.split(" ")],
      { timeout: 300_000, maxBuffer: 16 << 20 },
    );
    executed++;
    console.log(`  result : EXECUTED IN CONTAINER — ${clean(stdout).slice(0, 200)}`);
  } catch (e) {
    console.log(`  result : container execution failed — ${clean(String(e.stderr || e.message)).slice(0, 200)}`);
  }
}

console.log(`\n${executed} executed in the agent computer · ${held} held for approval · ${refused} refused`);
