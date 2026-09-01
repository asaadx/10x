# Memory Index

Entry point for the `10x` memory graph. **Read this file first**, then open only the nodes your
task touches. Every node is small on purpose — prefer reading one node over searching the codebase.

> **Provenance.** Claims marked *verified* were observed against a live Herdr server
> (herdr `0.8.2`, protocol `20`, socket API schema version `1`) using a throwaway target repo.
> Claims marked *inferred* were reasoned but never executed. Measured numbers are real.
> **Re-run [verification](./verification.md) after any Herdr upgrade** — two behaviours changed
> across a single patch release, so release notes are not sufficient.

## What this is

`10x` is a Kanban board (TypeScript, no framework) where moving a ticket to **In Progress** spawns
an OMP coding agent in its own git worktree and branch inside a Herdr pane.

**Current scope: `Backlog → In Progress → In Review → Done`.** A finished turn moves its own ticket
into In Review, where the agent stays alive so Reject can re-prompt it. Accept pushes the branch,
opens a PR and retires the agent; Done is terminal — delete only. Single user, one Linux host,
board reached from a MacBook over Tailscale. No auth, sessions, or multi-tenancy anywhere;
single-user races *are* handled, because double-clicks and retries are real.

Working today: projects, ticket CRUD, spawn with the readiness guard, live agent status, the
automatic move to In Review, Accept (publish a PR) and Reject (re-prompt with a mandatory reason),
cancel, forced teardown, orphan reporting, agent re-attach, boot reconciliation, a reserved TCP
port block per running ticket. Persisted in SQLite.

## How to use this folder

1. Read this index.
2. Open the node that matches your task — the keyword lists exist so you can decide *without*
   opening the file.
3. If the answer is here, **do not grep the codebase for it.**
4. If you learn something durable that is not here, add or update a node and link it from this
   index. This is a living document.

---

## Nodes

### Herdr mechanics

**[socket](./socket.md)** — the transport. NDJSON over a unix socket, **one request per
connection**, `params` always required, works outside a Herdr pane. Per-pane subscriptions,
`pane.exited` vs `pane.closed`, and the **inconsistently separated wire event names** that must be
normalised. The CLI is *not* a thin wrapper over this API.
`socket · NDJSON · events.subscribe · pane_id · pane_closed · normalizeEvent · HERDR_ENV`

**[spawn](./spawn.md)** — the four-call sequence, and the single most important implementation
detail in the project: **`agent.start` does not wait for readiness; the CLI does.** Includes the
strace evidence, the 6-trial race table, the required guard, and measured timings.
`worktree.create · agent.start · agent.prompt · agent_pane_busy · interactive_ready · readiness guard`

**[agent-status](./agent-status.md)** — `idle` and `done` are the **same** state; the first `idle`
arrives *before* the prompt; a turn ending is not the ticket succeeding; a prose question is
indistinguishable from success. A multi-step prompt is **one** turn. And the one that removes a
whole class of restart bugs: **`state_change_seq` turns completion into a single point-in-time
read**, no event subscription — while `revision` is pane output noise and must never be used for
it (all verified).
`idle · done · working · blocked · unknown · completion · ask tool · agent_blocked · state_change_seq · revision · point-in-time`

**[naming](./naming.md)** — **a ticket's worktree is identified by its branch, never by a folder
path.** Herdr derives the directory from the branch, lowercased. The three identifiers and their
different scopes, plus the project-slug budget and the dots-are-legal-in-branches-not-agent-names
trap.
`branch · agent name · ticket/<project>/<number> · slug · 32-char cap · worktree_not_found`

### Lifecycle and safety

**[teardown](./teardown.md)** — the trigger/depth matrix, and **the only authority on when a
worktree is removed**: always an explicit user action, never automatic. Result codes, the
single-path algorithm, and why cancel is less destructive than it looks.
`cancel · force · dirty_worktree_requires_force · workspace_not_found · branch deletion · gc.pruneExpire`

**[reconciliation](./reconciliation.md)** — **reconciliation reports; it never deletes.** The read
model, the ticket-worktree invariant, the divergence table, what actually consumes disk
(`node_modules` and OMP transcripts that outlive the worktree), and the implicit source workspace.
`orphan · unowned · worktree.list · disk · session transcript · source workspace`

