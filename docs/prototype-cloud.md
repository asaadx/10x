# prototype-cloud — agents on Claude Code cloud sessions

Branch `prototype-cloud`, cut from `dev`. This document is the build plan every worker follows,
and afterwards the description of how the prototype works. `dev` is untouched.

## Goal

Replace Herdr + OMP (local terminal panes running a third-party agent) with **Claude Code cloud
sessions** started from the board, and move the board's database to **Turso** (hosted SQLite) so
cloud agents and the local board share one store. Also: build the **List** view, and run **Plan**
as a cloud session too. Herdr is removed entirely, not kept as a fallback.

## Constraints that shaped the design (all researched 2026-09-29)

- **Only official mechanisms touch the subscription.** The backend drives the user's own logged-in
  `claude` CLI. No subscription tokens are stored or intermediated by 10x.
- **Start a session:** `claude --cloud "<task>"` run with `cwd` = the project's local clone. Prints a
  session URL `https://claude.ai/code/<session_id>` (ids look like `session_…` or `cse_…`).
  `--ref <branch>` picks the base. *(Flags from docs, not yet exercised by us — the morning check.)*
- **Message a session:** `claude -p "<text>" --cloud <session-id> --output-format json` →
  `{ok, session_id, url}` or `{ok:false, error}`. Async: queues and exits.
- **There is NO way to read a session's status programmatically**, and no CLI to stop/archive one.
  Therefore **the agent reports its own state into the shared database**, and the board polls the
  database. That is the central design decision.
- **Cloud agents cannot reach the local board.** They never call it. They talk to Turso over HTTPS
  (`POST <db-url>/v2/pipeline`), which the environment's network allowlist must permit.
- **Branch names:** cloud sessions reliably push `claude/`-prefixed branches. We ask for
  `claude/10x-<ticketId>` and the agent writes the branch it actually pushed into the DB.
- **Screenshots:** `gh pr comment <n> --attach './shot.png'` (gh ≥ 2.99, needs a `github_pat_`/`ghp_`
  token as `GH_TOKEN`). Posted by the agent on its own draft PR. Nothing is committed and nothing is
  uploaded to the board.

## Database — keep it simple

`backend/src/sql.ts`: one tiny async client, zero dependencies.

```ts
type Value = string | number | bigint | null | Uint8Array;
type Row = Record<string, Value>;
type Result = { rows: Row[]; rowsAffected: number; lastInsertRowid: number | null };
type Stmt = { sql: string; args?: Value[] };
export interface Sql {
  execute(sql: string, args?: Value[]): Promise<Result>;
  batch(stmts: Stmt[]): Promise<Result[]>; // atomic: all or nothing
}
```

- **Turso driver** when `TURSO_DATABASE_URL` is set (`libsql://` rewritten to `https://`), bearer
  `TURSO_AUTH_TOKEN`. `execute` = one pipeline `execute` + `close`. `batch` = ONE pipeline `batch`
  request: `BEGIN IMMEDIATE`, each statement conditioned on the previous step ok, `COMMIT` on the last
  ok, `ROLLBACK` on `not ok(commit)`. Never send BEGIN/COMMIT as separate requests (a failed middle
  statement would still commit the rest). Integers go over the wire as strings; decode integer
  results to `number`.
- **Local driver** (node:sqlite at `DB_PATH`) otherwise — for tests and offline dev only. Same
  interface; `batch` wraps in BEGIN IMMEDIATE/COMMIT, ROLLBACK on throw.
- `scripts/fake-turso.ts`: a ~100-line Hrana-over-HTTP server on `node:sqlite` (execute, batch with
  conditions, close) so the Turso driver is tested end to end offline, and so the board can be run
  against "Turso" locally. Not a production path.
- Everything that touched `db` synchronously becomes `async`. The CAS (`UPDATE … WHERE status = ?`,
  `rowsAffected === 1`) is unchanged in spirit. Multi-statement invariants (ticket number counter,
  port-slot reservation) go through `batch` — use SQL subqueries so later statements don't need
  earlier statements' results.

### New ticket columns

| column | meaning | written by |
| --- | --- | --- |
| `session_id`, `session_url` | the cloud session running this ticket (impl or plan) | board at spawn/plan |
| `session_kind` | `plan` \| `impl` | board |
| `agent_state` | `starting` \| `working` \| `done` \| `blocked` \| `failed` | board sets `starting`; agent sets the rest |
| `agent_note` | the agent's last one-paragraph summary / question | agent |
| `agent_updated_at` | ISO instant of the agent's last write | agent |
| `branch`, `pr_number`, `pr_url` | existing columns; now written by the agent | agent |

Project gains `dev_command` (TEXT, default `''`) for Preview. Columns tied to Herdr
(`agent_name`, `session_dir`, `died`, screenshots) may stay in the schema for migration safety but
leave the API types.

## Agent ↔ board protocol

The agent's instructions (rendered from `prompts/implementation.md` / `prompts/plan.md`, sent as the
session's opening message because `--cloud` has no system-prompt flag we rely on) include a
**"Reporting to 10x"** section with a bash helper:

```bash
tenx_sql() { # tenx_sql "UPDATE tickets SET agent_state = ? WHERE id = ?" working <ticketId>
  local sql="$1"; shift; local args="[]"
  for a in "$@"; do args=$(jq -c --arg v "$a" '. + [{"type":"text","value":$v}]' <<<"$args"); done
  curl -sf "$TENX_DB_URL/v2/pipeline" -H "Authorization: Bearer $TENX_DB_TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg s "$sql" --argjson a "$args" '{requests:[{type:"execute",stmt:{sql:$s,args:$a}},{type:"close"}]}')"
}
```

