import type { ProjectBeadhiveOrigin } from "./project-store.ts";

/**
 * Tell an agent which Beadhive group its scope stands for.
 *
 * Deliberately narrow. The deployment layer already advertises what `bh` and
 * `bd` are and how the work loop runs, so repeating any of that here would be
 * duplicate prose that can drift out of step with the layer. The only thing
 * missing from a turn is WHICH group this is and WHERE its repos are — without
 * that, an agent in a reconciled project sees an empty scope workspace and
 * reasonably reports the project is empty, never looking at the fleet mounted
 * beside it.
 *
 * `workspacePath` is the sandbox's GIT_WORKSPACE, not a host path — the two
 * differ by sandbox mode, and naming the host's would send the agent somewhere
 * that does not exist inside its container. Omitted when unknown rather than
 * guessed.
 */
export function renderBeadhiveGroupBlock(origin: ProjectBeadhiveOrigin, workspacePath?: string): string {
  const group = `${origin.provider}/${origin.org}`;
  const lines = [
    "## Beadhive group",
    `This project is the \`${group}\` group of a Beadhive fleet: the repos of the \`${origin.org}\` org that are registered as hives.`,
  ];
  if (workspacePath) {
    const root = workspacePath.replace(/\/+$/, "");
    lines.push(
      `Its repos are checked out at \`${root}/${origin.provider}/${origin.org}\`, and the fleet's own state (HQ, worktrees) is under \`$BH_HOME\`.`,
    );
  }
  lines.push(
    "Work here is tracked as beads rather than in this project's own files, so an empty workspace does not mean there is nothing to do — start from `bh work ready`.",
    "",
    "If this computer has no fleet yet — no `$BH_HOME/hq`, or the group's directory above is missing — it has never been onboarded. Onboard it rather than improvising:",
    "",
    "1. `bh config init`, then `bh hive add <provider>/<org>/<repo> --prefix <the hive's own prefix>` for each hive you need.",
    "2. Clone the hive into the path above, then `bd bootstrap --yes` inside it.",
    "3. `bh hive migrate-storage <prefix> --confirm` — a fresh clone lands on the generic `beads` database and cannot be read until it is migrated onto the shared server.",
    "4. `bh hq init`, then `bh doctor` to record what this host observed.",
    "",
    "Do not hand-roll a `dolt sql-server`, clone HQ by hand, or read the fleet through the GitHub API: bd owns that state, and a second server on the same port breaks the one bh starts. If a read fails with `Dolt server unreachable`, run `bd dolt start` from a directory that has a beads project.",
  );
  return lines.join("\n");
}
