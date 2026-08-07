import { shq } from "../util/shell.ts";

/**
 * A repo registered as a hive in a Beadhive fleet.
 *
 * `provider` and `org` together are git-workspace's provider entry — the unit
 * repos are grouped by both on disk and in HQ — and are what a reconciled
 * project records as its origin.
 */
export interface BeadhiveHive {
  provider: string;
  org: string;
  repo: string;
}

/** Just enough of a sandbox to run one command; keeps this testable without one. */
export type HiveExec = (command: string) => Promise<{ stdout: string; code: number; stderr: string }>;

const HIVES_SUBPATH = "hq/hives";

/**
 * Enumerate the hives a Beadhive HQ knows about, by listing
 * `$BH_HOME/hq/hives/<provider>/<org>/<repo>.yaml`.
 *
 * Runs INSIDE the sandbox rather than reading the host, which is what makes it
 * mode-agnostic: where the sandbox bind-mounts a shared HQ it sees the fleet's
 * hives, and where each sandbox holds its own clone it sees only its own. The
 * caller does not have to know which.
 *
 * The layout is the source of truth rather than the YAML body: HQ stores each
 * hive at a path that already spells out provider/org/repo, so this needs no
 * YAML parser in the guest — which matters, since the sandbox image is not
 * guaranteed to have one.
 *
 * A missing hives directory throws rather than returning nothing. An empty
 * result and an absent HQ are very different states, and quietly conflating
 * them would leave a reconciler doing nothing at all with no way to tell why.
 */
export async function enumerateBeadhiveHives(exec: HiveExec, bhHome: string): Promise<BeadhiveHive[]> {
  const root = `${bhHome.replace(/\/+$/, "")}/${HIVES_SUBPATH}`;
  // -mindepth/-maxdepth 3 pins the shape: anything shallower or deeper is not a
  // hive record, so a stray file cannot masquerade as one.
  const r = await exec(
    `test -d ${shq(root)} && find ${shq(root)} -mindepth 3 -maxdepth 3 -type f -name '*.yaml' -print || echo __QM_NO_HQ__`,
  );
  if (r.stdout.includes("__QM_NO_HQ__")) {
    throw new Error(
      `no Beadhive HQ at ${root} — the sandbox has no fleet to read (run \`bh config init\` and clone HQ inside it)`,
    );
  }
  if (r.code !== 0) throw new Error(`listing hives at ${root} failed: ${r.stderr.trim() || `exit ${r.code}`}`);

  const hives: BeadhiveHive[] = [];
  const seen = new Set<string>();
  for (const line of r.stdout.split("\n").map((l) => l.trim())) {
    if (!line) continue;
    const rel = line.startsWith(`${root}/`) ? line.slice(root.length + 1) : line;
    const parts = rel.split("/");
    if (parts.length !== 3) continue;
    const [provider = "", org = "", file = ""] = parts;
    // Only the .yaml suffix comes off — repo names legitimately contain dots
    // (beadhive.github.io), so anything greedier loses part of the name.
    const repo = file.replace(/\.yaml$/, "");
    if (!provider || !org || !repo) continue;
    const key = `${provider}/${org}/${repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hives.push({ provider, org, repo });
  }
  return hives.sort((a, b) => `${a.provider}/${a.org}/${a.repo}`.localeCompare(`${b.provider}/${b.org}/${b.repo}`));
}

/** The distinct provider/org groups across a set of hives, in stable order. */
export function beadhiveGroupsOf(hives: readonly BeadhiveHive[]): Array<{ provider: string; org: string }> {
  const seen = new Map<string, { provider: string; org: string }>();
  for (const { provider, org } of hives) seen.set(`${provider}/${org}`, { provider, org });
  return [...seen.values()].sort((a, b) => `${a.provider}/${a.org}`.localeCompare(`${b.provider}/${b.org}`));
}
