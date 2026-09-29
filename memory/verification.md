# Verifying and reproducing

**Node:** verification · Parent: [INDEX.md](./INDEX.md)

How to reproduce the claims in [cloud](./cloud.md) from scratch, cheapest first. Only step 4
spends anything.

## 1. The whole loop, offline — the fake driver

```bash
CLOUD_DRIVER=fake FAKE_AGENT_MS=3000 AGENT_POLL_MS=1000 \
  STATE_DIR=$(mktemp -d) TURSO_DATABASE_URL= GITHUB_TOKEN= \
  pnpm start
```

A throwaway `STATE_DIR` and empty `TURSO_DATABASE_URL`/`GITHUB_TOKEN` keep it off the real store
and the real GitHub (`.env` never overrides a variable already set, so an explicit empty value
wins). Add a project, create a ticket, promote it, Start: the card shows *starting*, then
*working* at 3 s, then moves to In Review at 6 s plus one poll, with `branch = claude/10x-<id>`.
Reject sends it back and the fake replays the turn. This is what `e2e/fixtures.ts` does for every
spec ([testing](./testing.md)). Adding a project over HTTP needs `GITHUB_TOKEN` (the lookup and
the clone both call GitHub), so with the token blanked you seed a `ready` `projects` row pointing
at a local clone directly, as `e2e/fixtures.ts` `createProject` does — or leave the token set and
accept that one network call.

## 2. The Turso driver, offline — `scripts/fake-turso.ts`

```bash
node scripts/fake-turso.ts --port 8080 --db /tmp/tenx.db &
TURSO_DATABASE_URL=http://127.0.0.1:8080 CLOUD_DRIVER=fake FAKE_AGENT_MS=3000 pnpm start
```

The board now speaks Hrana-over-HTTP for every query, exactly as against Turso. `sql.test.ts`
runs the same contract against both drivers this way.

## 3. Writing a row the way an agent does

With either store reachable over HTTP (fake-turso above, or real Turso), paste the `tenx_sql`
helper from `prompts/implementation.md` into a shell and play the agent by hand:

```bash
export TENX_DB_URL=http://127.0.0.1:8080 TENX_DB_TOKEN=unused   # fake-turso checks no auth
# read the ticket's run_token straight from the store (the agent gets it in its prompt)
tenx_sql "SELECT run_token FROM tickets WHERE id = ?" demo-1 | jq -r '.results[0].response.result.rows[0][0].value'
tenx_sql "UPDATE tickets SET agent_state = ? WHERE id = ? AND run_token = ?" done demo-1 <token>
```

Check three things in the JSON: `affected_row_count` is 1 with the right token and **0 with a
wrong one** (the stale-session guarantee); a malformed statement still exits 0 with
`"type":"error"` ([gotchas](./gotchas.md)); and the board moves the card on its next poll.

## 4. The real `claude` CLI — the one unverified dependency

The flags are from Anthropic's docs and have **not** been run against a real account. The
smoke test is in [`docs/prototype-cloud-setup.md`](../docs/prototype-cloud-setup.md) §2:

```bash
cd ~/.10x/repos/<some-project>
claude --cloud "Say hello and stop. Do not change any files." --ref main
#   → must print a https://claude.ai/code/session_… (or cse_…) URL
claude -p "Thanks, that's all." --cloud <that-session-id> --output-format json
#   → {"ok":true,...}
```

Starts one real session (and bills it). If a flag or the output shape differs, the only code to
change is `cliDriver` in `backend/src/cloud.ts` (or point `CLAUDE_BIN` at a wrapper), and
`parseSessionUrl` / `parseSendResult` are the two functions whose tests encode the assumed shape.
Archive the session in claude.ai afterwards — nothing else can.

## Residue check after a manual run

- `ls $STATE_DIR/previews/` — empty unless a Preview is running.
- `SELECT id, port_slot FROM tickets WHERE port_slot IS NOT NULL` — only tickets with a running
  Preview.
- `git -C <clone> worktree list` and `git -C <clone> for-each-ref refs/10x/` — no leftovers
  after DELETE `/preview`.
- Any real session you started: open it in claude.ai and archive it.
- Any real branch or PR an agent pushed to a test repo: close and delete it on GitHub.
