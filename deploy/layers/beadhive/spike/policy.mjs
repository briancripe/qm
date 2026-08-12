import { loadDeploymentLayer } from "../../../../src/deployment/load-layer.ts";
import { defaultOrgPolicy, evaluateCommandWithLayer } from "../../../../src/policy/command-policy.ts";

const layer = loadDeploymentLayer(new URL("../sandbox", import.meta.url).pathname);
const policy = defaultOrgPolicy();

const cases = [
  "bh work ready",
  "bh work issue bh-lrcw",
  "bh work claim bh-lrcw.1",
  "bh work check bh-lrcw.1",
  "bh work submit bh-lrcw.1",
  "bh work approve bh-lrcw.1",
  "bh work merge bh-lrcw.1",
  "bh work finish bh-lrcw",
  "bh contrib issue create",
  "bh sync",
  "bh host retire worker-vm",
  "bd list --status open",
  "bd show bh-lrcw",
  "bd note bh-lrcw 'evidence recorded'",
  "bd close bh-lrcw.1",
  "bd gate resolve bh-hvkx",
  "bd delete bh-lrcw",
];
let pad = Math.max(...cases.map(c => c.length));
for (const c of cases) {
  const r = evaluateCommandWithLayer(c, policy, layer.commandRules);
  console.log(`${c.padEnd(pad)}  ->  ${r.decision}`);
}
