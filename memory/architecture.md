# Architecture

**Node:** architecture · Parent: [INDEX.md](./INDEX.md)

How the 10x **server** itself is built: the module map, the storage model, the schema, the HTTP
surface and the spawn lifecycle. Read this first to orient. Its two siblings are
[frontend](./frontend.md) (everything under `frontend/`) and [testing](./testing.md) (both suites).
How a ticket's cloud session runs — the CLI calls, the agent ↔ board protocol, the poller, Preview
— is [cloud](./cloud.md).

## 1. Runtime and dependencies

| Fact | Value |
| --- | --- |
| Runtime | Node **24** (`engines.node: ">=24"`); verified on `v24.19.0` |
| Language | TypeScript executed directly — `node backend/src/server.ts`, no build step |
| Runtime dependencies | **zero**; `backend/package.json` has no `dependencies` key at all |
| devDependencies | `typescript`, `@types/node` for `tsc --noEmit`, plus `@playwright/test` for the e2e suite — all at the workspace root, none in `backend/`. No runtime dependency, ever. |
| Built-ins used | `node:sqlite`, global `fetch` (the Turso driver and GitHub), `node:http`, `node:crypto` (`randomUUID` for run tokens), `node:test`, `node:fs`, `node:child_process` (`claude`, `git`, a Preview's dev command), `node:timers/promises` |
| tsconfig | `module`/`moduleResolution: nodenext`, `allowImportingTsExtensions`, `noEmit`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `target ES2023`; `include` covers `backend/src/`, `e2e/` and `playwright.config.ts` |

Imports carry the `.ts` extension (`./db.ts`): Node resolves the real file, and `allowImportingTsExtensions` makes `tsc` agree.

**The zero-dependency property is a constraint, not an accident.** SQLite, the test runner and the HTTP server are all standard library. Adding a runtime dependency is a decision to be argued for, not a detail to be slipped in.

### The repository is two pnpm workspaces

`backend/` and `frontend/` each own a `package.json`; the root one holds no application
dependencies and exists to list the packages, carry the shared dev tooling and run the scripts CI
calls. `pnpm-workspace.yaml` names the two explicitly rather than globbing `apps/*` — that
convention earns its keep beside a `packages/` directory and there is none.

**`e2e/` is deliberately not a workspace.** It spawns the backend *and* drives the frontend, so it
belongs to neither and sits at the root with the tooling that runs it.

Two reasons the split exists, both load-bearing:

- **The zero-dependency claim stays checkable.** A single manifest would have put React, Vite and
  Tailwind in the same tree as the server. Separating them keeps `backend/package.json` a manifest
  you can read and see is empty. Nothing enforces that in CI — it rests on pnpm's resolution and on
  not adding one.
- **pnpm, not npm.** pnpm **does not hoist**, so a package cannot import what it has not
  declared — the isolation is enforced by resolution, not by folder discipline. Its
  content-addressable store also makes a second checkout of the same repo (a Preview) cheap to
  install *(inferred; not measured)*.

`packageManager` in the root manifest pins the pnpm version, so CI, cloud sessions and every local
checkout use the same one.

### Type stripping limits how code is written

Node runs `.ts` in **strip-only mode**: types are erased, nothing is transformed. Syntax needing emit is a hard `SyntaxError` at load. Verified by running both on `v24.19.0`:

```
class A { constructor(readonly x: number) {} }
  SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
enum E { A }
  SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
```

So: no constructor parameter properties, no `enum`. `GitHubApiError` in `backend/src/github.ts` is written the long way for exactly this reason — `readonly code: string` declared as a field, then assigned in the constructor body. Status is a **union type** (`"backlog" | "todo" | "in_progress" | "in_review" | "done"`), never an enum.

`tsconfig.json` sets `erasableSyntaxOnly`, so `pnpm typecheck` rejects a parameter property or an `enum` instead of letting Node discover it at load time. The typechecker is the guard, not convention.

### The backend loads `.env` itself

`backend/src/env.ts` calls `process.loadEnvFile` on the **repo-root `.env`** and is the **first import in `server.ts`**. There is no `--env-file` flag on any script, so there is none to forget: plain `node backend/src/server.ts` — and `pnpm dev:api`, whose `dev` script never passed one — sees the file. It is a bare side-effect import rather than a `loadEnv()` someone calls, because a call would run after the import block, which is already too late. The path comes from `import.meta.dirname`, never `process.cwd()`: the server is started from the repo root (e2e, the route tests' `test-server.ts`, every real run) and from `backend/` (`pnpm dev:api`). Three properties of `loadEnvFile`, all verified on `v24.19.0`, shape the module:

- **It does not override a variable already in the environment** — so the unit suite and `e2e/fixtures.ts` keep winning with the `STATE_DIR`, `DB_PATH` and `PORT` they pass, while `.env` still supplies `GITHUB_TOKEN`. *(Verified end to end: a `.env` setting `STATE_DIR` did not displace one passed to the child, and no directory was created at the file's path.)*
- **Every failed open is reported as `ENOENT`, `EACCES` included** — a `.env` with mode `000` throws `ENOENT` where `readFileSync` throws `EACCES`. So the error code alone cannot distinguish "no `.env`" from "a `.env` we may not read", and `existsSync` decides: absent is swallowed (a fresh clone and CI have none, and both must boot), present-but-unopenable throws with its own message rather than Node's misleading "no such file". *(Verified: mode `000` → exit 1 at boot; file removed → boots with `GITHUB_TOKEN` unset.)*
- **Import order is load-bearing and its failure is silent.** `db.ts` reads `STATE_DIR`, `DB_PATH` and `TURSO_DATABASE_URL` at module load to pick its driver and file (it opens nothing until the first query), and `ports.ts` reads its pool configuration at load too, so an `./env.ts` moved below either reads the defaults — opening `~/.10x/10x.db` instead of the configured file, with no error at all. `env.test.ts` reads `server.ts` and fails unless that import is the first one; the guard is a **test** because this repo has no linter and nothing else would notice a human tidying the imports. *(Verified falsifiable: moving the import below the `db.ts` one reddens that test.)*

A malformed line is **not** an error to `loadEnvFile`: a line with no `=`, or a stray `NUL`, is skipped, and `A="unterminated` yields the literal `"unterminated`. Nothing in the code can catch that, so `.env.example` is the only guard against a typo.

The unit suite never imports `env.ts` — only `server.ts` does — so `pnpm test` still runs with no `.env` loaded and cannot drift onto the real `~/.10x/10x.db`.

## 2. Module map

Line counts are `wc -l`, current as of this node. Tests are listed in [testing](./testing.md).

| File | Lines | Responsibility | I/O |
| --- | --- | --- | --- |
| `backend/src/server.ts` | 1112 | HTTP routing, the static asset route, the poller's tick (`pollTick`: settle `done` agents, then reconcile PR state), per-process state (`inFlight`, `provisioning`, `prLastChecked`), boot cleanup, signal handling | `node:http`, everything below |
| `backend/src/db.ts` | 628 | Schema + `initDb()` migration, the `db` client, row types, the status / PR-state / agent-state / session-kind parse boundaries, `claimTicket` / `claimTicketWith` CAS, `settleFinishedAgents`, port-slot reserve/release, `setPullRequest`, `setPullRequestState` — all async | `Sql` (nothing at import) |
| `backend/src/ticket-store.ts` | 470 | Ticket persistence + `/tickets` handler bodies, input narrowing, the `IMMUTABLE` PATCH list, `setRunFields` (the lifecycle writer) | `Sql` |
| `backend/src/projects.ts` | 426 | Project CRUD, remote normalisation, slug / name / base-branch / dev-command validation, `setProvisionState` | `Sql` |
| `backend/src/github.ts` | 391 | `markPullRequestReady`, `openPullRequest` (adopts on 422), `fetchPullRequestSnapshot`, `needsLiveCheck`, `pullRequestUpdate`, `fetchRepoMetadata`; token redaction on every error path. `pushTicketBranch` is still exported but nothing calls it | `fetch`, `git` via `execFile` |
| `backend/src/cloud.ts` | 286 | **The only module that knows `claude` exists.** `CloudDriver` (`startSession`, `sendMessage`), the `cli` and `fake` drivers, stdout parsing ([cloud](./cloud.md)) | `claude` via `execFile`; `Sql` (fake only) |
| `backend/src/sql.ts` | 275 | The async `Sql` client: Turso (Hrana-over-HTTP via `fetch`) and local `node:sqlite` drivers, chosen by `TURSO_DATABASE_URL` | `fetch` or SQLite |
| `backend/src/types.ts` | 264 | **Import-free.** The shared vocabulary: `Ticket`, `BoardTicket`, `Preview`, `Project`; re-exported to the frontend | none |
| `backend/src/preview.ts` | 232 | Local Preview: fetch the agent's branch into `refs/10x/preview/<id>`, detached worktree, `.env`, dev command in its own process group; stop, boot sweep ([cloud](./cloud.md)) | `git` via `execFile`, `sh`, fs |
| `backend/src/provision.ts` | 219 | Clone a project into `$PROJECTS_ROOT/<id>`; `remoteHasCommits` (`git ls-remote`) and seeding an empty repo ([gotchas](./gotchas.md)) | `git` via `execFile` |
| `backend/src/transitions.ts` | 135 | **Pure, import-free.** The legal-transitions table: every edge, and whether it is a pure status write or belongs to a route | none |
| `backend/src/prompts.ts` | 131 | Read a prompt out of `prompts/`, substitute its `{{markers}}`; `ticketBlock`, `sessionMessage`, `sessionBranchFor` | fs (read only) |
| `backend/src/ports.ts` | 97 | **Pure.** Port-slot pool for Previews: cap, block arithmetic, `.env` body | none |
| `backend/src/lifecycle.ts` | 68 | **Pure.** The project slug rule and its derivation from a repo name ([naming](./naming.md)) | none |
| `backend/src/env.ts` | 43 | Loads the repo-root `.env` via `process.loadEnvFile`; the first import in `server.ts` | fs (one read) |
| `backend/src/poller.ts` | 42 | `startPoller`: a self-scheduling loop that never overlaps itself | timers |
| `backend/src/git.ts` | 39 | `excludeFromGit` — append to a checkout's shared `info/exclude`, idempotently | `git` via `execFile`, fs |
| `scripts/fake-turso.ts` | 145 | Just enough Hrana-over-HTTP on `node:sqlite` to run the Turso driver offline; not a production path | `node:http`, SQLite |
| `prompts/implementation.md`, `prompts/plan.md` | — | The agents' instructions, sent in the opening message | — |
| `frontend/` | — | The board's browser half — see [frontend](./frontend.md) | `fetch` |

`lifecycle.ts`, `ports.ts`, `transitions.ts` and `types.ts` are import-free deliberately: they hold
logic that would break silently, so it must be testable without a database. A port collision
surfaces as an `EADDRINUSE` inside a Preview's dev server, never as an error on the board, which is
exactly why the allocation policy lives apart from the SQL that stores it.

**A new ticket column has to be added in two mappers, not one.** `db.ts` `toTicket` maps a
`TicketRow`, and `ticket-store.ts` `decode` builds that `TicketRow` field-by-field from a raw row —
and `decode` feeds every production read (`listTickets`, `getTicket`). `SELECT *` picks a new
column up automatically, but `decode` does not, so extending only `db.ts` leaves the field
permanently `undefined` at runtime. **Typecheck catches it** (`toTicket`'s argument is missing
properties), which is why this is a wart rather than a trap — but budget the second edit. A column
the API must never expose (`run_token`) is simply left out of both.

## 3. Stored vs derived — the load-bearing idea

**Everything about an agent is stored; nothing is derived at read time.** A cloud session's status
cannot be read from anywhere, so the row is the whole truth ([cloud](./cloud.md)):

| Value | Written by | Why stored |
| --- | --- | --- |
| `session_id`, `session_url`, `session_kind`, `run_token` | the board, at Start / Plan | the only record of which session owns the ticket, and the scope every agent write must match |
| `agent_state`, `agent_note`, `agent_updated_at` | the agent (the board writes only `starting`, and clears) | the only signal the board has |
| `branch`, `pr_number`, `pr_url` | the agent (Accept writes the PR pair when it has to open the PR itself) | the branch the agent **actually** pushed and the PR it opened |
| `pr_state`, `pr_additions`, `pr_deletions` | the webhook, the poller's reconcile, the live guards | GitHub pushes none of this reliably ([github](./github.md)) |
| a ticket's Preview | **never stored** — `preview.ts` memory | a process handle cannot outlive the process; a restart sweeps every checkout |
| `busy` | **never stored** — `inFlight` | in-process work ends with the process |

`GET /tickets` is therefore **a pure database read** plus the two process-local fields (`busy`,
`preview`). There is no second source of truth to join against; the board is at worst one frontend
poll (1 s) behind the last agent write.

## 4. Database schema

Every query goes through the async `Sql` client in `backend/src/sql.ts` (`execute` + an atomic
`batch`), which has two drivers and no dependencies:

- **Turso** when `TURSO_DATABASE_URL` is set (`libsql://` rewritten to `https://`, bearer
  `TURSO_AUTH_TOKEN`), over Hrana-over-HTTP `POST /v2/pipeline` with plain `fetch`. `execute` is
  one pipeline `execute` + `close`. `batch` is **one** pipeline `batch` request: `BEGIN IMMEDIATE`,
  each statement conditioned on `ok` of the previous step, `COMMIT` on `ok` of the last, and
  `ROLLBACK` on `not ok(COMMIT)` — never BEGIN/COMMIT as separate requests, where a failed middle
  statement would still let its siblings commit. Integers go over the wire as strings and decode
  to `number`. *(Verified: `sql.test.ts` runs one contract — batch atomicity, CAS row count,
  integer round-trip, RETURNING — against both drivers, the Turso one talking to
  `scripts/fake-turso.ts`; not yet run against real Turso.)*
- **Local** `node:sqlite` at `$DB_PATH` otherwise (defaulting to `$STATE_DIR/10x.db`,
  `STATE_DIR` defaulting to `~/.10x`), opened on **first query**, not at import, with
  `journal_mode = WAL`, `foreign_keys = ON` and `busy_timeout = 5000`. Tests and offline dev only:
  a cloud agent cannot reach a file on this machine, so with the local driver only the fake agent
  can report.

**Nothing migrates at import.** `initDb()` (schema + every `addColumnIfMissing`, idempotent and
memoised) is awaited by `server.ts` before it listens and by each DB test after its dynamic
import. A query before it resolves hits a missing table.

**Foreign keys are not relied on.** `PRAGMA foreign_keys` is per connection and a Hrana request has
no connection to set it on, so `deleteProject` deletes the project's tickets explicitly in the same
batch rather than trusting `ON DELETE CASCADE` *(inferred for real Turso; the fake runs with FKs off
and the delete still sweeps the tickets — verified)*.

`scripts/fake-turso.ts` (`node scripts/fake-turso.ts --port 8080 --db ./x.db`, or
`startFakeTurso()` from a test) is enough Hrana to point the whole board at "Turso" offline:
`TURSO_DATABASE_URL=http://127.0.0.1:8080`. Not a production path.

**`projects`** — `id` TEXT PRIMARY KEY (the immutable slug, first half of every ticket id) · `name` TEXT NOT NULL (display only, freely renameable) · `description` TEXT NOT NULL DEFAULT `''` (the user's note about the project; display only, deliberately NOT sent to agents) · `owner`, `repo` TEXT NOT NULL DEFAULT `''` (**the project's identity**: what every PR call targets, read from a column rather than re-derived from `git remote`) · `repo_path` TEXT NOT NULL (**derived, never supplied**: `$PROJECTS_ROOT/<id>`, which 10x clones itself; `claude --cloud` runs there, and Preview fetches into it) · `base_branch` TEXT NOT NULL DEFAULT `'main'` (the **bare** upstream name: `--ref` for a session and the PR base) · `provision_state` TEXT NOT NULL DEFAULT `'ready'` (`pending|cloning|ready|failed`; the default backfills existing projects as usable) · `provision_error` TEXT NOT NULL DEFAULT `''` (redacted) · `next_number` INTEGER NOT NULL DEFAULT 1 (monotonic ticket counter) · `dev_command` TEXT NOT NULL DEFAULT `''` (what Preview runs in a ticket's checkout with `PORT` set; `''` = start nothing; PATCHable as `devCommand`) · `created_at`, `updated_at` TEXT NOT NULL (ISO instants).

**`tickets`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY | literally `<projectId>-<number>` |
| `project_id` | TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE | the cascade is not relied on (above) |
| `number` | INTEGER NOT NULL | per-project, starts at 1 |
| `title` / `description` | TEXT NOT NULL / NOT NULL DEFAULT `''` | PATCHable; also writable by an agent |
| `status` | TEXT NOT NULL DEFAULT `'backlog'` | `backlog` \| `todo` \| `in_progress` \| `in_review` \| `done`; anything else decodes as `backlog`, in the one `toStatus` parse boundary |
| `finished` | INTEGER NOT NULL DEFAULT 0 | set by the poller in the same statement as the move to `in_review`; cleared by Start, Reject and Cancel |
| `playbook`, `priority` | TEXT NOT NULL DEFAULT `'Fullstack'` / `'low'` | PATCHable |
| `task_breakdown`, `acceptance_criteria`, `attachments` | TEXT NOT NULL DEFAULT `'[]'` | JSON arrays, read and written whole |
| `branch` | TEXT (nullable) | the branch the agent reports it pushed |
| `port_slot` | INTEGER (nullable) | index into the port pool; held **only while a Preview runs** |
| `pr_number`, `pr_url` | INTEGER / TEXT (nullable) | written by the agent when it opens its draft PR, or by `setPullRequest` when Accept opens one |
| `pr_state` | TEXT (nullable) | `open` \| `merged` \| `closed`. Unlike `status`, an unrecognised value decodes to **`null`** in `toPullRequestState`, because "no news about this PR" is a real state |
| `pr_additions`, `pr_deletions` | INTEGER (nullable) | ±LOC, from the webhook payload or the poller's reconcile ([github](./github.md)) |
| `started_at` | TEXT (nullable) | stamped by the Start claim; the card's run timer |
| `session_id`, `session_url`, `session_kind` | TEXT (nullable) | the cloud session working the ticket; written by the board. `session_kind` is `plan` \| `impl`, anything else decodes to `null` |
| `agent_state` | TEXT (nullable) | `starting` (board) then `working` \| `done` \| `blocked` \| `failed`, **written by the agent itself** over Turso's HTTP API. Parsed, not cast, in `toAgentState`: an unrecognised value is `null`, so a typo can never read as `done` |
| `agent_note`, `agent_updated_at` | TEXT (nullable) | the agent's last summary or question, and the ISO instant of its last write |
| `run_token` | TEXT (nullable) | a UUID per session start; every agent write is scoped `WHERE id = ? AND run_token = ?` ([cloud](./cloud.md)). Never on the wire |
| `archived` | INTEGER NOT NULL DEFAULT 0 | hidden from every list read once 1; one-way |
| `agent_name`, `session_dir`, `died`, `screenshot_before`, `screenshot_after` | — | **legacy**, kept for migration safety; nothing writes them except `died = 0` on Start/Cancel. `Ticket` still carries them until the frontend drops them |
| `created_at`, `updated_at` | TEXT NOT NULL | equal ⇒ never edited |
| — | — | **`UNIQUE (project_id, number)`** |

Plus `CREATE INDEX tickets_by_project ON tickets (project_id, status)` and
`CREATE UNIQUE INDEX tickets_port_slot ON tickets (port_slot)`.

`db.ts` migrates an existing database in place: `CREATE TABLE IF NOT EXISTS` leaves it alone, so
`addColumnIfMissing` adds each later column with `ALTER TABLE` when `PRAGMA table_info` says it is
missing. The port-slot uniqueness has to be a separate `CREATE UNIQUE INDEX` because SQLite's
`ADD COLUMN` rejects a UNIQUE constraint.

### The port pool — Previews only

Agents run in the cloud and hold no local port. The pool exists for **Preview**: each running
Preview gets a reserved **block** of TCP ports, so two dev servers cannot collide and neither can
collide with the board. A slot maps to `base + slot * stride` through
`base + slot * stride + stride - 1`: with the defaults slot 0 owns **4100-4109** and slot 9 owns
**4190-4199**, clear of the board on 4010 and the e2e harness on 4310.

| Env var | Default | Meaning |
| --- | --- | --- |
| `MAX_PORT_SLOTS` | `10` | Previews running at once; the 11th is refused with 409 `port_pool_exhausted` |
| `PORT_BLOCK_BASE` | `4100` | first port of slot 0 |
| `PORT_BLOCK_STRIDE` | `10` | ports per slot |

A malformed value throws at load rather than falling back, so a typo cannot masquerade as the
default. **A bounded pool, not `base + ticket.number`**: ticket numbers grow without bound and would
eventually walk into ports other software owns. **A block, not one port**, because a project
running Vite beside an API needs two.

**The UNIQUE index is the safety**, exactly as the conditional UPDATE is for `claimTicket`.
`reservePortSlot` computes the lowest free slot **in SQL** (a recursive CTE over
`[0, MAX_PORT_SLOTS)` minus the held set) inside the same `UPDATE` that writes it, so the read and
the write are one statement — there is no connection over HTTP to hold a `BEGIN IMMEDIATE` on. It
is idempotent (`WHERE port_slot IS NULL`) and an exhausted pool writes nothing.

**Reserved by `POST /tickets/:id/preview`, released by every path that stops one** — `DELETE
/tickets/:id/preview`, a failed Preview start, Cancel, ticket delete and Archive, all from a
`finally` (`server.ts` `endPreview`). **At boot every held slot is released**
(`releaseAllPortSlots`): Previews live in memory, so none survives a restart and any held slot is
residue.

**`next_number` is why ticket numbers are safe.** The next number is claimed by *advancing* the
counter, never by `MAX(number)+1`:

```sql
UPDATE projects SET next_number = next_number + 1 WHERE id = ?;
INSERT INTO tickets (id, project_id, number, …)
  SELECT id || '-' || (next_number - 1), id, next_number - 1, … FROM projects WHERE id = ? RETURNING id;
```

Deleting the highest ticket would otherwise recycle its number, and the new ticket would inherit
the old one's `claude/10x-<id>` branch and PR on GitHub ([naming](./naming.md)). The two statements
are one `batch`, and the insert reads its number back out of the counter rather than from a JS
variable, so neither needs the other's result and two concurrent creates cannot claim the same
number. A missing project is a zero-row insert, which is how `createTicket` answers 404.

## 5. The CAS — status is the lock

```ts
export async function claimTicket(id: string, from: Status, to: Status): Promise<boolean> {
  const res = await db.execute(
    "UPDATE tickets SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
    [to, nowIso(), id, from],
  );
  return res.rowsAffected === 1;
}
```

The conditional `WHERE` *is* the lock, and the row count reports whether the caller won. A second
concurrent request matches nothing and loses. There is no other lock in the system and no queue:
**claim first, work second, and reject rather than queue** so the conflict stays visible instead of
becoming a second paid session. It holds across processes and, against Turso, across machines. See
[operations](./operations.md).

**`claimTicketWith(id, from, to, set)`** is the same claim plus columns that must change **in the
same statement** as the status. Start uses it to reset the session columns and mint the run token,
Reject to reset `agent_state` to `working`, Cancel to clear the session: separate writes would open
a window where the poller sees "in progress and done" and moves the ticket to review.

**Every transition is a claim, including the one no user asked for.** The poller's
`in_progress → in_review` is one conditional UPDATE with `status = 'in_progress'` in its `WHERE`,
which is what makes a ticket seen `done` twice harmless.

`PATCH /tickets/:id` therefore refuses to touch `status`, `number`, `projectId`, `branch`,
`agentName`, `finished`, `died`, `archived`, `sessionDir`, `sessionId`, `sessionUrl`,
`sessionKind`, `agentState`, `agentNote` or `agentUpdatedAt` — naming any of them is a 400
`immutable_field`. An edit that forged `agentState: "done"` would move the ticket to review through
the poller with no agent behind it.

## 6. HTTP surface

`PORT` defaults to `4010`. Every JSON route answers `application/json`; a GET that no route
claimed then falls through to the static handler described below. Router shape
(`backend/src/server.ts` `handle()`):

```ts
if (method === "GET"  && path === "/projects") …
if (method === "GET"  && path.startsWith("/projects/lookup")) …   // before /projects/:id
if (method === "POST" && path === "/projects") …
/^\/projects\/([^/?]+)\/provision$/  POST
/^\/projects\/([^/?]+)$/             PATCH | DELETE
if (method === "GET"  && path.startsWith("/tickets")) … board(?project=)
if (method === "POST" && path === "/tickets") …
if (method === "POST" && path === "/webhooks/github") …
const m = /^\/tickets\/([^/]+)(\/spawn|\/cancel|\/status|\/accept|\/reject|\/plan|\/archive|\/preview)?$/.exec(path);
// PATCH (bare) → then resolve ticket + project → inFlight check → provisioned check for
// spawn/plan/preview → DELETE (bare), plan, status, spawn, cancel, accept, reject, archive,
// POST preview, DELETE preview
```

| # | Method | Path | Returns |
| --- | --- | --- | --- |
| 1 | GET | `/projects` | `Project[]` |
| 2 | GET | `/projects/lookup?remote=<url>` | the **admission test**: `{owner, repo, name, description, defaultBranch, private, empty}`. `empty` comes from `git ls-remote`, never from `defaultBranch` ([gotchas](./gotchas.md)) |
| 3 | POST | `/projects` | `201` the created `Project`, `provisionState: "pending"`. Takes `{remote, name, description?, id?, seedInitialCommit?}`; naming `repoPath` is a 400. The clone runs behind the response |
| 4 | POST | `/projects/:id/provision` | the `Project` after a retry; `409 operation_in_flight` while one is running |
| 5 | PATCH | `/projects/:id` | the updated `Project`; `name`, `description`, `baseBranch`, `devCommand`. Changing `id` is 400 `project_id_immutable`; `repoPath` is 400, and so is `owner`/`repo` unless the project is `failed` |
| 6 | DELETE | `/projects/:id` | `{ok, warnings?}`. **Guarded** by the live PR check (`409 pr_open` / `pr_state_unknown`); then a best-effort cancel message to every running or planning session, every Preview stopped, the rows deleted, and the clone removed if 10x owns it |
| 7 | GET | `/tickets[?project=<id>]` | `{tickets: BoardTicket[]}` — the stored ticket plus `busy` and `preview`. Archived tickets are excluded |
| 8 | POST | `/tickets` | `201` the created `Ticket` |
| 9 | PATCH | `/tickets/:id` | the updated `Ticket` (`title`, `description`, `playbook`, `priority`, `taskBreakdown`, `acceptanceCriteria` — each checklist a **full-array replace**); `400 immutable_field` |
| 10 | DELETE | `/tickets/:id` | `{ok}`. **Guarded** by the live PR check; tells a running or planning session to stop (best effort), stops its Preview |
| 11 | POST | `/tickets/:id/plan` | `{ok, reused, sessionId, sessionUrl}`; `409 not_in_backlog`, `502 session_start_failed` |
| 12 | POST | `/tickets/:id/status` | `{to}` in, the updated `Ticket` out. **Pure status writes only**, validated against `transitions.ts`: `400 invalid_input`, `409 illegal_transition`, `409 transition_has_side_effects` (carrying `owner`), `409 not_in_status` ([operations](./operations.md)) |
| 13 | POST | `/tickets/:id/spawn` | `{ok, sessionId, sessionUrl}`; `409 not_in_todo`, `502 session_start_failed` (claim handed back) |
| 14 | POST | `/tickets/:id/cancel` | `{ok, messaged}`; `409 not_in_progress` |
| 15 | POST | `/tickets/:id/accept` | the updated `Ticket` with `prNumber`/`prUrl`; `409 no_branch` / `not_in_review`, `500 missing_github_token`, `502` on a GitHub failure (claim handed back) |
| 16 | POST | `/tickets/:id/reject` | `{reason}` in, the updated `Ticket` out; `400 reason_required`, `409 no_session` / `not_in_review` / `prompt_failed` |
| 17 | POST | `/tickets/:id/archive` | the updated `Ticket`; `409 not_done`, `409 pr_state_unknown` with no recorded PR, plus the live PR guard |
| 18 | POST | `/tickets/:id/preview` | `{path, port, url, command, running}`; `409 no_branch` / `port_pool_exhausted`, `500 preview_failed` |
| 19 | DELETE | `/tickets/:id/preview` | `{ok, stopped}` |
| 20 | POST | `/webhooks/github` | `{ok:true, matched}` when a ticket owns that `pr_url`, `{ok:true, ignored:true}` otherwise. **Always 2xx**, unauthenticated by decision ([github](./github.md)) |
| — | GET | `/`, any allow-listed asset, or any of `SPA_ROUTES` | the board's static build, or the app shell for a client-side route |

`/plan`, `/spawn` and `/preview` (POST) also answer **409 `project_not_provisioned`** before any
claim while the project's clone is not `ready`: all three need the clone on disk.

**Naming and shape decisions.** The spawn endpoint is canonically **`/spawn`** (the button says
Start; `/start` must not be introduced). `spawn`, `cancel`, `accept` and `reject` are **separate
endpoints** because each is an irreversible act with its own side effects. `/status` is the one
endpoint that takes a target state, and it is safe precisely because it refuses every move those
routes own. **Steer has no route**: it is a link to `session_url`.

**Errors.** Uniform envelope everywhere: `{error, field?, message?}` plus context keys (`id`,
`projectId`, `status`, `path`).

| Status | Meaning | Examples |
| --- | --- | --- |
| 409 | lost CAS, an illegal or misrouted transition, an operation already in flight, a missing precondition, or no resource left | `not_in_todo`, `not_in_progress`, `not_in_review`, `not_in_status`, `not_in_backlog`, `illegal_transition`, `transition_has_side_effects`, `operation_in_flight`, `project_exists`, `port_pool_exhausted`, `project_not_provisioned`, `github_token_missing`, `pr_open`, `pr_state_unknown`, `no_branch`, `no_session`, `prompt_failed`, `not_done` |
| 404 | unknown ticket, project, route, or GitHub repo | `no_such_ticket`, `no_such_project`, `project_not_found`, `not_found`, `repo_not_found` |
| 400 | validation / immutability | `invalid_input`, `immutable_field`, `invalid_project_slug`, `invalid_name`, `invalid_remote`, `invalid_description`, `invalid_base_branch`, `invalid_body`, `project_id_immutable`, `reason_required` |
| 403 | the token cannot see the repo | `repo_not_accessible` |
| 502 | a dependency refused: the `claude` CLI or GitHub | `session_start_failed`, `github_unavailable`, a failed Accept |
| 500 | anything else | `missing_github_token`, `preview_failed`, `{error: <message>}` |

One quirk: `GET` is matched by `path.startsWith("/tickets")` *before* the `/tickets/:id` regex, so
`GET /tickets/anything` returns the whole board — there is no single-ticket GET.

### The static asset route

**The server serves the frontend's build (`frontend/dist`) as static files.** Resolution runs
*after* the API router has declined and only for a GET, so a wrong path under `/tickets` stays a
JSON 404 instead of becoming a probe of the filesystem. Every step fails closed: an extension
outside the allow-list (`CONTENT_TYPES`: `.html .css .js .svg .woff2 .ico .png`) is refused rather
than guessed, a malformed `%`-escape or an embedded NUL is not treated as a path, containment is
checked on the **realpath** so a symlink inside `dist` pointing outside it is refused, and anything
that is not a regular file — a directory included — is refused too. *(Verified: traversal,
percent-encoded traversal, a symlink to `/etc/passwd`, a symlink to `../package.json`, a directory,
a NUL byte and a malformed escape all answer the JSON 404; `e2e/board.spec.ts` pins the route.)*

**The SPA fallback.** `SPA_ROUTES` (`server.ts`) is a fixed allow-list — `/board`, `/dashboard`,
`/playbooks`, `/list` — matched only after both the API router and `resolvePublicAsset` have
declined. A hard refresh on one of these gets `index.html` at 200, and React Router reads the URL
client-side. A named list, not "any GET with no extension": `/js` (a directory, no extension) must
keep 404ing.

With no `frontend/dist` the server still boots and warns once: the API works without a UI.

## 7. Request lifecycle for a spawn

`POST /tickets/:id/spawn`, end to end:

1. `resolve(id)` loads the ticket **and** its project; either missing is a 404.
2. `inFlight.has(id)` → 409 `operation_in_flight`.
3. `project.provisionState !== "ready"` → 409 `project_not_provisioned`, before any claim.
4. A fresh `runToken = randomUUID()`, then `claimTicketWith(id, "todo", "in_progress", {…CLEARED_SESSION, run_token, session_kind: "impl", agent_state: "starting", finished: 0, died: 0, started_at})`
   — a lost claim is 409 `not_in_todo`. The session columns change in the same statement as the
   status ([above](#5-the-cas--status-is-the-lock)).
5. `inFlight.add(id)`.
6. `sessionMessage("impl", ticket, project, runToken)` — the ticket block plus the rendered
   `prompts/implementation.md` ([cloud](./cloud.md)). The project's own `description` is
   deliberately not in it: it is the user's note for the board.
7. `cloud.startSession({cwd: project.repoPath, baseBranch: project.baseBranch, message, title})`
   runs `claude --cloud <message> --ref <base>` in the project's clone and waits for the session
   URL (up to `CLOUD_TIMEOUT_MS`, default 180 s).
8. On success `setRunFields(id, {sessionId, sessionUrl})` — **only** those two, because the agent
   may already have written `working`. Answers `{ok, sessionId, sessionUrl}`.
9. On throw, `claimTicketWith(id, "in_progress", "todo", {…CLEARED_SESSION, started_at: null})`
   hands the claim back and the answer is 502 `session_start_failed` carrying the CLI's stdout and
   stderr tails.
10. `finally` clears `inFlight`.

From then on nothing on this machine runs for the ticket until the poller sees `done`. **No
worktree, no port slot, no local process** — those belong to Preview only.

### Agent prompts live in `prompts/`, not in code

`prompts/implementation.md` and `prompts/plan.md` are prose a human edits, so they sit at the repo
root beside `memory/` rather than inside `backend/src/`. `prompts.ts` resolves them from
**`import.meta.dirname`**, exactly as `server.ts` resolves `frontend/dist` — a
`process.cwd()`-relative path would work under `pnpm --filter @10x/backend dev` and break when the
server is started from the repo root, which is how e2e and every real run start it.

**There is no backend build.** `pnpm build` is only `pnpm --filter @10x/frontend build`; the
backend is always `node backend/src/server.ts`, so nothing relocates or rewrites these files, and a
fresh clone has the prompts.

`renderPrompt` **throws on a leftover `{{marker}}` and on a supplied key that matches no marker**,
because that failure is otherwise invisible: a prompt still reading `{{runToken}}` is a valid file
and a deliverable message, and the only reader that would notice is the agent — whose writes would
then all match zero rows. The leftover scan is deliberately laxer (`{{[^}]*}}`) than the
substitution pattern (`{{\w+}}`), so a marker mistyped into a shape no caller can pass is reported
rather than shipped. The ticket itself is concatenated, not substituted, so a user's own `{{…}}`
text never trips it.

## 8. Per-process state that is not persisted

- `inFlight: Set<string>` — ticket ids with an operation running right now; a second request on
  the same ticket answers 409 rather than queueing.
- `provisioning: Set<string>` — projects whose clone is running.
- `prLastChecked: Map<string, number>` — the poller's per-ticket PR reconcile TTL.
- `previews` (in `preview.ts`) — each running Preview's checkout path, port and dev-command child.

Losing them on restart is **correct**: each describes in-process work that by definition ended
when the process did. At boot `server.ts` releases every held port slot and sweeps
`$STATE_DIR/previews/` (plus `git worktree prune` in each clone), so nothing a crashed process left
is trusted. **Nothing about an agent is lost** — it all lives in the row — and a cloud session keeps
running across a board restart; the next poll after boot picks up whatever it wrote meanwhile.
On SIGTERM/SIGINT the board stops the poller and every Preview's process group before exiting.
