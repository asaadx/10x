# AGENTS.md

## Memory

Before any broad investigation — repo-wide greps, reading files to build a mental model, tracing a
subsystem, answering "how does X work here?" — read [`memory/INDEX.md`](./memory/INDEX.md) first
and open the nodes it links for your task. It is a living document: update it in the same task
when you learn something durable, per its own conventions for verified-vs-inferred and
present-tense truth. It is not a substitute for reading the code you are about to change.

## Herdr

**Never write a Herdr method, subscription type, or event name from memory or a doc.** Confirm it
against the generated schema first — [`memory/verification.md`](./memory/verification.md). A wrong
name fails silently: no error, just an event that never arrives
([`memory/socket.md`](./memory/socket.md)).

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

```bash
pnpm typecheck && pnpm test
```

**Never run `pnpm e2e:full`** — 16 real coding agents, real model cost, needs explicit human
permission per run; being asked to "test your change" isn't that. `pnpm e2e` is agent-free but
needs a live Herdr socket and binds port **4310** — run it only if your ticket touches the e2e
suite, since two running at once collide.
