// bh-lrcw.1 — the GO bar: a real Claude Code harness turn executing inside a scope sandbox,
// driving the beadhive toolchain through qm's own tools and command policy.
//
// Signed with qm's own signer (src/auth/source-auth-sign.ts), posted to the real
// POST /v1/turns route. Nothing here is stubbed.

import { signedRequestHeaders } from "../../../../src/auth/source-auth-sign.ts";

const BASE = process.env.QM_BASE ?? "http://localhost:3201";
const SECRET = process.env.CORE_SIGNING_SECRET;
if (!SECRET) throw new Error("CORE_SIGNING_SECRET must be set (read it from qm's .env)");

const prompt = [
  "You have a computer with the Beadhive toolchain installed. Using your execute tool, do exactly this and report what you observe:",
  "1. Run `bh --version` and `bd --version`. Report both versions.",
  "2. Run `bh work --help` and list the verb names you see.",
  "3. Run `bh host retire some-host`. Report VERBATIM what happens — do not retry it, and do not work around it.",
  "Be concise and factual about what each command actually returned.",
].join("\n");

const body = JSON.stringify({
  surface: "api",
  actor: { externalId: "spike-bh-lrcw-1", displayName: "Spike Operator" },
  conversation: { kind: "dm", threadRef: `bh-lrcw1-${Date.now()}` },
  text: prompt,
});

const path = "/v1/turns";
const headers = signedRequestHeaders(SECRET, "POST", path, body, { "content-type": "application/json" });

console.log(`POST ${BASE}${path}  (this provisions a sandbox and runs a model turn; be patient)\n`);
const started = Date.now();
const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body });
const text = await res.text();
console.log(`HTTP ${res.status}  after ${Math.round((Date.now() - started) / 1000)}s\n`);

try {
  const j = JSON.parse(text);
  console.log("status:", j.status, " sessionId:", j.sessionId);
  const reply = j.reply ?? j.text;
  if (reply) console.log("\n--- agent reply ---\n" + (typeof reply === "string" ? reply : JSON.stringify(reply, null, 2)));
  if (j.pendingApproval) console.log("\npendingApproval:", JSON.stringify(j.pendingApproval, null, 2));
  if (j.error || j.message) console.log("\nerror:", j.error, j.message);
  const keys = Object.keys(j).filter((k) => !["text", "status"].includes(k));
  if (keys.length) console.log("\nother fields:", keys.join(", "));
} catch {
  console.log(text.slice(0, 4000));
}
