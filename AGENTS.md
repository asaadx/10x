# AGENTS.md

**Applies to anyone changing this code** — a human at the keyboard, an assistant, or a ticket agent
10x started as a Claude Code cloud session.

> **Landing work** — branching, pull requests, merging, releases — is
> [`WORKFLOW.md`](./WORKFLOW.md). **If 10x started you to implement a single ticket, that file is
> not yours**: your opening message is. Work on the branch it names (`claude/10x-<ticketId>`),
> push only that branch, open or reuse the **draft** pull request it describes, and report through
> the ticket database exactly as it says. Never merge, never mark your PR ready, never touch
> another branch.

## Memory

**Before any broad investigation — repo-wide greps, reading files to build a mental model, tracing
a subsystem, answering "how does X work here?" — read [`memory/INDEX.md`](./memory/INDEX.md) first**
and open the nodes it links for your task.

- **Update it in the same task.** A durable finding — verified mechanism, non-obvious constraint,
  gotcha that cost you time, root cause, decision and its reasoning — goes into the relevant node,
  linked from `INDEX.md`, before you finish.
- **Mark every claim `verified` (observed, with evidence) or `inferred` (reasoned, unconfirmed).**
  Never blur the two. Verify secondhand claims or label them unconfirmed leads.
- **Present-tense truth: overwrite mistakes in place.** Never append a correction, changelog, or
  "previously we thought…" note. A reader must never have to pick between two statements.
- **Not a substitute for reading code you are about to change.** Use it to know *where* to look.

## Cloud sessions

`backend/src/cloud.ts` is the **only** module that runs `claude`. The flags it uses
(`--cloud … --ref`, `-p … --cloud <id> --output-format json`) come from Anthropic's docs and have
not been exercised against a real account yet ([`memory/cloud.md`](./memory/cloud.md)); do not
add a new CLI call or flag anywhere else, and do not change these without running the smoke test
in [`docs/prototype-cloud-setup.md`](./docs/prototype-cloud-setup.md).

**Develop and test with `CLOUD_DRIVER=fake`.** It never starts a real session: it records the
calls and, with `FAKE_AGENT_MS=<ms>`, plays the agent's side of the protocol (`working`, then
`done` plus a branch) through the same database the board reads, so a ticket travels Backlog to
Review with no network and no spend:

```bash
CLOUD_DRIVER=fake FAKE_AGENT_MS=3000 pnpm start
```

The unit suite and the e2e suite both run the board this way. With `CLOUD_DRIVER` unset the board
uses your real `claude` login and **every Start or Plan click opens a paid cloud session**.

Anything an agent writes into the ticket row (`agent_state`, `branch`, `pr_url`, …) is untrusted
input: parse it at the boundary, never cast it. Every agent write is scoped
`WHERE id = ? AND run_token = ?` — keep that true of any prompt you edit (`prompts.test.ts`
checks it).

## Commits

**Small and surgical: one logical change per commit.** A reviewer should be able to reconstruct the
reasoning from the log, and a bad commit should be revertable without taking unrelated work with it.
Refactor, behaviour change, and doc rewrite are three commits, not one. If the subject line needs
"and", split it.

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, imperative
mood, lowercase, no trailing period, subject ≤72 chars.

`feat` `fix` `docs` `refactor` `test` `perf` `build` `ci` `chore`

Scope is the touched area when it clarifies (`feat(cloud):`, `fix(db):`). Body explains **why**;
the diff already shows what. Breaking change → `!` after the type (`feat(api)!:`) **and** a
`BREAKING CHANGE:` footer.

## Finish green

Before you call anything done:

```bash
pnpm typecheck && pnpm test
```

Both are free and take seconds. A commit that does not typecheck, or that reddens the suite, is not
finished work.

`pnpm e2e` is free too — every board it starts runs with `CLOUD_DRIVER=fake`, a throwaway state
dir, and an empty `GITHUB_TOKEN` and `TURSO_DATABASE_URL` — but it builds the frontend, needs a
Playwright browser, and binds port **4310**, so two runs at once collide. Run it when your change
touches the board's behaviour or the e2e suite. `pnpm e2e:full` currently runs the same specs; a
spec that needs a **real** cloud session must never be added to the `fast` project, and running one
needs explicit human permission, per run.
