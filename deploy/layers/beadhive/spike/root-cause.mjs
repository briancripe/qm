import { compileSafeRegex } from "../../../../src/util/safe-regex.ts";
import { compileApproval } from "../../../../src/deployment/deployment-layer.ts";

const generated = compileApproval("bh", { command: "work merge" });
console.log("compileApproval emits:", generated.pattern);
try { compileSafeRegex(generated.pattern, "i"); console.log("  compileSafeRegex: OK"); }
catch (e) { console.log("  compileSafeRegex: REJECTED —", e.message); }

const plain = "\\bbh\\s+work\\s+merge\\b";
console.log("\nlookahead-free  :", plain);
try { const re = compileSafeRegex(plain, "i");
      console.log("  compileSafeRegex: OK; matches 'bh work merge x' =", re.test("bh work merge x")); }
catch (e) { console.log("  compileSafeRegex: REJECTED —", e.message); }
