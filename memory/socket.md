# Herdr socket transport

**Node:** socket · Parent: [INDEX.md](./INDEX.md)

## Socket transport contract

**Path:** `~/.config/herdr/herdr.sock` (Linux/macOS default session). Named sessions live under
`sessions/<name>/` in the same config dir.

**The 10x backend does not need to run inside a Herdr pane.** Verified with a fully scrubbed
environment (`env -i`, no `HERDR_*` variables at all): `ping` and `workspace.list` both succeeded.
The socket is plain filesystem IPC — anything that can open the file can drive Herdr. `HERDR_ENV=1`
is a *policy* gate in the agent skill, telling an agent not to meddle with a session it isn't part
of; it is not a technical requirement and not an authentication check.

One consequence: `HERDR_SOCKET_PATH` is only injected into managed panes, so a standalone backend
must derive the default path itself (or take it from config).

**Framing:** newline-delimited JSON over a unix domain socket. It is **not** WebSocket, despite
the request/response + pushed-event model. Do not reach for a WS client.

**Request shape:**

```json
{"id":"<string>","method":"<dotted.method>","params":{}}
```

### Three rules that will bite you (all verified)

1. **The server closes the connection after every response.** Two `ping`s on one socket → the
   second raises `BrokenPipeError`. Use **one connection per request**. Any client built on a
   persistent-connection assumption fails on its second call.
2. **`events.subscribe` is the sole exception** — its connection stays open and streams events.
   First line is the `subscription_started` ack; every later line is a pushed event.
3. **`params` is mandatory, even when empty.** `ping` without `params` returns
   `{"error":{"code":"invalid_request","message":"missing field `params`"}}`.

Raw socket `cwd` and `path` values **must be absolute**. The CLI expands relative paths before
sending; the socket API does not.

**CLI vs. socket:** the `herdr` CLI is **not** a thin wrapper over the socket API — it adds retry
and polling orchestration around some methods, and the spawn sequence
([spawn](./spawn.md)) is the critical case. The application should
speak the socket directly, because event subscriptions have no CLI equivalent, but it must then
replicate that orchestration itself. When CLI and raw-socket behaviour disagree, `strace` the CLI
rather than assuming Herdr is broken. CLI server errors are JSON on stderr with exit 1; CLI syntax
errors exit 2.

---

## Subscriptions: one per pane

`pane.agent_status_changed` **requires** a `pane_id`. There is no global agent-status stream —
verified: omitting it returns `invalid_request: missing field 'pane_id'`.

So each running ticket that *wants* status events needs its own subscription connection — one file
descriptor each, and the cap is 2 concurrent tickets for now ([operations](./operations.md)).
A subscription is not the only way to read completion, and it is the fragile one: it lives in
memory and dies with the process, whereas `state_change_seq` answers the same question from a
single `agent.get` ([agent-status](./agent-status.md)). The count is not the interesting part;
two other things are:

- **Ordering** — subscribe before `agent.start` (see [spawn](./spawn.md)).
- **Lifetime** — the subscription connection is a natural handle for the run. Closing it is part
  of teardown.

Subscription types requiring a `pane_id`: `pane.agent_status_changed`, `pane.scroll_changed`,
`pane.output_matched` (also needs `source` and `match`). All other subscription types are
global and take no arguments — including `pane.exited`, `pane.closed`, `pane.agent_detected`,
`worktree.removed`, and `workspace.closed`.

#### `pane.exited` and `pane.closed` are different events — subscribe to both (verified)

A dead run can arrive as either, and subscribing to only one silently misses half the cases:

| Event | Fires when |
|---|---|
| `pane_exited` | the **process** in the pane dies — agent crash, someone typing `exit` |
| `pane_closed` | the **pane** goes away — user closes the tab, or the workspace is closed |

Verified: `pane.close` emits `pane_closed` and then `workspace_closed`, and **never** emits
`pane_exited`. A subscription to `pane.exited` alone therefore never notices a hand-closed tab —
the exact case [teardown](./teardown.md) warns about.

#### Wire event names are inconsistently separated — normalise before comparing

**Subscription types are always dotted. Emitted event names are not consistent.** Verified in a
single capture:

```
subscribe pane.agent_status_changed  → "event":"pane.agent_status_changed"   ← DOTTED
subscribe pane.closed                → "event":"pane_closed"                 ← UNDERSCORED
```

So neither form can be matched literally. Normalise — `event.replaceAll(".", "_")` — then compare.

This is a **silent** failure mode: matching the wrong form drops every event of that type with no
error anywhere. It cost this project a working status pipeline once, where `agentStatus` sat at
`null` through an entire run while the agent worked correctly and committed, so the only symptom was
a checkmark that never appeared.

**Agent status values** (`idle`, `working`, `blocked`, `done`, `unknown`) and how to read
completion from them are documented in [agent-status](./agent-status.md).
