# Memory Index

Entry point for the `10x` memory graph. **Read this file first**, then open only the nodes your
task touches. Every node is small on purpose — prefer reading one node over searching the codebase.

> **Provenance.** Claims marked *verified* were observed — a test that pins them, a command that
> was run, or the file cited. Claims marked *inferred* were reasoned but never executed. The
> `claude --cloud` CLI flags and real Turso are **not yet exercised** against a live account; see
> [cloud](./cloud.md).

## What this is

`10x` is a Kanban board (React + Vite frontend, zero-dependency TypeScript backend) where
starting a ticket opens a **Claude Code cloud session** that implements it on a `claude/10x-<id>`
branch and opens a draft PR. Agent and board share one database (Turso, hosted SQLite): the agent
writes its own state into the ticket row, and the board polls it.

**Scope: `Backlog → To Do → In Progress → In Review → Done`.** Backlog holds raw ideas — **Plan**
opens a planning session that fills the ticket in — and To Do holds work that is ready to start;
the server moves between them by hand, through `POST /tickets/:id/status`. When the agent reports
`done`, the poller moves the ticket to In Review. Reject sends the reason into the same session;
Accept marks the agent's draft PR ready for review; Done is terminal. Single user, no auth,
sessions or multi-tenancy anywhere; single-user races *are* handled, because double-clicks and
retries are real.

Working today: projects (added from a GitHub link and cloned by 10x), ticket CRUD, the manual
Backlog/To Do moves, Plan and Start as cloud sessions, the agent-reported state on every card,
the automatic move to In Review, Accept, Reject, Cancel, Archive, a local **Preview** of the
agent's pushed branch on a reserved port block, and PR state from webhooks or a poll. Persisted in
Turso, or a local SQLite file for tests and offline work.

## How to use this folder

1. Read this index.
2. Open the node that matches your task — the keyword lists exist so you can decide *without*
   opening the file.
3. If the answer is here, **do not grep the codebase for it.**
4. If you learn something durable that is not here, add or update a node and link it from this
   index. This is a living document.

---

## Nodes

### Agents

**[cloud](./cloud.md)** — how a ticket runs: the two `claude` CLI calls (`--cloud … --ref`,
`-p … --cloud <id> --output-format json`) and the only module that makes them, the opening
message, **the agent ↔ board protocol through Turso — every agent write scoped
`WHERE id = ? AND run_token = ?`**, the self-scheduling poller that turns `done` into In Review,
the plan session and why it is idempotent, how Start/Reject/Cancel/Accept touch a session,
Preview (fetch into `refs/10x/preview/<id>`, detached worktree, process group), the fake driver,
and the known gaps: **no session status, Cancel cannot archive, agents hold a full DB token**.
`cloud.ts · CloudDriver · CLOUD_DRIVER · fake · FAKE_AGENT_MS · claude --cloud · session_id · agent_state · run_token · tenx_sql · TENX_DB_URL · poller · settleFinishedAgents · plan · reused · session_start_failed · preview.ts · refs/10x/preview · devCommand`

**[naming](./naming.md)** — the identifiers a ticket carries and their scopes: the project slug
rule (`^[a-z0-9][a-z0-9-]{0,19}$`) and why it stays that tight, `<slug>-<number>` ticket ids and
the monotonic counter, the `claude/10x-<id>` branch the agent is asked for versus the branch it
reports, session ids, and the Preview ref and checkout path.
`slug · ticket id · next_number · claude/10x- · sessionBranchFor · session_ id · cse_ · refs/10x/preview · previews/<id>`

### Lifecycle and safety

**[operations](./operations.md)** — the ticket state machine and current scope, **the one legal-
transitions table (`backend/src/transitions.ts`) the server validates every manual move against**
and the pure-versus-side-effecting split that makes `/status` safe, **the automatic
`in_progress → in_review` transition** and why a second settle cannot fight the first, the
compare-and-swap that makes status the lock, why session columns change in the same statement as
the status, why a rollback target is the inverse of its claim, why transient statuses were
rejected, and never pointing 10x at its own repo.
`state machine · transitions.ts · /status · CAS · claim · claimTicketWith · 409 · illegal_transition · in_review · automatic transition · rollback · dogfooding`

