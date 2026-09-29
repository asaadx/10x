# Testing

**Node:** testing · Parent: [INDEX.md](./INDEX.md)

The two suites 10x has and what each one is for. **Neither starts a real agent or spends
money**: every server under test runs with `CLOUD_DRIVER=fake` ([cloud](./cloud.md)). What is
being tested is described in [architecture](./architecture.md); how to reproduce a claim by hand
is in [verification](./verification.md).

## 1. Two suites, three commands

`pnpm test` (`pnpm -r test` → `node --test 'src/*.test.ts'` in `backend/`) is the unit and
route layer and needs nothing running. Playwright drives the real HTTP surface and the real page,
split into **two projects, not one filtered run**: `pnpm e2e` (`pnpm build && playwright test
--project=fast`) and `pnpm e2e:full` (`--project=full`, every `*.spec.ts`).

**`fast` is an allow-list, and that stays the point** (`playwright.config.ts`). Today it names
every spec — `projects`, `tickets`, `board`, `spawn`, `reject`, `preview` — because the board runs
with the fake driver, so `fast` and `full` run the same thing. It is kept an allow-list so that a
spec added later which needs a **real** cloud session cannot run (and spend) under the default
`pnpm e2e` unless someone deliberately lists it.

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test` only.

## 2. The unit suite

**The glob matters and so do the quotes.** `node --test src` does not pick up `.ts` files; quote
the glob so the shell hands it to Node. Current state: **296 tests, 69 suites, 0 failures**,
`duration_ms` ≈ 15 000 *(verified on this branch)* — the route suites start real server
children and wait on the fake agent and the poller.

**Route tests run the real server as a child process** (`backend/src/test-server.ts`): `server.ts`
is a script that migrates, listens, starts the poller and installs signal handlers at load, so it
cannot be imported. GitHub is faked by `github-fetch-shim.ts`, loaded with `node --import`, which
redirects `https://api.github.com/…` to a local HTTP server queued one response at a time — so
`github.ts` keeps its hardcoded base and needs no test mode. The child's cloud driver is the fake;
`FAKE_CLOUD_LOG` is how the test reads what the child "sent" to `claude`, and
`FAKE_CLOUD_FAIL=start,send` makes those calls throw.

**A test that must see "no token" passes `GITHUB_TOKEN: ""`, never omits it** — `env.ts` loads
the repo-root `.env` into the child, and `loadEnvFile` only skips a variable already present
(`server-pr-no-token.test.ts` header).

**DB tests use a dynamic import** after setting `DB_PATH` to a temp dir: a static import would
hoist above the assignment and `db.ts` would read the default path.

| File | Tests | What it pins, and why |
| --- | --- | --- |
| `cloud.test.ts` | 26 | `parseSessionUrl` (first match anywhere, both id shapes), `parseSendResult` (only `ok: true` is success), the `cli` driver against a stand-in `claude` script (argv, cwd, stdout/stderr tails on failure), `CLOUD_DRIVER` refusing an unknown value, empty env values meaning unset, and the fake driver's agent playback through a real `Sql` |
| `cloud-routes.test.ts` | 13 | spawn, plan (including reuse), reject, cancel and delete against a server child with `FAKE_AGENT_MS`; the poller moving `done` to review; the board read carrying nothing of the old local-agent shape; the removed routes answering 404 |
| `cloud-routes-failure.test.ts` | 4 | the hand-backs: a failed start leaves the ticket in To Do with no session; a failed Reject send restores In Review and the agent's own state |
| `poller.test.ts` | 3 | ticks never overlap, a failing tick does not stop the loop, `stop()` waits for the tick in flight |
| `preview.test.ts` | 5 | against a bare-repo upstream and a real listening dev command: the pushed branch is fetched and checked out, the command answers on the ticket's port, DELETE and shutdown leave nothing listening |
| `prompts.test.ts` | 12 | substitution and both throws, both real prompt files rendering, the opening message's id line, user `{{text}}` not tripping the check, and **every agent UPDATE scoped `WHERE id = ? AND run_token = ?`** |
| `sql.test.ts` | 14 | one contract against **both** drivers (Turso via `scripts/fake-turso.ts`): batch atomicity, CAS row count, integer round-trip, `RETURNING` |
| `db.test.ts` | 32 | `claimTicket` — the only lock: a second click loses, a mismatched `from` loses, an unknown id loses instead of throwing, bystanders are untouched — on every edge the routes take; `toStatus`; `setPullRequest` / `setPullRequestState`. **`claimTicketWith`, `settleFinishedAgents` and `toAgentState` have no direct unit test**; they are exercised only through the route suites |
| `ticket-store.test.ts` | 23 | `setRunFields`, the plan fields `updateTicket` owns, the `IMMUTABLE` list |
| `transitions.test.ts` | 13 | the table's refusals — `illegal_transition` versus `transition_has_side_effects` naming its owner — that `done` is terminal, and a compile-time assertion that its restated `Status` has not drifted |
| `ports.test.ts` / `port-slots.test.ts` | 9 / 8 | lowest-free selection, reuse after release, exhaustion at the cap, the last slot's upper bound; that the UNIQUE index — not the allocator — refuses a double assignment; the boot release |
| `server-pr.test.ts` / `server-pr-no-token.test.ts` | 6 / 1 | Accept marking a draft ready or opening a PR from the branch with no local push, the hand-back on failure; the poller's PR reconcile and its TTL; `missing_github_token` |
| `archive.test.ts` | 5 | Done-only, the fail-closed PR guard, archived tickets leaving every list read |
| `github.test.ts` | 38 | PR body, token redaction, webhook narrowing (**closed-but-unmerged → `closed`**, not `merged`), `markPullRequestReady` |
| `project-routes.test.ts`, `provision.test.ts`, `project-migration.test.ts`, `priority-migration.test.ts` | 18, 14, 5, 1 | the project admission test and immutability, cloning and seeding against real bare repos, and the migrations |
| `lifecycle.test.ts` | 5 | the slug rule and its derivation ([naming](./naming.md)) |
| `env.test.ts` | 1 | the `./env.ts` import stays first in `server.ts` — the failure is otherwise silent ([architecture](./architecture.md)) |

