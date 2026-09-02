# AGENTS.md

**Applies to anyone changing this code** — a human at the keyboard, an assistant, or a ticket agent
spawned by 10x into its own worktree.

> **Landing work** — branching, pull requests, merging, releases — is
> [`WORKFLOW.md`](./WORKFLOW.md). **If you were spawned to implement a single ticket, that file is
> not yours**: you are already on your branch, you commit there, and you stop. Do not push, do not
> open a pull request, do not switch branches.

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

## Herdr

**Never write a Herdr method, subscription type, or event name from memory or from a doc.** Confirm
it against the generated schema first — [`memory/verification.md`](./memory/verification.md) has the
command and the three JSON paths.

The schema proves a name **exists**, not its **wire separator**: emitted names are mixed, so
normalise (`event.replaceAll(".", "_")`) and never match a literal event name — see
[`memory/socket.md`](./memory/socket.md). A wrong name fails **silently**: no error, just events
that never arrive.

## Commits

**Small and surgical: one logical change per commit.** A reviewer should be able to reconstruct the
reasoning from the log, and a bad commit should be revertable without taking unrelated work with it.
Refactor, behaviour change, and doc rewrite are three commits, not one. If the subject line needs
"and", split it.

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): subject`, imperative
mood, lowercase, no trailing period, subject ≤72 chars.

`feat` `fix` `docs` `refactor` `test` `perf` `build` `ci` `chore`

Scope is the touched area when it clarifies (`feat(spawn):`, `fix(db):`). Body explains **why**;
the diff already shows what. Breaking change → `!` after the type (`feat(api)!:`) **and** a
`BREAKING CHANGE:` footer.

## Finish green

Before you call anything done:

```bash
pnpm typecheck && pnpm test
```

Both are free and take seconds. A commit that does not typecheck, or that reddens the suite, is not
finished work.

**Never run `pnpm e2e:full`.** It spawns **sixteen real coding agents** and costs real money.
It needs explicit human permission, per run — being asked to "test your change" is not that
permission.

`pnpm e2e` is agent-free but needs a live Herdr socket and binds port **4310**, so two tickets
running it at once collide. Run it only if your ticket actually touches the e2e suite.