### The application

**[architecture](./architecture.md)** — how the 10x **server** is built: zero dependencies, the
module map, the async `Sql` client and its Turso and local drivers, the database schema with its
monotonic ticket counter and the Preview port-slot pool, every endpoint plus the static asset
route, the spawn request lifecycle, what is deliberately not persisted, and how `.env` is loaded
(`env.ts`, the first import in `server.ts`, no `--env-file` anywhere).
`sql.ts · Turso · Hrana · fake-turso · schema · next_number · endpoints · port slots · MAX_PORT_SLOTS · port_pool_exhausted · static route · realpath containment · prompts/ · loadPrompt · import.meta.dirname · env.ts · loadEnvFile · .env`

**[github](./github.md)** — marking the agent's draft PR ready (REST read + GraphQL
`markPullRequestReadyForReview`) or opening one from its pushed branch, token redaction on every
error path, `owner/repo` read from the project row, the webhook receiver, the poller's PR
reconcile, and the facts the design rests on: **±LOC is in the payload**, **`mergeable` is not**,
**a conflict is never pushed**, and **`null` means retry**.
`github.ts · markPullRequestReady · openPullRequest · redact · pull_request webhook · merged · mergeable · reconcilePullRequests · gh webhook forward · GITHUB_TOKEN · GH_TOKEN · 10x-test`

**[frontend](./frontend.md)** — the board's browser half: **React + Vite + Tailwind + shadcn**, with
`frontend/src/types.ts` re-exporting the backend's vocabulary so a wire-format change is a compile
error, and `Ticket` meaning `BoardTicket` rather than the stored row. Also the `VITE_MOCK_MODE` data
layer and its 1 s poll, the two layout rules that silently break scrolling, the accessible
semantics the e2e suite locates by — including why the column heading's literal `{" "}` is
load-bearing and why `capitalize` makes `textContent` lie — and the cloud-session UI (agent-state
badge, session link, Preview).
`frontend/ · React · Vite · Tailwind · shadcn · types.ts · BoardTicket · VITE_MOCK_MODE · use-board · poll · native-select · aria-labelledby · AgentSession.tsx · SessionLink · PreviewPanel`

**[testing](./testing.md)** — the two suites, **both agent-free**: the unit suite (route tests
drive the server as a child process with `CLOUD_DRIVER=fake` and a fake GitHub) and the
Playwright suite (`CLOUD_DRIVER=fake`, `FAKE_AGENT_MS`, port 4310). Every unit target and why it
is pinned, the `e2e/fixtures.ts` contract, and why `fast` stays an allow-list.
`node:test · playwright · fast vs full · test-server.ts · github-fetch-shim · FAKE_CLOUD_LOG · FAKE_CLOUD_FAIL · startBoard · 4310 · cleanupAll`

### Reference

**[gotchas](./gotchas.md)** — the traps that do not belong to one subsystem, plus the known gaps:
restart behaviour, the base branch sessions start from, **a commitless repo being unticketable
until seeded** (`ls-remote`, not `default_branch`), the fake driver's scoping differing from the
real protocol, and Hrana's "SQL error, HTTP 200".
`gotchas · gaps · G7 · G8 · empty repo · ls-remote · default_branch · restart · Hrana error · stale state`

**[verification](./verification.md)** — how to reproduce the claims from scratch: the two
`claude` CLI smoke tests, driving the board end to end with the fake driver, pointing it at
`scripts/fake-turso.ts`, and writing a row the way an agent does with `curl`.
`probe · repro · smoke test · claude --cloud · fake-turso · v2/pipeline · tenx_sql · residue`

**[parking-lot](./parking-lot.md)** — deliberately deferred, each with research attached. **Check
here before designing anything that feels out of scope.** Scoped agent credentials, session
status and archiving, a reviewing agent, merge policy, screenshot enforcement, SSE, hosting and
remote access.
`deferred · scoped token · session status · archive · reviewing agent · merge policy · SSE · hosting`

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
