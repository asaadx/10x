# Cloud sessions: how a ticket runs

**Node:** cloud · Parent: [INDEX.md](./INDEX.md)

How a ticket gets from a click to a pull request now that agents are **Claude Code cloud
sessions** and the store is a database both sides can reach. The design and its reasoning are in
[`docs/prototype-cloud.md`](../docs/prototype-cloud.md); this node is the mechanism as the code
has it. The state machine the routes enforce is in [operations](./operations.md), the HTTP table
in [architecture](./architecture.md).

> **Provenance.** Everything marked *verified* is pinned by the unit suite
> (`cloud.test.ts`, `cloud-routes.test.ts`, `cloud-routes-failure.test.ts`, `poller.test.ts`,
> `preview.test.ts`, `prompts.test.ts`, `sql.test.ts`, `server-pr.test.ts` — 296 tests green on
> this branch) or read directly from the file cited. **The real `claude` CLI and real Turso have
> not been exercised** — the flags are from Anthropic's docs, and the Turso driver has only
> talked to `scripts/fake-turso.ts`. Those claims are marked *inferred*.

## The one constraint everything follows from

**Nothing can read a cloud session's status, and nothing can stop or archive one** — there is no
CLI or API for either (`backend/src/cloud.ts` header). So:

- the board writes what it started (`session_id`, `session_url`, `session_kind`,
  `agent_state = 'starting'`, `run_token`) into the ticket row;
- the **agent writes its own state into that same row**, over Turso's HTTP API;
- the board **polls the row** and makes the one automatic move (`in_progress → in_review`).

The agent never calls the board and the board never calls the agent except through the two CLI
commands below. The row is the whole truth about an agent; nothing is derived at read time
(`db.ts` header, rule 1).

## The two CLI calls — `backend/src/cloud.ts`

`cloud.ts` is the **only** module that knows `claude` exists. It exposes a two-method
`CloudDriver` and two implementations, picked by `CLOUD_DRIVER` in `cloudDriverFromEnv`
(`cli` default, `fake`; anything else **throws at boot**, so a typo can neither spend real
sessions nor silently fake production — verified, `cloud.test.ts`). `server.ts` builds it once at
module load for the same reason.

| Call | Command (`cli` driver) | Success means |
| --- | --- | --- |
| `startSession({cwd, baseBranch, message, title})` | `execFile(CLAUDE_BIN \|\| "claude", ["--cloud", message, "--ref", baseBranch], {cwd})` | stdout contains a session URL; the **first** `https://claude.ai/code/(session_\w+\|cse_\w+)` anywhere in stdout wins (`parseSessionUrl`) |
| `sendMessage(sessionId, text)` | `execFile(bin, ["-p", text, "--cloud", sessionId, "--output-format", "json"])` | stdout parses as a JSON object with `ok: true` (`parseSendResult`); anything else — including exit 0 with garbage — is a failure |

- `cwd` is the project's own clone (`project.repoPath`): `claude --cloud` reads the repo it is
  started in. That is why Start and Plan both require `provisionState === "ready"`
  (`server.ts`, `project_not_provisioned`).
- `title` goes nowhere — the CLI has no title flag 10x relies on; it exists for logs and the fake.
- Timeout `CLOUD_TIMEOUT_MS`, default **180 000 ms**, deliberately generous: a timeout that fired
  before the CLI printed the URL would leave a session running that the board never learned
  about. `maxBuffer` 16 MiB.
- Every failure is one `Error` carrying the **tails** (last 2000 chars) of both stdout and
  stderr (`cliError`), so a failed Start is diagnosable from the 502 body.
- Env vars are read with `||`, not `??`: `.env.example` lists them empty and `loadEnvFile` sets
  an empty line to `""`, which must mean "unset" (verified, `cloud.test.ts`).
- *(Inferred: the flag spellings. `docs/prototype-cloud-setup.md` has the two smoke-test commands
  to run before trusting them; if they differ, `cliDriver` or a `CLAUDE_BIN` wrapper is the only
  place to change.)*

## The opening message — `backend/src/prompts.ts`

`--cloud` has no system-prompt flag 10x relies on, so the instructions travel **in the opening
message**. `sessionMessage(kind, ticket, project, runToken)` returns
`ticketBlock(ticket) + "\n\n---\n\n" + <rendered prompt>`:

- `ticketBlock` starts with the fixed line **`10x ticket <id> — <title>`**, then description,
  playbook, and both checklists (empty fields written as `(empty)`). The fake driver reads the
  ticket id back out of that line (`ticketIdFromMessage`), the same way a real agent has only the
  message to go on.
