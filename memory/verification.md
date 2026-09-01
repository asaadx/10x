# Verifying and reproducing

**Node:** verification · Parent: [INDEX.md](./INDEX.md)

## Reproducing the validation

Probe commands, in order. Run from a scratch git repo with at least one commit.

```bash
# 0. preconditions
herdr status                  # server running; the socket also works OUTSIDE a pane (see 3)

# 1. create worktree + branch + workspace + tab + pane
herdr worktree create --cwd "$REPO" --branch tkt/probe-1 --base main \
  --label tkt-probe-1 --no-focus
# read workspace_id, root_pane.pane_id, worktree.path from the response

# 2. start the agent (system prompt file lives OUTSIDE the worktree)
herdr agent start tkt-probe-1 --kind omp --pane <pane_id> --timeout 90000 \
  -- --append-system-prompt /abs/path/system-prompt.md --auto-approve

# 3. send the ticket
herdr agent prompt tkt-probe-1 'TICKET ...' --wait --timeout 300000

# 4. verify real work landed on the branch, and main is untouched
git -C <worktree.path> log --oneline -3
git -C "$REPO" log --oneline -1

# 5. teardown, then confirm zero residue (see teardown.md)
herdr worktree remove --workspace <workspace_id>            # add --force if dirty
```

Event stream probe — the app's completion trigger, in 12 lines of Python:

```python
import socket, json
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect('/home/<user>/.config/herdr/herdr.sock')
s.sendall(json.dumps({"id": "sub", "method": "events.subscribe", "params": {
    "subscriptions": [{"type": "pane.agent_status_changed", "pane_id": "<pane_id>"}]
}}).encode() + b"\n")
for line in s.makefile('r'):        # first line is the ack, rest are events
    print(line.strip())
```

Expected output:

```
{"id":"sub","result":{"type":"subscription_started"}}
{"data":{"agent":"omp","agent_status":"working","pane_id":"w15:p1","workspace_id":"w15"},"event":"pane.agent_status_changed"}
{"data":{"agent":"omp","agent_status":"done","pane_id":"w15:p1","workspace_id":"w15"},"event":"pane.agent_status_changed"}
```

---

## Probing `state_change_seq`

The claims in [agent-status](./agent-status.md) about `state_change_seq` and `revision` come from
two throwaway probes built on `e2e/fixtures.ts`, so teardown is the same path the suite uses.
**Never point a probe at this repo** — `makeRepo()` is the only acceptable target.

Sketch, driven straight at the socket after `startBoard()` + `makeRepo()` + `spawnTicket()`:

```
poll agent.get {target} every 100ms, logging only changes to
  agent_status · state_change_seq · revision · interactive_ready · focused · terminal_title
```

That single loop settles most of it. What the loop alone cannot show, and how to get it:

| Question | How |
|---|---|
| global or per-agent | spawn a **second** agent and read its first value; global continues the sequence |
| noise immunity | against a settled agent: `agent.focus`, `pane.focus` elsewhere, `pane.rename`, `agent.send_keys`, `agent.read` |
| where `revision` comes from | `pane.get {pane_id}` beside `agent.get`; the numbers are identical |
| present on start/prompt | log the **raw** `agent.start` and `agent.prompt` envelopes, not the fields the app keeps |
| persistence | `grep state_change_seq ~/.config/herdr/session.json` — no match, so it is in-memory |

Do **not** restart the Herdr server to test the reset: it kills every live agent on the host,
including ones that belong to real tickets.

Residue check afterwards, all five dials: `agent.list` names, `worktree.list`,
`ls ~/.herdr/worktrees/`, the probe's `ticket/*` branches, and
`ls ~/.omp/agent/sessions/`. A probe that drives Herdr directly bypasses the fixtures, so it owns
its own transcript and worktree-parent cleanup.

---

## Verifying a Herdr name before you use it

Generate the schema with `herdr api schema --output herdr-api.schema.json`. It is gitignored,
about 255 KB, and regenerated on demand. **Search it rather than loading it into context.**

Where the names live:

```
methods              → schemas.request.oneOf[].properties.method.const
subscription types   → schemas.request.$defs.Subscription.oneOf[].properties.type.const
emitted event names  → schemas.event.$defs.EventKind.enum
response field types → schemas.success_response.$defs.<TypeName>.properties
```

Critically: **the schema proves a name EXISTS but NOT its wire separator.** Subscription types are
always dotted while emitted names are mixed, and the schema lists all event kinds with
underscores — so always normalise before comparing. A wrong event name fails silently.

---

## Source material

- `herdr --skill` — prints the agent skill for driving Herdr from inside a pane. Authoritative.
- `herdr api schema --output <path>` — full socket API JSON Schema (91 methods on 0.8.2). Not
  committed to this repo; regenerate on demand.
- `herdr api snapshot` — live `session.snapshot` as JSON.
- `herdr <group>` with no subcommand — prints that group's syntax (`worktree`, `agent`, `pane`,
  `workspace`, `tab`). Never run bare `herdr`; it launches the TUI.
- <https://herdr.dev/docs/socket-api/> — socket API reference.
- <https://herdr.dev/agent-guide.md> — concepts and human-facing setup.
- `omp --help` — OMP flags.
