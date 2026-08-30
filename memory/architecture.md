# Architecture

**Node:** architecture · Parent: [INDEX.md](./INDEX.md)

How the 10x application itself is built. Read this first to orient; the Herdr/OMP behaviour this code is written against lives in [spawn](./spawn.md), [socket](./socket.md), [agent-status](./agent-status.md), [teardown](./teardown.md) and [reconciliation](./reconciliation.md).

## 1. Runtime and dependencies

| Fact | Value |
| --- | --- |
| Runtime | Node **24** (`engines.node: ">=24"`); verified on `v24.19.0` |
| Language | TypeScript executed directly — `node src/server.ts`, no build step |
| Runtime dependencies | **zero**; `package.json` has no `dependencies` key at all |
| devDependencies | `typescript ^5.7.2`, `@types/node ^24.13.3` for `tsc --noEmit`, plus `@playwright/test` for the e2e suite. No runtime dependency, ever. |
| Built-ins used | `node:sqlite`, `node:http`, `node:net`, `node:test`, `node:fs`, `node:child_process`, `node:timers/promises` |
| tsconfig | `module`/`moduleResolution: nodenext`, `allowImportingTsExtensions`, `noEmit`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `target ES2023`; `include` covers `src/`, `e2e/` and `playwright.config.ts` |

Imports carry the `.ts` extension (`./herdr.ts`): Node resolves the real file, and `allowImportingTsExtensions` makes `tsc` agree.

**The zero-dependency property is a constraint, not an accident.** SQLite, the test runner and the HTTP server are all standard library. Adding a runtime dependency is a decision to be argued for, not a detail to be slipped in.

### Type stripping limits how code is written

Node runs `.ts` in **strip-only mode**: types are erased, nothing is transformed. Syntax needing emit is a hard `SyntaxError` at load. Verified by running both on `v24.19.0`:

```
class A { constructor(readonly x: number) {} }
  SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
enum E { A }
  SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
```

So: no constructor parameter properties, no `enum`. `HerdrError` in `src/herdr.ts` is written the long way for exactly this reason — `readonly code: string` declared as a field, then assigned in the constructor body. Status is a **union type** (`"backlog" | "in_progress"`), never an enum.

`tsconfig.json` sets `erasableSyntaxOnly`, so `npm run typecheck` rejects a parameter property or an `enum` instead of letting Node discover it at load time. The typechecker is the guard, not convention.

## 2. Module map

Line counts are `wc -l`, current as of this node.

| File | Lines | Responsibility | I/O |
| --- | --- | --- | --- |
| `src/server.ts` | 398 | HTTP routing, per-run in-memory state, boot reconciliation | `node:http` |
| `src/runner.ts` | 453 | `spawn` / `teardown` for one ticket; the readiness guard | Herdr socket, fs, `git` via `execFile` |
| `src/ticket-store.ts` | 281 | Ticket persistence + `/tickets` handler bodies, input narrowing | SQLite |
| `src/db.ts` | 263 | Schema, connection, row types, `claimTicket` CAS, port-slot reserve/release | SQLite (opens DB at import) |
| `src/projects.ts` | 214 | Project CRUD, slug / repo / base-branch validation | SQLite, `existsSync` |
| `src/reconcile.ts` | 167 | Read-only divergence + orphan reporting | Herdr socket (reads only) |
| `src/herdr.ts` | 158 | Newline-JSON unix-socket client: `request`, `subscribe` | `node:net` |
| `src/ports.ts` | 98 | **Pure.** Port-slot pool: cap, block arithmetic, `.env` body | none |
| `src/lifecycle.ts` | 71 | **Pure.** Naming, event normalisation, readiness predicates | none |
| `src/panes.ts` | 39 | `focusAgent`, `paneLocation`, `attachCommand` | Herdr socket (`attachCommand` is pure) |
| `src/diagnostics.ts` | 40 | **Pure.** Per-run diagnostics record + `freshDiagnostics()` | none |
| `src/lifecycle.test.ts` | 182 | Tests for the pure helpers | none |
| `src/port-slots.test.ts` | 115 | Tests for reserve / release / reclaim, against a temp DB | SQLite (temp dir) |
| `src/db.test.ts` | 101 | Tests for the CAS, against a temp DB | SQLite (temp dir) |
| `src/ports.test.ts` | 78 | Tests for the pure allocator | none |
| `public/index.html` | 1232 | The entire frontend | `fetch` |