`TENX_DB_URL` / `TENX_DB_TOKEN` are cloud-environment variables (set once by the user). The agent
may only write its own ticket row, and only these columns: `title`, `description`,
`task_breakdown`, `acceptance_criteria`, `playbook`, `agent_state`, `agent_note`,
`agent_updated_at`, `branch`, `pr_number`, `pr_url`. (Convention, not enforcement — prototype.)

**Implementation agent lifecycle:** first action `agent_state=working`; work on branch
`claude/10x-<ticketId>`; commit, run checks, push; open a **draft** PR against the base branch;
if UI changed, post before/after with `gh pr comment --attach`; write `branch`, `pr_number`,
`pr_url`, `agent_note`, then `agent_state=done` **as the very last action**. Genuinely stuck →
`agent_state=blocked` with the question in `agent_note`. On a follow-up message (Reject), set
`working` again, address it, push to the same PR, end with `done`.

**Plan agent lifecycle:** no code changes. Talk with the human (they steer in the session tab),
then write `description`, `task_breakdown`, `acceptance_criteria`, `playbook` (checklists are JSON
arrays of `{text, done}`), then `agent_state=done`.

## Board behaviour

- **Poller** (in `server.ts`, every `AGENT_POLL_MS`, default 5000): for tickets `in_progress`
  whose `agent_state = 'done'`, CAS `in_progress → in_review` (the old "turn settled" move).
  `blocked` shows a flag on the card. Nothing else is automatic.
- **Spawn / Start** (`POST /tickets/:id/spawn`): CAS `todo → in_progress`, set `agent_state =
  starting`, `session_kind = impl`, call `cloud.startSession`, store `session_id/url`. Failure hands
  the claim back and clears the session fields. No worktree, no port slot.
- **Plan** (`POST /tickets/:id/plan`): backlog only; same, `session_kind = plan`; status unchanged.
- **Reject** (`POST /tickets/:id/reject {reason}`): CAS `in_review → in_progress`, `agent_state =
  working`, `cloud.sendMessage(sessionId, reason + "report done when finished")`. Send failure
  hands the claim back (409 `prompt_failed`).
- **Cancel**: best-effort `sendMessage("Ticket cancelled — stop work now.")`, clear session fields,
  back to `todo`. The user archives the session in claude.ai if they want.
- **Steer**: no route. The card links to `session_url` (new tab). `/focus` and the steer-mode
  local/remote toggle are deleted.
- **Accept**: if the agent recorded `pr_number`, mark the draft PR ready for review (GraphQL
  `markPullRequestReadyForReview`, `GITHUB_TOKEN`); otherwise open a PR from `branch` with the
  existing `openPullRequest` (no local push — the branch is already on GitHub). Target status and
  guards as today.
- **Preview** (`POST /tickets/:id/preview`, `DELETE /tickets/:id/preview`): in the project's local
  clone, `git fetch origin <branch>`, `git worktree add --detach $STATE_DIR/previews/<ticketId>
  FETCH_HEAD` (replace if present), reserve a port block (existing pool), write the `.env` port
  block, and if `project.devCommand` is set spawn it (`sh -c`, detached process group, `PORT` in
  env). Respond `{path, port, url, command, running}`. DELETE kills the process group, removes the
  worktree, releases the slot. Preview state is in memory (lost on restart — fine).
- **Board read** (`GET /tickets`) is now a pure DB read. `BoardTicket` loses `paneId`,
  `workspaceId`, `worktreePath`, `hasWorktree`, `diagnostics`, `agentStatus`; gains `sessionUrl`,
  `sessionKind`, `agentState`, `agentNote`, `agentUpdatedAt`, `preview`. `unowned` is dropped.

`backend/src/cloud.ts` — the only module that knows about `claude`:

```ts
export interface CloudDriver {
  startSession(o: { cwd: string; baseBranch: string; message: string; title: string }):
    Promise<{ sessionId: string; sessionUrl: string }>;
  sendMessage(sessionId: string, text: string): Promise<void>;
}
```

`CLOUD_DRIVER=cli` (default): `execFile(CLAUDE_BIN ?? "claude", ["--cloud", message, "--ref",
baseBranch], {cwd})`, parse the first `https://claude.ai/code/(session_\w+|cse_\w+)` in stdout;
`sendMessage` via `-p … --cloud <id> --output-format json`. Errors carry stdout/stderr tails.
`CLOUD_DRIVER=fake`: records calls in memory, returns `session_fake_<n>`; with `FAKE_AGENT_MS=<n>`
it plays the agent (writes `working`, then `done` + a fake branch) through the same `Sql` client,
so e2e can drive Backlog → Review with no network.

## Deleted

`herdr.ts`, `runner.ts`, `agent-boot.ts`, `panes.ts`, `reconcile.ts`, `dev-server.ts`,
`diagnostics.ts`, `skills.ts`, `screenshots.ts` + the screenshot routes, the Herdr parts of
`lifecycle.ts`, `instance-lock.ts` if only Herdr needs it, their tests, the steer-mode code,
`skills/` (content folded into the prompts), memory nodes `socket.md`, `spawn.md`,
`agent-status.md`, `teardown.md`, `reconciliation.md` (replaced by `memory/cloud.md`).

## Out of scope tonight

The CTO auto-dispatcher, access roles for other users, porting other OMP skills, hosted deploy.

## Morning setup (for the user)

See `docs/prototype-cloud-setup.md` (written last).
