import { loadDeploymentLayer } from "../../../../src/deployment/load-layer.ts";
const layer = loadDeploymentLayer(new URL("../sandbox", import.meta.url).pathname);
console.log("tools:        ", layer.tools.map(t => t.id).join(", "));
console.log("advertised:   ", layer.advertisedTools.join(", "));
console.log("hints:        ", layer.hints.length);
console.log("commandRules: ", layer.commandRules.length);
for (const r of layer.commandRules) console.log(`  [${r.decision}] ${r.pattern}`);