*(Test counts are `test(` occurrences per file; the suite total is from a run.)*

## 3. The e2e suite

`playwright.config.ts` + `e2e/`. **`workers: 1` is correctness, not speed:** every spec binds one
TCP port (4310) and one Preview port range. `e2e/fixtures.ts` is the contract every spec imports.

`startBoard()` spawns `node backend/src/server.ts` from the repo root on a throwaway `STATE_DIR`
with, explicitly (because `.env` never overrides a variable already set):

| Variable | Value | Why |
| --- | --- | --- |
| `CLOUD_DRIVER` | `fake` | no real `claude`, no spend |
| `FAKE_AGENT_MS` | `600` | the fake writes `working` at 0.6 s and `done` at 1.2 s |
| `AGENT_POLL_MS` | `200` | the move to review lands quickly |
| `TURSO_DATABASE_URL` | `""` | the local SQLite file in the temp dir, never the real store |
| `GITHUB_TOKEN` | `""` | never the real GitHub |
| `PORT_BLOCK_BASE` | `4700` | Previews stay clear of a real board's 4100 pool |

Other helpers: `restartBoard` (a second server on the **same** state dir — what a restart is),
`makeRepo` (a local clone on `dev` with a bare `origin`), `pushAgentBranch` (what a cloud agent
does before `done`), `createProject` (**seeded straight into SQLite**, already `ready`, because
`POST /projects` would clone from GitHub; that route is covered by `project-routes.test.ts`),
`spawnTicket`, `waitForTicket` (polls the API, never sleeps), `storedTicket` (reads the row
without trusting the API), and `cleanupAll`.

| Spec | Tests | Covers |
| --- | --- | --- |
| `projects.spec.ts` | 5 | registration from a remote alone, slug / repo / duplicate validation |
| `tickets.spec.ts` | 4 | ticket CRUD and monotonic numbering across a delete |
| `board.spec.ts` | 10 | the five columns and their order, per-column buttons, picking up a ticket via the poll, the static asset route and SPA fallback |
| `spawn.spec.ts` | 3 | Start opens a session, the fake agent's `done` moves the card to In Review, a second Start is refused, cancel clears the session |
| `reject.spec.ts` | 2 | Reject sends the reason into the same session and the ticket comes back to review; empty reason → 400 |
| `preview.spec.ts` | 1 | Preview runs the agent's pushed branch locally, and stopping it frees the port |

**25 tests** *(counted from `test(` calls; not run in this session — the container has no
Playwright browser)*. `pnpm e2e` builds the frontend first, binds **4310**, and is otherwise free
to run.

**What a UI spec may assert** — accessible semantics only — is part of the frontend's contract, in
[frontend](./frontend.md).
