# Identifiers: branches, agent names, and ids

**Node:** naming · Parent: [INDEX.md](./INDEX.md)

## A ticket's worktree is identified by its branch, never by a folder path

**The rule:** to find a ticket's worktree again — to re-dispatch it or tear it down — look it up
by **branch**. Never rebuild its folder path from the branch name.

```
worktree.open { branch: "ticket/10x/7" }   → returns the real path
```

The branch is a value you chose; Herdr passes it to git verbatim and returns it verbatim, so it
round-trips exactly. A folder path does not.

**Why a rebuilt path fails.** Herdr derives the directory name from the branch, **lowercased**,
with `/` and other unsafe characters replaced by `-`. (`--label` only names the sidebar workspace;
it has no effect on the path.)

```
--branch 'tkt/GH-42-fix-login-bug'  --label 'GH-42: Fix login bug!'
  → path: ~/.herdr/worktrees/10x-target/tkt-gh-42-fix-login-bug
          (branch, lowercased, '/' → '-';  label ignored)
```

Any uppercase in the branch is therefore lost in the path. A naive
`join(base, repo, branch.replace('/', '-'))` keeps the capitals and, on a case-sensitive
filesystem, names a directory that does not exist:

```
predicted: ~/.herdr/worktrees/10x-target/tkt-GH-42-fix-login-bug
actual:    ~/.herdr/worktrees/10x-target/tkt-gh-42-fix-login-bug

worktree.open {path: predicted} → worktree_not_found     ← verified
worktree.open {path: actual}    → worktree_opened, already_open: true
```

Violating this breaks three things at once:

1. **Reuse always misses** → a fresh worktree per dispatch instead of reusing the ticket's own.
2. **Any teardown keyed on the stored path fails** → that worktree is never freed.
3. **Dispatch errors before the pane is usable** → looks like "the pane wasn't created".

If you need the path for anything else, **persist `.result.worktree.path` from the response.**
Never recompute it.

Public IDs (`w1`, `w1:t1`, `w1:p1`) are opaque stable handles. Never construct them — and note
they are **not decimal**: observed sequence `w18, w19, w1A, w1B, w1C`. Any code that increments or
parses them numerically is broken. Closed tab and pane IDs are never reused. A pane moved between
workspaces gets a **new** workspace-qualified pane ID — after `pane.move`, continue with
`.result.move_result.pane.pane_id`.

## Branch names are `ticket/<project>/<number>` — never derived from the title

**Decision:** the branch is the project slug and the ticket number and nothing else, e.g.
`ticket/10x/7`.

Titles are free text written by humans. Turning one into a safe branch name needs either a regex
(which has edge cases a human will eventually break) or an LLM (absurd for this). A project slug
and a ticket number are already short, unique, machine-generated, and trivially copyable. So no
slugification step exists — just **validate** the project slug against
`/^[a-z0-9][a-z0-9-]{0,19}$/` and reject anything else; the number is an integer.

This matters because Herdr hands the branch to git verbatim and git enforces `check-ref-format`.
A title-derived branch fails outright. Verified:

```
--branch 'tkt/GH-42_Fix login bug'
  → worktree_create_failed: fatal: '...' is not a valid branch name
```

Uppercase in a branch is fine as far as git and Herdr are concerned — `tkt/GH-42` and `tkt/GH-77`
both work. Herdr lowercases the *directory* it derives from the branch and replaces `/` with `-`.
Under this format that derivation is case-neutral: `ticket/10x/7` yields `ticket-10x-7` —
**identical to the agent name**. That alignment is deliberate. The directory is still never a
lookup key ([the branch is the identity](./naming.md)).

## `worktree.create` is not idempotent

Verified: creating the same branch twice →

```
worktree_create_failed: fatal: '<path>' already exists
```

So the spawn path must be **`worktree.open {branch}` first, `worktree.create {branch}` on
`worktree_not_found`** — not create-then-handle-error, and never create blindly on re-dispatch.

## Agent names are `ticket-<project>-<number>`

Distinct from the branch name ([branch names](./naming.md), above). The Herdr **agent name** — the
handle passed to `agent.start` and used to target `agent.prompt` — must match
`/^[a-z][a-z0-9_-]{0,31}$/`: lowercase, **first character a letter**, 32 chars max, unique among
live agents.

**Naming scheme: `ticket-<project>-<number>`**, where `<number>` is a per-project ticket number
starting at 1. So project `10x`, ticket 7 → agent name `ticket-10x-7`. `agentNameFor` always
prefixes `ticket-`, which already guarantees the leading letter Herdr requires.

**A leading digit in the project slug is allowed.** The project slug regex is
`/^[a-z0-9][a-z0-9-]{0,19}$/`. Verified three ways:

- `git check-ref-format --branch ticket/10x/1` passes.
- `ticket-10x-7` matches Herdr's `/^[a-z][a-z0-9_-]{0,31}$/`.
- A real worktree was created on that branch.

