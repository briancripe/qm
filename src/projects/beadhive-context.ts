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
export function renderBeadhiveGroupBlock(
  origin: ProjectBeadhiveOrigin,
  workspacePath?: string,
): string {
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
  );
  return lines.join("\n");
}