**[operations](./operations.md)** — the ticket state machine and current scope, **the automatic
`in_progress → in_review` transition** and why a second settle cannot fight the first, the
compare-and-swap that makes status the lock, why transient statuses were rejected, never pointing
10x at its own repo, and handling a dead pane.
`state machine · CAS · claim · 409 · in_review · automatic transition · dogfooding · pane exit`

### The application

**[architecture](./architecture.md)** — how the 10x **server** is built: zero dependencies, the
module map, **stored vs derived**, the database schema with its monotonic ticket counter and
port-slot pool, all fourteen endpoints plus the static asset route, the spawn request lifecycle,
and what is deliberately not persisted.
`node:sqlite · schema · next_number · endpoints · RunSpec · stored vs derived · port slots · MAX_PORT_SLOTS · port_pool_exhausted · static route · realpath containment`

**[github](./github.md)** — publishing a branch as a PR (token redaction on every error path,
`owner/repo` read from `origin`, an existing PR is adopted not failed), and the facts the unbuilt
webhook receiver must be written against: **±LOC is in the payload**, **`mergeable` is not**,
**a conflict is never pushed**, and **`null` means retry**.
`github.ts · pushTicketBranch · openPullRequest · redact · pull_request webhook · merged · mergeable · gh webhook forward · GITHUB_TOKEN · 10x-test`

**[frontend](./frontend.md)** — the board's browser half: **four layers across five ES modules**, no
framework, no build step, and the rule that makes a redesign safe — nothing is located by a CSS
class and no class ever carries state, so renaming one cannot change behaviour. Also the design
tokens, the 1 s poll, the client-built attach command, and the accessible semantics a UI spec is
allowed to locate by.
`public/ · frontend layers · render.js · handlers · data-* hooks · design tokens · --space-9 · poll · attach command · aria-labelledby`

**[testing](./testing.md)** — the two suites, and **which command costs money**: `npm run e2e` is an
allow-list of the three agent-free specs (18 tests, ~7 s), while `npm run e2e:full` spawns **16 real
agents**. Every unit target and why it is pinned, the `e2e/fixtures.ts` contract, the per-test
budgets, and what the suite reads outside the HTTP API.
`node:test · playwright · fast vs full · e2e:full · requireHerdr · startBoard · 4310 · cleanupAll · real agents`

### Reference

**[gotchas](./gotchas.md)** — the assorted traps that do not belong to one subsystem, plus known
gaps **G2–G6** (restart resilience, concurrency, pnpm, attention-aware transition, version pinning).
`gotchas · gaps · G6 · headless geometry · agent_not_ready`

**[verification](./verification.md)** — how to reproduce every claim from scratch, and **how to
verify a Herdr name against the schema before writing code against it**. The schema proves a name
exists but *not* its wire separator. Includes the `state_change_seq` probe recipe and the
five-dial residue check a probe owes afterwards.
`probe · repro · herdr api schema · EventKind · falsifiable · state_change_seq · residue`

**[parking-lot](./parking-lot.md)** — deliberately deferred, each with research attached. **Check
here before designing anything that feels out of scope.** Accept/Reject/Preview and Done, merge
policy, the teardown review, SSE, project-slug validation timing, databases/hosting, multi-repo
projects, and remote access.
`deferred · Done · Accept · Reject · merge policy · SSE · /collab · --remote · projects`

---

## Conventions for adding a node

- One topic per file, kebab-case name, **no dates in filenames**. Keep nodes small: if one passes
  ~250 lines, split it.
- Link it from **Nodes** above with a one-line purpose and a keyword list. The keywords exist so an
  agent can decide whether to open the file without opening it.
- Mark every claim **verified** (observed, with the evidence) or **inferred** (reasoned,
  unconfirmed). Never blur the two.
- Cross-link siblings inline rather than duplicating their content. **Never reference a section
  number** — link the node.
- **Memory is present-tense truth.** These files are assumed current and correct. When something
  here turns out to be wrong, **overwrite it** — do not append a correction, changelog, or
  "previously we thought…" note. No archaeology, no superseded claims. A reader must never have to
  decide which of two statements is the live one.
- **Secondhand claims are not knowledge.** Findings from another agent, a stale branch, or an
  unverified report either get verified and stated plainly, or get labelled as an unconfirmed lead.
  Never launder a report into a fact.