Requiring a leading letter in the slug would reject `10x`, this project's own name.

A bare project-and-number pair makes a poor agent name on its own: `10x-1` starts with a digit and
is **invalid** as a Herdr agent name. The mandatory `ticket-` prefix is what fixes this — and it is
also why the slug itself may start with a digit.

**Dots and underscores are excluded from the project slug.** A dot is legal in a git branch but
**not** in an agent name, so `my.app` yields a valid branch and an *invalid* agent name — failing
only at spawn time, after the worktree already exists.

**The project qualifier is mandatory here, not decoration.** Agent names must be unique among *all*
live agents in the Herdr session — across every project. Ticket numbers are only unique *within* a
project, so `ticket-1` would collide the moment two projects each run their ticket 1.

**Length budget: 32 characters.** `ticket-` is 7, plus a separator, leaving `24 - len(<number>)` for
the project slug — about 20 characters with room for a 4-digit ticket number. Slugify the project
name to `[a-z0-9-]` and cap it.

## A planning agent is `ticket-<project>-<number>-plan`

**The suffix is load-bearing.** `runner.ts` catches `agent_name_taken` from `agent.start` and
silently re-attaches, treating whatever it finds as the implementation agent and deliberately
sending it no ticket text ([spawn](./spawn.md)). A planner holding the plain ticket name would
therefore be *adopted* by Start, leaving a ticket that reads In Progress with no worktree, no
branch and no instruction — and no error anywhere. `planAgentNameFor` derives from
`agentNameFor` rather than rebuilding the string, so the two cannot drift apart.

**It tightens the budget.** `-plan` costs 5 of the 32, so a *plannable* ticket needs
`len(slug) + len(number) <= 19`, against the 24 `agentNameFor` alone allows. A 20-char slug —
legal, and exactly on `agentNameFor`'s ceiling — overflows as soon as the suffix is added.
`startPlanning` tests the finished name against `AGENT_NAME_RE` and refuses with that
explanation, rather than letting Herdr reject it *after* the workspace already exists.

**The label is a second name shape that branch-based identity cannot see.** A planner has no
worktree and no branch, so [the branch-is-identity rule](./naming.md) has nothing to key on and
`worktree.list` never mentions it. Its Herdr **workspace label** is the only handle, which is
the accepted cost of a worktree-less planner and the entire reason the boot sweep in
`reconcile.ts` exists ([reconciliation](./reconciliation.md)).

So the sweep matches the whole shape `planAgentNameFor` produces —
`/^ticket-[a-z0-9][a-z0-9-]*-\d+-plan$/` — and not merely the suffix. A workspace a human
labelled `refactor-plan` is not ours, and the sweep **closes** what it matches.

**Two names means every by-name lookup has to choose one, and the board is one of them.**
`agent.list` is joined by name, so a board that resolved only `agentNameFor` reported
`agentStatus`, `paneId` and `workspaceId` as `null` for an entire planning run — observed live,
with the planner's pane sitting in Herdr: no agent chip, no column spinner, a conversation the
UI could not see. `lifecycle.ts`'s `liveAgentNameFor` resolves **a `backlog` ticket to its plan
name** and anything else to its implementation name; `server.ts`'s board and `/focus` route and
`runner.ts`'s `teardown`/`retireAgent` all call the one function, so a backlog ticket's Focus
button, its board chip, and deleting it while a planner is live all agree on the same name
(memory/teardown.md — before this was one function, teardown hardcoded `agentNameFor` and asked
about a name no backlog ticket ever has).

Keyed on **status**, not on "whichever name Herdr happens to know". The sweep is the only thing
that collects a planner whose ticket was promoted, so until the next boot a `todo` ticket can
still have a live planner — and reporting that as the ticket's own status would show work
happening on a card nobody has started.

## Four identifiers, four different scopes

Do not conflate them. The scope column is why they differ:

| Identifier | Example | Unique within | Constraint |
|---|---|---|---|
| Branch | `ticket/10x/12` | one repo | git `check-ref-format`; case preserved. The project qualifier is redundant within a single repo, but kept so the derived directory matches the agent name. |
| Agent name | `ticket-10x-12` | **the whole Herdr session** | `/^[a-z][a-z0-9_-]{0,31}$/`; project qualifier **required** |
| Plan agent name | `ticket-10x-12-plan` | **the whole Herdr session** | same regex, but 5 fewer characters of budget; doubles as the workspace label, because a planner has no branch to be found by |
| Workspace / pane ID | `w1J`, `w1J:p1` | the Herdr server | opaque, server-assigned, never constructed |

The ticket's *identity* remains its branch
([the branch is the identity](./naming.md)). An agent name is only a Herdr handle — and a
planner's is also the only thing that identifies its workspace as ours.
