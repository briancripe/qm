# QM deployment

This directory is one QM deployment: a config, a secret contract, and a
sandbox layer that customizes the agent without forking the core images. Commit
everything here except `.env`, which holds the secret values and is covered by
the scaffolded `.gitignore`.

## Where the documentation lives

- `package.json` pins the exact CLI version this directory is interpreted by,
  so every checkout resolves the same `qm`. `contract` in the config is only
  the coarse compatibility floor; this pin is the reproducible one. Upgrade it
  deliberately and re-run `qm check` afterwards.
- `qm.config.jsonc` describes what to run. Every field carries a comment
  explaining it, including the full list of services, so read the file itself
  before changing it. It is JSON with comments (the `tsconfig.json` dialect).
  That applies only to the config: `tool.json` files must stay strict JSON.
- `.env.example` is the secret catalog. It lists every secret the platform
  knows, what each one is for, what enables it, and the command that produces a
  value when one exists. The secrets the current config needs appear uncommented.
  `qm init` creates a gitignored `.env`, generates its local signing
  keys, and leaves provider credentials blank for you to fill in. Never write a
  secret value into any other file.
- `slack-app-manifest.yml` creates the optional qm bot app. Slack OIDC
  deployments also get `slack-sso-manifest.yml`. Run
  `npm exec qm -- slack render` after changing `publicUrl`, then
  `npm exec qm -- outputs` for creation links.

## Customizing the sandbox

`sandbox/` defines what the agent gets in its execution environment:

- A skill is `sandbox/skills/<id>/SKILL.md`: markdown with `name` and
  `description` frontmatter that teaches the agent a workflow and when to use it.
- A tool is `sandbox/tools/<id>/tool.json`: a descriptor whose minimal form is
  `{ "id": ..., "advertise": ..., "install": { "binary": ... } }`, with the
  executable next to it when the binary is not already in the base image.
- `sandbox/Dockerfile` is optional and only needed for system packages or
  runtimes.

The scaffold ships a working example, the `greet` skill and `example-tool`.
Copy its shape, then replace or delete it.

## The workflow

Run every command from this directory.

1. `npm exec qm -- check` validates the config and the sandbox layer and prints the
   secret names the config currently requires. It builds nothing, and when
   credential values are already present in `.env` it also verifies them
   against their providers, so run it after every edit.
2. `npm exec qm -- plan` reports what deployment would do
   without changing anything.
3. After the target prerequisites are complete, `npm exec qm -- up` brings the
   deployment up and prints the URLs. An AWS directory must first complete the
   edge and authenticated-portal steps in its AWS bootstrap section below.
   `--build-from <path to a QM checkout>` is reserved for contributors
   testing unreleased runtime code.
4. `npm exec qm -- status`, `npm exec qm -- logs [service]`, and
   `npm exec qm -- down` show
   what is running, tail logs, and stop the deployment.
5. `npm exec qm -- secrets push` uploads the `.env` values to the deploy target.
   The docker target reads `.env` directly and does not need it.

`npm exec qm -- help` lists everything else, including `sandbox build` and
`rollback`.

## Beadhive building a QM App

A seat can already do this; nothing in the runtime is missing. QM's `publish`
tool collects files from the agent's workspace, deploys them behind the portal
at `/d/<slug>/`, and grants an audience — so a bead whose acceptance criteria
are "an internal page showing X" can be delivered as a running app rather than
a pull request. Since the owner app shell landed upstream, a published app also
arrives with a version chip and a docked chat for iterating on it, which makes
"deliver an app" a reviewable outcome rather than a URL handoff.

Two things stand between that and a demo, and neither is Beadhive's.

The portal serves `/d/*` only when `PORTAL_DEPLOYMENTS_ENABLED=1`. It is unset
on the development instance, so a publish there succeeds and then 404s when
opened. Set it on the portal before demonstrating this.

There is no convention yet for which beads become apps. A seat needs to know
when to reach for `publish` instead of a branch — a label, a bead type, or a
line in the molecule's acceptance criteria — and what to record on the bead
afterwards so a reviewer can find what shipped. Decide that before wiring it,
because the wiring is trivial and the convention is what makes it repeatable.

The layer's command policy governs `publish` like any other tool, so an
organization that wants apps reviewed before they reach an audience can require
approval on it without changing the seat.