`lifecycle.ts`, `ports.ts` and `diagnostics.ts` are the only import-free modules, deliberately: they hold the logic that has actually broken, or that would break silently, so it must be testable without a Herdr session. A port collision surfaces as an `EADDRINUSE` inside somebody's worktree, never as an error on the board, which is exactly why the allocation policy lives apart from the SQL that stores it. `panes.ts` exports only `focusAgent`. The attach command is built in the frontend instead, because it needs `location.hostname` — which the server cannot know — so a server-side copy would be unreachable duplication.

## 3. Stored vs derived — the load-bearing idea

| Value | Where | Why |
| --- | --- | --- |
| `branch`, `agent_name` | **stored** in SQLite | *We* choose them and hand them to Herdr. Persisting means a later change to the naming format cannot orphan an existing ticket: it keeps pointing at the branch that actually exists. See [naming](./naming.md). |
| `session_dir` | **stored** | The OMP transcript directory. Outlives the worktree, and teardown needs it after the agent is gone; it is a mangled slug of the worktree path and must never be reconstructed. See [teardown](./teardown.md). |
| worktree path | **never stored** | Herdr derives it from the branch by lowercasing and `/`→`-`. A predicted path never reliably matches. |
| `pane_id`, `workspace_id`, `agent_status`, worktree existence | **never stored** | Herdr owns them and they change under us (`pane.move` reissues a pane id). Read live on every request. |

Every read joins on **branch and agent name**, never on a path — in `board()` (`src/server.ts`), in `findOrphans` and in `reconcileTickets` alike. Consequence: the board cannot drift from reality; at worst it is one second stale. See [reconciliation](./reconciliation.md).

