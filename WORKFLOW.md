# WORKFLOW.md

How work gets **landed**: branching, pull requests, merging, releases.

> **Not for ticket agents.** If 10x started you as a cloud session to implement one ticket, your
> opening message sets your branch and your draft pull request — follow it and stop.
> [`AGENTS.md`](./AGENTS.md) is the file that applies to you. Everything below is for whoever
> integrates that work.

## Git

**Never commit to `master` or `dev`.** `master` is the release branch and the remote default; `dev`
is integration. Both are reached only by merged PR.

```bash
git switch dev && git pull && git switch -c feat/<slug>    # always branch first
```

**Never push to `master`.** Never `git push --force`; `--force-with-lease` is allowed only on your
own open PR branch. **Never force a merge** — no `gh pr merge --admin`, no bypassing a failing or
pending check, no merging your own PR to dodge review. Every one of these needs **explicit user
approval, per instance.** Approval for one force-push is not standing permission.

## Running it locally

```bash
CLOUD_DRIVER=fake FAKE_AGENT_MS=3000 pnpm start   # build + serve the board on :4010, no real sessions
CLOUD_DRIVER=fake FAKE_AGENT_MS=3000 pnpm dev     # API on :4010 + Vite with hot reload on :5173
```

`CLOUD_DRIVER=fake` never runs `claude`; with `FAKE_AGENT_MS` it plays the agent so a ticket
reaches In Review on its own. Leave `TURSO_DATABASE_URL` empty to use a local SQLite file under
`STATE_DIR`. Real sessions (`CLOUD_DRIVER` unset) cost money on every Start and Plan — set them up
with [`docs/prototype-cloud-setup.md`](./docs/prototype-cloud-setup.md).

## Before opening a PR

**Run CI locally and get it green first — a failing remote run burns GitHub runner minutes for
information you could have had in seconds.**

```bash
pnpm typecheck && pnpm test
```

If the change touches the board's behaviour, also run `pnpm e2e` — agent-free, because every
board it starts uses `CLOUD_DRIVER=fake` (`e2e/fixtures.ts`). CI does not run it.

Then open the PR — never merge in its place:

```bash
gh pr create --base dev --fill
```

**Always `--base dev`. Never open a PR against another feature branch.** If the base merges first,
your PR merges into a branch that `dev` has already absorbed: GitHub reports it **merged** while its
commits reach `dev` **never**. This has happened once here — PR #29 merged into a fix branch six
seconds after #28 had merged that same branch into `dev`, and the webhook receiver silently did not
ship. Two independent PRs off `dev` are always safer than a stack, even when one logically follows
the other.

## Versioning

[Semver](https://semver.org) on `package.json` `version`, tagged `v<version>` on `master` at
release. Pre-`1.0.0`, so the API is unstable by declaration: `fix` → patch, `feat` → minor,
breaking → minor (not major) until `1.0.0`. Bump only when the user calls a release; a bump is never
a side effect of a feature PR.
