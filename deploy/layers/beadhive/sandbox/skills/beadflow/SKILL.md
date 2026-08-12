---
name: beadflow
description: Drive work through Beadhive as beads — pick up ready work, implement it in a provisioned worktree, validate, and hand it to review. Use whenever asked to find, start, progress, check, or hand off work in a repo that is a bh hive.
---

# Beadflow

Work in this organization is tracked as **beads** and driven through `bh`, the
integration-plane driver. A bead is one unit of work with first-class dependencies on
other beads. Beadflow is the process; `bh` is the tool that runs it.

**Do not improvise the lifecycle with raw `git`, `gh`, or `bd`.** Those exist, and you may
read with them, but every state transition belongs to a `bh work` verb. The verbs compose
the worktree, the identity, the validation command, and the review gate for you — hand-rolling
any one of those desynchronizes the bead from the branch.

## Orient first

```bash
bh hive ready          # is this repo onboarded as a hive at all?
bh work ready          # unblocked, dependency-ordered work
bh work issue <id>     # one bead's fields, parent, and dependencies
bh work brief <id>     # its requirements + this hive's validation command
```

`bh work ready` is the only honest answer to "what should I work on". A bead missing from
it is blocked — by an open dependency or by a gate — and starting it anyway produces work
that cannot land.

## The worker loop

```bash
bh work claim <id>     # provisions the worktree, flips the bead to in_progress
# ... implement inside the worktree bh just provisioned ...
bh work check <id>     # runs this hive's validation; fix until it exits 0
bh work submit <id>    # opens the review gate — a handoff, not "done"
```

Between `claim` and `submit` the durable artifact is the `wt/bead/<type>/<id>` branch.
Commit as you go. If your history is noisy, `bh work show <id>` renders it and
`bh work refine <id> --autosquash` squashes local checkpoints into conventional digests
behind a byte-identical gate — it can never change the net tree.

## What you must not do on your own

`bh work approve` resolves a **human** review gate, and `bh work merge` lands the bead on
the always-green integration branch. Both are approval-gated for you, and that is
deliberate: the gate exists to put a person in the loop on your work. Ask for the approval,
state what you changed and what validation you ran, and wait. Never route around a gate by
reaching for `bd gate resolve` or raw `git merge`.

If you are blocked by something in the tooling rather than the task, `bh escalate '<msg>'`
files it upward and returns immediately.

## Epics (molecules)

An epic is a set of beads delivered together on a long-lived container branch:

```bash
bh work start <epic>      # provision the container branch, mark it in_progress
bh work schedule <epic>   # the dispatch plan: what to batch vs run as singletons
bh work finish <epic>     # land the whole molecule as one --no-ff bubble
```

Batch work lives in ONE shared `wt/batch/<group>` worktree and completes as a unit
(`bh work submit --group`, then `bh work merge --group`); per-bead `submit`/`check` do not
apply to it.

## Recording what you learn

Findings belong on the bead, not in your head or only in chat:

```bash
bd note <id> "..."      # durable note
bd comment <id> "..."   # discussion
```

Do this as you go. A bead that lands without its reasoning recorded costs the next agent
the same investigation you just paid for.
