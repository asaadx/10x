# AGENTS.md

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

### Commits

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

### Before opening a PR

**Run CI locally and get it green first — a failing remote run burns GitHub runner minutes for
information you could have had in two seconds.**

```bash
pnpm typecheck && pnpm test
```

Then open the PR — never merge in its place:

```bash
gh pr create --base dev --fill
```

### Versioning

[Semver](https://semver.org) on `package.json` `version`, tagged `v<version>` on `master` at
release. Pre-`1.0.0`, so the API is unstable by declaration: `fix` → patch, `feat` → minor,
breaking → minor (not major) until `1.0.0`. Bump only when the user calls a release; a bump is never
a side effect of a feature PR.
