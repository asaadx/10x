# Memory Index

Entry point for the `10x` memory graph. **Read this file first.** Each node below is a
Markdown file holding verified, load-bearing knowledge about this project. Prefer reading a
node over searching the codebase.

## What this is

`10x` is a Kanban board (TypeScript frontend + backend) where dragging a ticket into
**In Progress** spawns a coding agent in its own git worktree and branch, inside a
[Herdr](https://herdr.dev) pane. Eventual columns: Backlog → In Progress → In Review → Done.

**Current scope is deliberately narrow: `Backlog ↔ In Progress` only.** In Review and Done are
deferred. There is no Kanban UI yet and none is needed — the next step is a throwaway test
frontend with two buttons ("pretend a ticket moved to In Progress", "pretend I dragged it back")
driving `POST /tickets/:id/spawn`, `POST /tickets/:id/cancel`, and `GET /tickets` (node 01 §7).
Getting those two transitions reliable is the whole job right now.

Single user, hosted on one machine running Linux, frontend reachable on my Macbook. No auth,
sessions, or multi-tenancy anywhere. **Single-user races are still handled** — double-clicks,
double-drags, and retries are real, so ticket claiming uses compare-and-swap (node 01 §9).

Project status: **validation phase.** No application code exists yet. Spawn and teardown are
validated by hand against a live Herdr server (**herdr 0.8.2, protocol 20**); the evidence is in
node 01. The socket API schema is not committed — regenerate with
`herdr api schema --output <path>` when needed.

## How to use this folder

1. Read this index.
2. Read the node that matches your task.
3. If the answer is here, **do not grep the codebase for it.**
4. If you learn something durable that is not here, add or update a node and link it from
   this index. This is a living document.

## Nodes

### 01 — [Herdr worktree + OMP agent lifecycle](./herdr-omp-lifecycle.md)

The validated mechanism for going from an HTTP request to a running OMP agent, and back to
zero residue. **Read this before touching anything that spawns, monitors, or tears down an
agent.**

Contains:

- The 4-call spawn sequence (`worktree.create` → `events.subscribe` → `agent.start` → `agent.prompt`)
- Socket transport contract (NDJSON, one request per connection, works outside a Herdr pane)
- **How to read completion correctly** (§4.1): `idle` and `done` mean the same thing, the first
  `idle` is a false positive, and a prose question is indistinguishable from success
- **§5.0 — the only authority on when a worktree is removed.** Removal is always an explicit user
  action; nothing removes a worktree automatically. Reconciliation (§5.2) reports divergence and
  never deletes.
- **The `agent_pane_busy` race** (§1): a freshly created pane is not at its shell prompt yet, so
  `agent.start` must retry. A human never hits this; a program always can.
- **Concurrency control** (§9): compare-and-swap the ticket's real status, reject on failure. No
  transient states, no queue — with why transient states cost more than they give
- What actually consumes disk (§5.3): dependencies inside worktrees, and OMP session transcripts
  that survive worktree removal and must be deleted during teardown
- **The highest-risk trap** (§6.2): worktree directory names derive from the *branch*, lowercased
  — so predicted paths never match, breaking reuse, teardown, and dispatch at once
- The three distinct identifiers — branch, agent name, workspace/pane ID — and their constraints
- Scope (§7): two columns, two transitions, a checkmark on completion, and the canonical endpoints
- Operational safety (§9): never point 10x at its own repo
- Gotchas, measured timings, and known gaps G2–G6

Keywords: herdr, worktree, branch, pane, workspace, omp, agent, spawn, teardown, cleanup,
reconciliation, subscription, event, `pane.agent_status_changed`, `agent_pane_busy`,
`invalid_agent_name`, `dirty_worktree_requires_force`, `workspace_not_found`, `worktree_not_found`,
`not_linked_worktree`, `worktree_create_failed`, socket, NDJSON, orphan, disk, predicted path,
branch slug, case sensitivity, compare-and-swap, race.

### 02 — [Parking lot](./parking-lot.md)

Deliberately deferred items, each with research already attached so picking one up does not start
from zero. **Check here before designing anything that feels out of scope** — the answer may
already be recorded.

Currently holds:

- **Remote access to the Herdr session from another machine** — `herdr --remote <host>` (or plain
  SSH + `herdr`) already does it; `/collab` is the wrong tool and cannot give terminal/skills
  access. **Read from the docs, not yet run — unverified.** Includes an unexplained two-client
  prompt breakage.
- **In Review, Done, and merge policy** — decisions reached, deferred until Backlog ↔ In Progress
  is solid. A worktree is only truly reclaimable on merge.
- **Revisit teardown as a whole** — open question: enumerate every teardown trigger and choose the
  depth for each. Node 01 §5.0 is provisional until this is done in one sitting.
- **Push board updates with SSE** — the backend already receives Herdr events instantly; only the
  browser polls. ~30 lines, do it when the real UI replaces the harness UI.
- **Validate the project slug at creation time** — the 32-char agent-name ceiling and the
  branch-vs-agent charset mismatch both currently fail mid-spawn. Do it with the change that makes
  projects addable.
- **Port allocation for per-ticket dev servers** — one board per environment, but one dev server per
  ticket that runs the app. Decision: port = base + ticket number. Needed before dogfooding.
- **Databases, hosting, multi-machine access** — raised, context captured, not answered.
- **Projects (multi-repo)** — the board will span several projects; makes "project" a first-class
  concept and removes any implicit default repo.

Keywords: collab, /collab, --remote, ssh, attach, thin client, remote session, tailscale,
database, hosting, deployment, projects, multi-repo, deferred, out of scope.


## Not yet written

These nodes do not exist. Do not try to read them.

- Frontend drag rules and column state machine — not built yet. The allowed transitions are
  recorded in node 01 under "Ticket state machine".
- Backend HTTP surface / persistence — not built yet.
- Ticket schema — not built yet.

## Conventions for adding a node

- One topic per file, kebab-case filename, no date in the name.
- Link it from the **Nodes** section above with a one-line purpose and a keyword list. The
  keywords exist so an agent can decide whether to open the file without opening it.
- Mark every claim as either **verified** (observed, with the evidence) or **inferred**
  (reasoned, unconfirmed). Never blur the two.
- Cross-link sibling nodes inline rather than duplicating their content.
- **Memory is present-tense truth.** These files are assumed current and correct. When something
  here turns out to be wrong, **overwrite it** — do not append a correction, changelog, or
  "previously we thought…" note. No archaeology, no superseded claims, no dated revisions. A
  reader must never have to decide which of two statements is the live one.
- **Secondhand claims are not knowledge.** Findings from another agent, a stale branch, or an
  unverified report either get verified and stated plainly, or get labelled as an unconfirmed
  lead. Never launder a report into a fact.