- The ticket is **concatenated, not substituted**, so a user's own `{{text}}` in a description
  cannot trip `renderPrompt`'s leftover-marker check (verified, `prompts.test.ts`).
- `impl` renders `prompts/implementation.md` with `ticketId`, `runToken`, `branch`
  (`sessionBranchFor(id)` = **`claude/10x-<id>`**), `baseBranch`, `repo` (`owner/repo`).
  `plan` renders `prompts/plan.md` with `ticketId`, `runToken`, `repo`. `renderPrompt` throws on
  a leftover marker **and** on a supplied key with no marker, so a rename breaks the request,
  not the run.
- The branch is a **request**: cloud sessions reliably push `claude/`-prefixed branches, but the
  agent writes the branch it **actually** pushed into the row, and everything downstream (Accept,
  Preview) reads that column.

## The agent ↔ board protocol

The agent talks to the database with a bash helper defined in both prompts:

```bash
tenx_sql "UPDATE tickets SET agent_state = ? WHERE id = ? AND run_token = ?" working <id> <token>
```

It is one Hrana `POST $TENX_DB_URL/v2/pipeline` (`execute` + `close`) with bearer
`$TENX_DB_TOKEN`; every argument is sent as `{"type":"text"}` — SQLite's column affinity turns
`"42"` into an integer in `pr_number` *(inferred from SQLite's affinity rules; not pinned by a
test)*. `TENX_DB_URL`/`TENX_DB_TOKEN` are cloud-**environment** variables the user sets once in
claude.ai, not something 10x sends. **A SQL error still exits 0** with `"type":"error"` in the
JSON, so the prompts tell the agent to read every response.

Rules the prompts state (verified by reading both `prompts/*.md`):

- **Every UPDATE is `WHERE id = ? AND run_token = ?`** with the session's token (pinned:
  `prompts.test.ts` "every agent UPDATE is scoped to this session's run token").
- Allowed columns: `title`, `description`, `task_breakdown`, `acceptance_criteria`, `playbook`,
  `agent_state`, `agent_note`, `agent_updated_at`, and for `impl` also `branch`, `pr_number`,
  `pr_url`. **Never `status`.**
- `agent_state` ∈ `working | done | blocked | failed`. The board writes `starting`.
- Checklists are JSON arrays of `{text, done}` and **a write replaces the whole array**.
- `playbook` must be one of the seven `PLAYBOOKS` values; nothing validates an agent's write.

### `run_token` — the per-session write scope

`run_token` is a column added for this branch and **not** in the design doc's original
protocol (`db.ts` schema comment). `server.ts` mints a `randomUUID()` for every Start and every
fresh Plan, quotes it in the opening message, and stores it on the row:

| When | How the token changes |
| --- | --- |
| Start (`/spawn`) | new token, in the **same statement** as the `todo → in_progress` claim (`claimTicketWith`) |
| Plan (`/plan`, not reused) | new token via `setRunFields`, before `startSession` |
| Start or Plan fails to start | cleared to `NULL` with the other session columns |
| Cancel | cleared to `NULL` (`CLEARED_SESSION`) in the claim statement |

So a stale session — a planner left open after the ticket was promoted and started, an
implementation that was cancelled and restarted — **matches zero rows** and cannot move the
current run. The prompts tell the agent that 0 rows affected means *stop*, not retry.
`run_token` never reaches the wire: `TicketRow`/`Ticket` have no field for it (`db.ts`,
`types.ts`).