`board()` costs **two kinds of call, not one per ticket**: one session-wide `agent.list` plus one `worktree.list` per distinct repo, all under `Promise.all`. A failed `agent.list` is caught and degraded to "statuses read as unknown" rather than failing the render. An `agent.list` row with no `name` (an unnamed pane, e.g. this session's own) is filtered out before the join, or it could match a ticket.

## 4. Database schema

SQLite at `$DB_PATH`, defaulting to `$STATE_DIR/10x.db`, `STATE_DIR` defaulting to `~/.10x`. Opened at module import in `db.ts` with `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.

**`projects`** — `id` TEXT PRIMARY KEY (the immutable slug, feeds branch and agent name) · `name` TEXT NOT NULL (display only, freely renameable) · `repo_path` TEXT NOT NULL (absolute, must contain a `.git` entry) · `base_branch` TEXT NOT NULL DEFAULT `'main'` (passed to `worktree.create` as `base`) · `next_number` INTEGER NOT NULL DEFAULT 1 (monotonic ticket counter) · `created_at`, `updated_at` TEXT NOT NULL (ISO instants).

**`tickets`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | literally `<projectId>-<number>` |
| `project_id` | TEXT NOT NULL REFERENCES projects(id) **ON DELETE CASCADE** | deleting a project drops its tickets |
| `number` | INTEGER NOT NULL | per-project, starts at 1 |
| `title` / `description` | TEXT NOT NULL / NOT NULL DEFAULT `''` | the only two fields a PATCH may touch |
| `status` | TEXT NOT NULL DEFAULT `'backlog'` | `backlog` \| `in_progress`; anything else decodes as `backlog` |
| `finished` | INTEGER NOT NULL DEFAULT 0 | a turn settled *after* `working` was seen |
| `died` | INTEGER NOT NULL DEFAULT 0 | the pane exited — **not** the same as finished |
| `branch`, `agent_name`, `session_dir` | TEXT (nullable) | null until first spawn |
| `port_slot` | INTEGER (nullable) | index into the port pool; held only while `in_progress` |
| `created_at`, `updated_at` | TEXT NOT NULL | equal ⇒ never edited |
| — | — | **`UNIQUE (project_id, number)`** |

Plus `CREATE INDEX tickets_by_project ON tickets (project_id, status)` and
`CREATE UNIQUE INDEX tickets_port_slot ON tickets (port_slot)`.

### The port pool

Every running ticket gets a reserved **block** of TCP ports, so two agents' dev servers cannot collide and neither can collide with the board. A slot maps to `base + slot * stride` through `base + slot * stride + stride - 1`: with the defaults slot 0 owns **4100-4109** and slot 9 owns **4190-4199**, a pool of **4100-4199** that is clear of the board on 4010 and the e2e harness on 4310.

| Env var | Default | Meaning |
| --- | --- | --- |
| `MAX_PORT_SLOTS` | `10` | slots held concurrently; the 11th spawn is refused |
| `PORT_BLOCK_BASE` | `4100` | first port of slot 0 |
| `PORT_BLOCK_STRIDE` | `10` | ports per slot |

A malformed value throws at load rather than falling back, so a typo cannot masquerade as the default.

**A bounded pool, not `base + ticket.number`.** Ticket numbers grow without bound and would eventually walk into ports other software owns; a fixed pool cannot, and a freed slot is reused rather than retired. **A block, not one port**, because a project running Vite beside an API needs two and retrofitting a second port means renumbering everything.

**The UNIQUE index is the safety**, exactly as the conditional UPDATE is for `claimTicket`: SQLite makes a double assignment impossible instead of application code promising not to make one. NULLs are distinct in SQLite, so any number of tickets may hold no slot. `reservePortSlot` picks the lowest free slot inside a `BEGIN IMMEDIATE`, so the read of the held set and the write that joins it cannot be split by a second writer; it is idempotent, returning the slot a ticket already holds rather than stranding it.

**Reserved at spawn, before the agent starts**, because the block is written into the worktree the agent boots in and there is no later point at which it could be injected. The accepted consequence is that `MAX_PORT_SLOTS` is *also* a cap on concurrently in-progress tickets. Released by every teardown path — cancel, ticket delete, worktree-only delete, and a failed spawn — from a `finally`, so a Herdr call that fails halfway cannot strand a tenth of the pool.

`db.ts` migrates an existing database in place: `CREATE TABLE IF NOT EXISTS` leaves it alone, so `port_slot` is added with `ALTER TABLE` when `PRAGMA table_info` says it is missing. The uniqueness has to be a separate `CREATE UNIQUE INDEX` because SQLite's `ADD COLUMN` rejects a UNIQUE constraint. *(Verified against a copy of a real `~/.10x/10x.db`.)*

**`next_number` is why ticket numbers are safe.** The next number is claimed by *advancing* the counter, never by `MAX(number)+1`:

```sql
UPDATE projects SET next_number = next_number + 1 WHERE id = ? RETURNING next_number - 1 AS next
```

Deleting the highest ticket would otherwise recycle its number. Deleting a ticket **deliberately leaves its worktree on disk** ([teardown](./teardown.md)), so a recycled number would produce a branch colliding with the orphan still there — and the new ticket would silently inherit another ticket's work. The claim and the `INSERT` share a `BEGIN IMMEDIATE`, so two concurrent creates cannot read the same counter and race the `UNIQUE` constraint.

## 5. The CAS — status is the lock

```ts
export function claimTicket(id: string, from: Status, to: Status): boolean {
  const res = db
    .prepare("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(to, nowIso(), id, from);
  return res.changes === 1;
}
```

The conditional `WHERE` *is* the lock, and the row count reports whether the caller won. A second concurrent request matches nothing and loses. There is no other lock in the system and no queue: **claim first, work second, and reject rather than queue** so the conflict stays visible instead of becoming a second spawn on the same branch. It holds across processes, unlike the in-process check-then-assign it replaced. See [operations](./operations.md).

`PATCH /tickets/:id` therefore refuses to touch `status`, `number`, `projectId`, `branch`, `agentName`, `finished`, `died` or `sessionDir` — naming any of them is a 400 `immutable_field`. Those columns are written only by `setRunFields`, from the spawn/teardown paths.

## 6. HTTP surface

`PORT` defaults to `4010`. `GET /` and `GET /index.html` serve `public/index.html` as `text/html`; everything else is `application/json`. Router excerpt this table is based on (`src/server.ts` `handle()`, lines 160–305):

```ts
if (method === "GET"  && path === "/projects") return json(listProjects());
if (method === "POST" && path === "/projects") { … }
const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
if (projectMatch?.[1]) {
  const id = projectMatch[1];
  if (method === "PATCH")  { … }
  if (method === "DELETE") return json(deleteProject(id));
}
if (method === "GET"  && path.startsWith("/tickets")) { … return board(q?.get("project") …); }
if (method === "POST" && path === "/tickets") { … }
const m = /^\/tickets\/([^/]+)(\/spawn|\/cancel|\/worktree|\/focus)?$/.exec(path);
if (!m?.[1]) return json({ error: "not_found", path }, 404);
…
if (!action   && method === "PATCH")  { … }
if (inFlight.has(id)) return json({ error: "operation_in_flight", id }, 409);
if (!action   && method === "DELETE") { … }
if (action === "/focus"    && method === "POST")   { … }
if (action === "/spawn"    && method === "POST")   { … }
if (action === "/cancel"   && method === "POST")   { … }
if (action === "/worktree" && method === "DELETE") { … }
return json({ error: "not_found", path, method }, 404);
```

**Twelve** JSON endpoints, plus the two static routes.

| # | Method | Path | Returns |
| --- | --- | --- | --- |
| 1 | GET | `/projects` | `Project[]` |
| 2 | POST | `/projects` | `201` the created `Project` |
| 3 | PATCH | `/projects/:id` | the updated `Project`; changing `id` is a 400 |
| 4 | DELETE | `/projects/:id` | `{ok}` — tickets cascade, worktrees deliberately do not |
| 5 | GET | `/tickets[?project=<id>]` | `{tickets: LiveTicket[], unowned: Orphan[]}`; a `LiveTicket` is the stored row plus the live join `branch`, `agentName`, `agentStatus`, `hasWorktree`, `worktreePath`, `paneId`, `workspaceId`, `busy`, `diagnostics` |
| 6 | POST | `/tickets` | `201` the created `Ticket` |
| 7 | PATCH | `/tickets/:id` | the updated `Ticket` (title/description only) |
| 8 | DELETE | `/tickets/:id` | `{ok}` after a full destructive teardown |
| 9 | POST | `/tickets/:id/spawn` | `{ok, workspaceId, paneId, worktreePath, branch, diagnostics}` |
| 10 | POST | `/tickets/:id/cancel` | `{ok:true}` after teardown + branch delete |
| 11 | DELETE | `/tickets/:id/worktree` | `{ok:true, branchKept}` — disk reclaimed, branch kept |
| 12 | POST | `/tickets/:id/focus` | `{ok}` or `{ok:false, error:<herdr code>}` — always 200 |
| — | GET | `/`, `/index.html` | the HTML board |

**Naming and shape decisions.** The spawn endpoint is canonically **`/spawn`**; earlier drafts called it `/start`, `spawn` is the name, it is the only spelling in the code, and `/start` must not be reintroduced. `spawn` and `cancel` are **separate endpoints** because they are opposite operations with different side effects, and `GET /tickets` is a read — that is why there is no single "transition" endpoint taking a target state: one verb per irreversible act, so the destructive ones cannot be reached by passing a different string.

**Errors.** Uniform envelope everywhere: `{error, field?, message?}` plus context keys (`id`, `projectId`, `status`, `path`).

| Status | Meaning | Examples |
| --- | --- | --- |
| 409 | lost CAS, an operation already in flight, or no resource left to hand out | `not_in_backlog`, `not_in_progress`, `operation_in_flight`, `project_exists`, `port_pool_exhausted` |
| 404 | unknown ticket, project, or route | `no_such_ticket`, `no_such_project`, `project_not_found`, `not_found` |
| 400 | validation / immutability | `invalid_input`, `immutable_field`, `invalid_project_slug`, `invalid_name`, `invalid_repo_path`, `invalid_base_branch`, `invalid_body`, `project_id_immutable` |
| 500 | anything else, including a Herdr failure mid-operation | `{error: <message>}`, plus `diagnostics` on a failed spawn |

Two quirks, both readable in the excerpt: `GET` is matched by `path.startsWith("/tickets")` *before* the `/tickets/:id` regex, so `GET /tickets/anything` returns the whole board — there is no single-ticket GET. And `/focus` never fails the request: a dead agent is an ordinary UI outcome, so the Herdr error code is reported inside a 200 body.

## 7. Request lifecycle for a spawn

`POST /tickets/:id/spawn`, end to end:

1. `resolve(id)` loads the ticket **and** its project; either missing is a 404.
2. `inFlight.has(id)` → 409 `operation_in_flight`.
3. `claimTicket(id, "backlog", "in_progress")` — a lost claim is 409 `not_in_backlog`. No `await` sits between the check and the write.
4. `reservePortSlot(id)` takes the lowest free port block. Exhaustion hands the claim straight back with `claimTicket(id, "in_progress", "backlog")` and answers 409 `port_pool_exhausted` carrying `cap`, because an agent with no port of its own is worse than no agent.
5. `inFlight.add(id)`; a fresh `RunState { diagnostics, sessionDir }` goes into `runs`; `setRunFields(id, { finished: false, died: false })`.
6. `specFor(ticket, project)` builds `RunSpec { projectId, number, title, description, repoPath, base }` — the ticket's own fields plus the *project's* repo and base branch.
7. `spawn(spec, block, state, onStatus, onPaneExit)` in `runner.ts` talks to Herdr: `worktree.open` → `pane.list` (falling back to `worktree.create` only on `worktree_not_found`, because create is not idempotent) → **write `.env` into the worktree and exclude it from git** → `events.subscribe` **before** `agent.start`, or the first `working` transition is lost → `agent.start` behind the readiness guard, polling `agent.get` every 125 ms → `agent.prompt`, retried up to 40× at 250 ms on `agent_not_ready`. Deadlines: `PANE_WAIT_MS` 15 000, `READY_WAIT_MS` 60 000. Details in [spawn](./spawn.md).
8. Events feed the two callbacks: `pane_agent_status_changed` sets `finished` only once `working` has been seen; `pane_exited`/`pane_closed` set `died: true, finished: false`, because a dead pane is not a finished ticket ([agent-status](./agent-status.md)).
9. On success `setRunFields(id, { branch, agentName, sessionDir })` persists the three values we own. On throw, the claim *and* the port slot are released and any worktree left behind resurfaces in the board's `unowned` list.
10. `finally` clears `inFlight`.

### Injecting the port block

`.env` is written into the worktree root with `PORT` (the block's first port) plus `PORT_RANGE_START` and `PORT_RANGE_END`, commented so a human who finds it knows 10x wrote it. `SYSTEM_PROMPT` names the same range and says the agent must read the port from `.env` and bind nothing outside the block — a **convention, not a sandbox**; nothing enforces it.

**The worktree is a real git worktree the agent commits in, so a stray `.env` is one `git add -A` from being committed.** The project's tracked `.gitignore` is not ours to edit, so the entry goes into the exclude file instead. Resolve it with `git rev-parse --path-format=absolute --git-path info/exclude`, never by joining `.git/info/exclude` onto the worktree path: in a linked worktree `.git` is a **file**, and git resolves `info/exclude` against the **common** git directory — the source repo's `.git/info/exclude`, shared by every ticket worktree of that repo, which is why the append is conditional. *(Verified: after the append, `git status` inside the worktree is clean and `git check-ignore -v .env` names that file.)*

`runner.ts` **never imports the store.** It receives an explicit `RunSpec` and a mutable `RunState` and knows nothing about SQLite; the caller decides what to persist. That decoupling is what keeps the spawn path testable and the store swappable.

## 8. Per-run state that is not persisted

`runs: Map<string, RunState>` holds `diagnostics`, `sessionDir` and `stream` — the live event-subscription handle. `inFlight: Set<string>` holds ticket ids with an operation running right now. Both live only for the process.

Losing them on restart is **correct**. Diagnostics describe one attempt at starting an agent — debugging output, not ticket state. The event stream is a live socket that could not survive a restart anyway, and reconciliation, not the stream, is the safety net. `inFlight` describes in-process work that by definition ended when the process did.

The consequence is load-bearing: Herdr keeps panes and agents running across a restart of this backend, so afterwards `agent.start` returns `agent_name_taken`, and `runner.ts` treats that as *reuse* — `agent.get` the existing record, set `reusedExistingAgent`, follow the agent's authoritative `pane_id`, and **skip the prompt** so it does not redo work. A backend restart is therefore exactly what makes agent re-attachment reachable today.

At boot, `server.ts` reconciles every `in_progress` ticket per project and **only warns**: it changes nothing, because the only safe automatic repair is resetting a status with no resources behind it, and even that is better surfaced than silently applied. The single exception is `reclaimStalePortSlots()`, which frees blocks held by tickets that are no longer in progress — our own bookkeeping, not the user's work, so reclaiming one cannot lose anything ([reconciliation](./reconciliation.md)).

## 9. Frontend

One self-contained `public/index.html` (1232 lines): inline `<style>`, one `<script type="module">`, no framework, no build step, no bundler. It keeps module-level state (`projects`, `currentProjectId`, `ticketsData`, `editingId`, `editBuffer`, `actionErrors`, `pendingActions`) and reconciles cards in place through a `cardEls` map. A single `api()` helper wraps `fetch` and surfaces every non-2xx through `messageFor(body, status)`, reading exactly the `{error, message}` envelope described under the HTTP surface below.

**It polls.** `setInterval(loadTickets, 1000)` and `setInterval(loadProjects, 5000)`. A failed poll keeps the last-known board on screen and flips a status pill to "poll failing" rather than blanking it. The 1 s poll is a **placeholder**: the backend already learns of `pane.agent_status_changed` the instant it fires, so only the browser is behind. SSE is parked, with a sketch, in [parking-lot](./parking-lot.md). The frontend only *reads* projects (`GET /projects`); project creation and editing are not wired into the UI, though endpoints 2–4 exist.

The attach command is built client-side:

```js
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);
const host = location.hostname;
const prefix = LOOPBACK.has(host) ? "herdr" : `herdr --remote ${host}`;
return `${prefix} agent attach ${ticket.agentName}`;
```

The board is always served *from* the Herdr host, so `location.hostname` is always the right host: open it on the host and you are already there, so a bare `herdr agent attach` is correct and `--remote` would make herdr SSH to itself; open it over the network and that same hostname is the one to pass. Zero configuration, correct from either machine. (`--remote` is a global flag, so it precedes the subcommand.)

## 10. Testing

Two suites, deliberately separate: `npm test` (`node --test 'src/*.test.ts'`) is the pure-unit
layer and needs nothing running, `npm run e2e` (`playwright test`) drives the real HTTP surface
and the real page.

**The unit glob matters and so do the quotes.** `node --test src` does not pick up `.ts` files —
verified: it reports `✖ src (40ms) 'test failed'`. Quote the glob so the shell hands it to Node
rather than expanding it. Current state: **63 tests, 12 suites, 0 failures**, `duration_ms` ≈ 187.

| Target | Why it is tested |
| --- | --- |
| `normalizeEvent` | Herdr emits `pane.agent_status_changed` dotted and `pane_closed` underscored. Matching either literally drops half the stream with **no error attached** — it cost this project its status pipeline once. |
| `isAgentReady` / `isSettled` | `done` and `idle` are the same underlying ready state. Accepting only `idle` broke agent reuse 100% of the time and hung for the full 60 s timeout. `interactive_ready` is the tell for a premature `agent.start` return. |
| `branchFor` / `agentNameFor` | The alignment invariant: branch lowercased with `/`→`-` must equal the agent name. If they drift, reuse, teardown and dispatch break at once. |
| agent-name budget | `ticket-` (7) + separator (1) leaves 24 of the 32-char ceiling; a 20-char slug + 4-digit number lands exactly on 32. That is *why* the slug cap is 20. |
| `validateProjectSlug` | Dots are branch-legal and agent-name-illegal, so a dotted slug fails only at spawn time, after the worktree exists. Also pins that a leading digit is legal — `10x` is this project's own name. |
| `claimTicket` | The only lock in the system: a second click loses, a mismatched `from` loses, an unknown id loses instead of throwing, bystanders are untouched, `updated_at` is bumped only on a win. Runs against a temp DB via `mkdtempSync` and a **dynamic** import, because `db.ts` opens the database at module load and a static import would hoist above the `DB_PATH` assignment. |
| the port pool | A wrong slot hands two live agents the same TCP port, and the symptom is an `EADDRINUSE` inside somebody's worktree rather than an error on the board. Pinned: lowest-free selection, reuse after release, exhaustion at the cap, the block arithmetic including the last slot's upper bound (4199, not 4200), and the cap coming from `MAX_PORT_SLOTS`. The persistence half additionally pins that the UNIQUE index — not the allocator — is what refuses a double assignment. |

The tests deliberately cover the three things that have actually broken — event-name normalisation, the idle-or-done readiness predicate, and the CAS — plus the naming invariants that guard them. Nothing tests plumbing. See [verification](./verification.md) and [gotchas](./gotchas.md).

### The e2e suite

`playwright.config.ts` + `e2e/`. **`workers: 1` is correctness, not speed:** the whole suite shares
one backend, one port and one state dir. `e2e/fixtures.ts` is the contract every spec imports —
`startBoard` (server on **4310**, avoiding 4010 and the 41xx dev-server band, readiness polled on
`GET /projects`), `makeRepo`, `cleanupAll`, `requireHerdr`, plus the spawn helpers below.

| Spec | Covers | Real agents |
| --- | --- | --- |
| `projects.spec.ts`, `tickets.spec.ts`, `board.spec.ts` | registration, validation, ticket CRUD, rendering | none |
| `spawn.spec.ts` | spawn, prompt delivery via the agent's own `probe.txt`, cancel | 3 |
| `teardown.spec.ts` | ticket delete, worktree-only delete (branch survives) | 2 |
| `resilience.spec.ts` | backend restart, compare-and-swap, two concurrent tickets | 4 |
| `ports.spec.ts` | `.env` written and git-excluded, pool exhaustion → 409, slot reused after cancel | 3 |

**A spawn spec runs a real OMP agent, so teardown is the load-bearing part.** Every spawn is
registered with `cleanupAll` *before* its request goes out, each test tears its own spawn down at
the end, and `cleanupAll` falls back to `worktree.open`+`worktree.remove` straight at Herdr when
the backend is gone. Per-test budgets are set with `test.setTimeout`: **120 s** spawn-only,
**180 s** spawn-plus-completion, **240 s** for the two serial spawns in `ports.spec.ts`; the
config's 30 s default stays for the non-spawn specs. Measured: spawn returns in **3.5–3.9 s** and
the probe turn finishes **7–12 s** after that, so the whole suite of 21 tests runs in
**~1.4 minutes** against the 600 s `globalTimeout`.

Three things the suite reads outside the HTTP API, each for a reason:

- **`storedTicket`** opens the SQLite file, because `board()` derives `branch` and `agentName` when
  the columns are null — so the API reports them either way and cannot show teardown clearing them.
- **`liveAgentNames` / `liveWorktreeBranches`** ask Herdr directly, so "no agent, no worktree" is
  asserted against the source of truth rather than against our own join.
- **`restartBoard`** starts a second backend on the *same* state dir. `startBoard` would hand out a
  fresh empty database and prove nothing about a restart.

`cleanupAll` also closes each throwaway repo's implicit Herdr **source workspace** and `rmdir`s
`~/.herdr/worktrees/<repo>/`: both outlive the last ticket worktree, and each e2e run would
otherwise leave one of each behind ([reconciliation](./reconciliation.md)).

**Repos are created on `dev`, and specs pass `baseBranch: "dev"` explicitly.** `baseBranch` defaults
to `main` and is only handed to git at `worktree.create` time, so registering a project whose base
branch does not exist succeeds and fails at spawn instead. *(Verified.)*

**Herdr absent is survivable for reads and fatal for teardown.** *(Verified with
`HERDR_SOCKET_PATH` pointed at a nonexistent socket.)* The server boots, `GET /projects` and
`GET /tickets` both answer 200, and boot reconciliation only warns — every Herdr read is wrapped
and degrades. But `teardown` rethrows any `worktree.open` failure that is not `worktree_not_found`,
so `DELETE /tickets/:id` answers **500 `socket_error`**. That is why `requireHerdr` exists: without
the preflight the failure reads as a mystery, not as a missing dependency.

**UI assertions use accessible semantics only** — a redesign is planned. Two consequences: the
`<header>` is the `banner` landmark, and scoping to it is what separates the board's project
combobox from the composer's identically labelled one; and the column headings carry their live
count inside their accessible name (`"Backlog 1"`), which is the only semantic way to say a ticket
is in Backlog rather than In Progress, because the columns themselves are unlabelled `div`s.

**The one exception is locating a single card**, which the spawn specs need in order to say "*this*
ticket shows the finished badge". A card is an unlabelled `div` with no accessible handle at all, so
they scope by `#in-progress-cards [data-id="<ticket id>"]` and then assert inside it with
`getByTitle` — the badges' `title` is accessible, the container is not. Do not widen this into
asserting on classes or text layout.