**Reads are not scoped** — the agent's `SELECT … WHERE id = ?` reads the ticket whatever its
token — and the token is scoping, not security (see [known gaps](#known-gaps)).

### What each agent does

**Implementation** (`prompts/implementation.md`): `working` first → branch `claude/10x-<id>` off
the base → before-screenshot if UI → implement, ticking checklist items → run the repo's own
checks → commit and push → open (or reuse) a **draft** PR against the base → after-screenshot,
both posted with `gh pr comment --attach` → write `branch`, `pr_number`, `pr_url`, `agent_note`
→ **`done` as the very last write**. Stuck → `blocked` + the question in `agent_note`;
impossible → `failed`. A follow-up (Reject) → `working`, fix on the same branch and PR, `done`.
A "cancelled" message → stop, write nothing more.

**Plan** (`prompts/plan.md`): no branch, no commits, no PR. Talks with the human in the session
tab, writes `title`/`description`/`task_breakdown`/`acceptance_criteria` as each is agreed,
sets `blocked` while waiting for an answer and `working` when it comes, then `agent_note` and
`done`. **It never moves the ticket** — promoting Backlog → To Do is the human's click.

## The poller — `backend/src/poller.ts` + `server.ts` `pollTick`

`startPoller(tick, AGENT_POLL_MS)` is a **self-scheduling `setTimeout` loop**, not
`setInterval`: the next tick is scheduled only after the previous one settled, so against Turso's
unbounded latency two ticks can never overlap; a throwing tick is logged and the loop carries on;
`stop()` resolves after the tick in flight (verified, `poller.test.ts`). `AGENT_POLL_MS` defaults
to **5000** and a non-positive or non-numeric value throws at boot.

Each tick, in order:

1. **`settleFinishedAgents()`** (`db.ts`) — one statement:
   `UPDATE tickets SET status='in_review', finished=1 … WHERE status='in_progress' AND agent_state='done' RETURNING id`.
   The `status` in the WHERE is the same CAS every claim makes, so a Cancel that got there first
   matches nothing and a ticket settling twice moves once.
2. **`reconcilePullRequests(now)`** — for every ticket with a `pr_number` whose `pr_state` is not
   terminal, at most once per `PR_CHECK_TTL_MS` (60 s) per ticket, a live
   `GET /repos/{o}/{r}/pulls/{n}` writes state and ±LOC. Fail-open; skipped with no
   `GITHUB_TOKEN`. It runs **here, not in the board read**, so `GET /tickets` stays a pure
   database read (verified, `server-pr.test.ts`).

Nothing else is automatic. `blocked` and `failed` only change how the card looks
([frontend](./frontend.md)); a `failed` or silent agent leaves the ticket In Progress until a
human cancels it.

## The routes, as they touch a session

All in `backend/src/server.ts`. Each one checks `inFlight` first (409 `operation_in_flight`).

- **Start** `POST /tickets/:id/spawn` — `claimTicketWith(id, "todo", "in_progress", {…CLEARED_SESSION, run_token, session_kind: "impl", agent_state: "starting", finished: 0, died: 0, started_at})`:
  the session columns change **in the same statement as the status**, so a leftover `done` from
  an earlier session can never sit beside `in_progress` for a poll. Then `startSession`; on
  success `setRunFields({sessionId, sessionUrl})` only — the agent may already have written
  `working`, which must not be clobbered back to `starting`. On failure the claim is handed back
  (`in_progress → todo`, session columns and `started_at` cleared) and the answer is **502
  `session_start_failed`** with the CLI's tails. No worktree, no port slot.
- **Plan** `POST /tickets/:id/plan` — Backlog only (409 `not_in_backlog`); **never claims**, so
  `inFlight` is the whole concurrency guard. **Idempotent**: a ticket that already has a `plan`
  session with an id and URL and whose `agent_state` is not `failed` answers
  `{ok, reused: true, sessionId, sessionUrl}` and starts nothing — the conversation already
  exists in claude.ai. Otherwise it writes `session_kind='plan'`, `agent_state='starting'`, a new
  token, then starts; failure clears those and answers 502 `session_start_failed`.
- **Reject** `POST /tickets/:id/reject {reason}` — 400 `reason_required`; 409 `no_session`
  without a `session_id`. `claimTicketWith(id, "in_review", "in_progress", {agent_state: "working", finished: 0})`
  — again one statement, or the poller could see the old `done` beside `in_progress` and undo the
  rejection. Then `sendMessage` with "TICKET REJECTED" + the reason. A failed send hands the claim
  back **restoring the agent's own last `agent_state` and `finished`**, and answers 409
  `prompt_failed`. The token is unchanged: the same session keeps working.
- **Cancel** `POST /tickets/:id/cancel` — `claimTicketWith(id, "in_progress", "todo", {…CLEARED_SESSION, branch: null, finished: 0, died: 0})`,
  then stop any Preview, then a **best-effort** `sendMessage("Ticket cancelled — stop work now…")`.
  Answers `{ok, messaged}`; a failed message does not fail the cancel. `pr_number`/`pr_url` are
  **kept** so the delete guard still sees an open PR. The branch stays on GitHub.
- **Delete** `DELETE /tickets/:id` (and project delete) — live PR guard first; then the same
  best-effort cancel message if the ticket is `in_progress` or has a `plan` session; stop Preview;
  drop the row.
- **Accept** `POST /tickets/:id/accept` — 409 `no_branch` if the agent reported neither a PR nor
  a branch; 500 `missing_github_token`. Claim `in_review → done`, then: agent opened a PR →
  `markPullRequestReady` (REST read, then GraphQL `markPullRequestReadyForReview` only if it is a
  draft); no PR → `openPullRequest` from the agent's already-pushed `branch`, **no local push**.
  Failure hands the claim back (502). Details in [github](./github.md).
- **Steer** has no route: the card links to `session_url` in a new tab
  ([frontend](./frontend.md)).

## Preview — `backend/src/preview.ts`

The only thing that still runs on this machine per ticket. `POST /tickets/:id/preview`
(409 `no_branch` until the agent reports one; 409 `port_pool_exhausted`):

1. `reservePortSlot(id)` — the port pool now exists **only** for Preview
   ([architecture](./architecture.md)).
2. `isSafeBranch(branch)` — `branch` is agent-written, so it is refused unless it matches a
   conservative ref alphabet with no leading `-`, no `..`, no `.lock`.
3. `git fetch origin +refs/heads/<branch>:refs/10x/preview/<id>` — a **per-ticket ref**, not
   `FETCH_HEAD`, which is one file per clone and would let two Previews race; `+` survives the
   agent force-pushing after a Reject.
4. `git worktree add --detach $STATE_DIR/previews/<id> refs/10x/preview/<id>`, after removing any
   previous checkout (a second Preview shows the latest push).
5. Write `.env` with `PORT`, `PORT_RANGE_START`, `PORT_RANGE_END` and add it to the clone's
   `info/exclude` (`git.ts` `excludeFromGit`).
6. If `project.devCommand` is non-empty: `sh -c <devCommand>` in its **own process group**, env
   with those ports and **without** `GITHUB_TOKEN`, `GH_TOKEN`, `TURSO_*`, `TENX_DB_*` (unreviewed
   agent code must not act as the board); output to `$STATE_DIR/previews/<id>.log`.

Answers `{path, port, url, command, running}`. `DELETE` (and cancel, delete, archive) kills the
group (TERM, up to 3 s, then KILL), removes the checkout, deletes the ref, releases the slot.
State is **in memory**: at boot `server.ts` releases every held slot and `sweepPreviews` deletes
`previews/` and `git worktree prune`s each clone; SIGTERM/SIGINT stop every Preview before exit
(verified, `preview.test.ts` against a bare-repo upstream and a real listener).

## The fake driver

`CLOUD_DRIVER=fake` is how the unit suite, e2e and offline UI work run with no network and no
spend (`fakeDriver` in `cloud.ts`):

- Records every call in `calls`; with `FAKE_CLOUD_LOG=<file>` also appends each as a JSON line,
  which is how a test reads what a **server child process** sent.
- Returns `session_fake_<n>` and `https://claude.ai/code/session_fake_<n>`.
- `FAKE_CLOUD_FAIL=start,send` makes those calls throw, for the hand-back paths
  (`cloud-routes-failure.test.ts`).
- With `FAKE_AGENT_MS=<n>` it **plays the agent** through the same `Sql` the board reads:
  `working` after *n* ms, then `done` (plus `branch = claude/10x-<id>` for an implementation
  session) after *2n*. A follow-up `sendMessage` replays the turn. It tells impl from plan by
  whether the message contains `claude/10x-`.
- **Its writes are scoped `WHERE id = ? AND session_id = ?`, not by `run_token`** — the board
  stores `session_id` only after `startSession` resolves and Cancel clears it, so a turn that
  outlives its session writes nothing. The consequence: **no test exercises a real agent's
  `run_token` scoping end to end**; only the prompt text is pinned.

`e2e/fixtures.ts` starts every board with `CLOUD_DRIVER=fake`, `FAKE_AGENT_MS=600`,
`AGENT_POLL_MS=200`, `TURSO_DATABASE_URL=""`, `GITHUB_TOKEN=""` and `PORT_BLOCK_BASE=4700`
([testing](./testing.md)). By hand: `CLOUD_DRIVER=fake FAKE_AGENT_MS=5000 pnpm start`.

## Known gaps

- **No programmatic session status.** The board trusts what the agent writes. A session that
  crashes, runs out of budget, or never reaches the database stays `starting`/`working`
  forever; the only recovery is a human opening the session and then cancelling. Nothing
  detects a stale `agent_updated_at`.
- **Cancel cannot archive or stop the session.** It sends a polite message and clears the row;
  the session keeps running (and billing) until the user archives it in claude.ai. Its later
  writes land nowhere because the token is gone, but a push to the branch still happens.
- **Agents hold a full-access database token.** `TENX_DB_TOKEN` can read and write every ticket
  and every table. "Only your own row, only these columns" is prompt text; `run_token` stops a
  *stale* session by accident, not a hostile or confused one — the token is readable from the
  row by anyone holding the DB token. The fix is a scoped Turso token or a write proxy; neither
  exists.
- **A failed start can leave an invisible session.** If `claude --cloud` started a session and
  then failed or timed out before printing its URL, the board hands the claim back and never
  learns the id; the 502 body's stdout tail is the only way to find it.
- **The CLI flags and real Turso are unexercised** (see Provenance).
