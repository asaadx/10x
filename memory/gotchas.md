# Gotchas and known gaps

**Node:** gotchas · Parent: [INDEX.md](./INDEX.md)

Each failure mode below is a Herdr behaviour verified directly against a live server, paired
with the symptom it produces when violated. These are the traps to design against.

> **Unverified lead, not knowledge.** A read-only audit of an earlier abandoned attempt reported
> that its spawn path predicted worktree paths in three places while correctly reading pane IDs
> from responses, and that it never hand-assembled topology. That report came from an agent with
> a large context working in a known-broken codebase and was never independently confirmed; the
> branch is dead. Treat it only as a hint that [the branch-is-the-identity rule](./naming.md)
> deserves the most design attention. Do not cite it as fact, and do not let it narrow the
> checks in this node.

## Gotchas

- **`focus: false` on everything.** Spawning must never steal the user's focus. The CLI flag is
  `--no-focus`.
- **Do not close workspaces, tabs, or panes you did not create.**
- **Never run `herdr server stop`** from the app. It kills every pane process on the machine.
- **`agent.prompt` has an atomic `wait` option** (`{until, timeout_ms}`) that submits the prompt
  and starts the wait in one request, avoiding a prompt/wait race. Useful for scripted probes;
  the app should prefer the event subscription so the HTTP request does not block.
- **`agent_prompt_stalled`** — a prompt sent from a non-working state that produces no observed
  lifecycle change within 5 s returns this rather than hanging.
- **`agent_blocked`** — `agent.prompt` refuses a blocked agent and sends nothing
  ([agent-status](./agent-status.md)). Reliable on 0.8.2; was broken on 0.8.0.
- **`pane.exited` and `pane.closed`** — subscribe to **both**. Both are global (no `pane_id`), so
  one connection covers every ticket. Without them, an OMP crash, a typed `exit`, or a hand-closed
  tab leaves a ticket hanging in In Progress with no status change coming. They are not
  interchangeable — see [agent-status](./agent-status.md).
- **`agent_not_ready`** — two causes. From `agent.start`: the agent was blocked during startup, and
  the name stays usable for `agent.read` / `agent.send_keys`. From `agent.prompt`: the agent is not
  registered yet, i.e. the fresh-pane race ([spawn](./spawn.md)). Both mean "wait for idle, then
  prompt" — retry, do not fail the ticket.
- **`agent.start` startup timeout** defaults to 30 s; accepts `timeout_ms` between 3,000 and
  300,000.
- **Reading agent output:** prefer `--source recent-unwrapped` for logs and transcripts. If
  raising `--lines` reveals nothing more, the agent is on the terminal's alternate screen and
  those rows are unrecoverable from scrollback — ask the agent to write a file instead.
- **Bootstrap/recovery:** `session.snapshot` returns a one-time full snapshot (focused ids,
  workspaces, tabs, panes, layouts, agents). It is not a subscription. Call it on reconnect or
  whenever the local cache may be stale, then re-subscribe. CLI: `herdr api snapshot`.
- **The installed binary is the authority.** This document is pinned to **herdr 0.8.2, protocol
  20**. After upgrading, regenerate the schema with `herdr api schema --output <path>`, diff the
  method list, and re-run the [verification](./verification.md) probes.
- **Headless pane geometry is 120×40** when no client is attached (#2828). 10x creates panes with
  no client attached, so this is the size agents render into.

---

## `worktree.create` is one call, not three

It atomically creates the git worktree, the branch, the Herdr workspace, the tab, **and** the
root pane. One request returns all of it:

```
.result.workspace.workspace_id
.result.tab.tab_id
.result.root_pane.pane_id
.result.worktree.path
.result.worktree.branch
```

Symptom when violated: *"the pane doesn't get created."* Hand-assembling the topology with
separate `workspace.create` / `tab.create` / `pane.split` calls — or running `git worktree add`
yourself and then trying to attach a pane — reintroduces every failure mode this call already
solved. `agent.start` explicitly never creates, splits, or moves layout; it requires a pane that
already exists.

Emitted events: `workspace.created`, `tab.created`, `pane.created`, `worktree.created`.

Branch semantics: if the requested branch already exists locally, it is checked out; otherwise
it is created from `base`, or from `HEAD` if `base` is omitted.

## Subscribe before starting

See [agent-status](./agent-status.md). Subscribing after `agent.start` can miss the first
transition; the ticket then looks stuck in In Progress.

## Check `.error.code` before using any ID

Every response is either `result` or `error`. Treating a failed create as success and issuing
the next call with an undefined pane ID produces confusing downstream failures that look like
"the agent didn't start" rather than "the worktree was never created."

---

## Known gaps and unvalidated claims

Recorded so nobody assumes these are proven.

- **G2 — restart resilience, partly closed (verified).** A 10x backend restart on the same
  database keeps a finished ticket in `in_review` with its `finished` flag, its branch, its
  worktree and its port block, and the board re-reads the live agent as `done` — covered by
  `e2e/resilience.spec.ts`. **What is still missing is re-subscribing:** the new process holds no
  event subscription for a running ticket, and nothing at boot creates one, so a turn that ends
  *after* the restart is never recorded — the ticket keeps reading unfinished and **sticks in In
  Progress permanently**, because the transition rides on that same subscription. Boot
  reconciliation only reports it ([reconciliation](./reconciliation.md), divergence row 1).

  **A dropped socket is now detected and reopened (verified).** `subscribe()` takes an optional
  third argument, `onClose`, fired at most once when the connection drops from the far end and
  never when the caller calls the returned `close()` — the `closedByUs` flag, which is what stops
  teardown from triggering a pointless reopen. **Node emits `'close'` on a graceful hangup and
  `'error'` only on ECONNRESET/EPIPE/connect failure**, and always emits `'close'` after `'error'`,
  so the single `'close'` handler covers both. Before it, a clean Herdr restart matched none of the
  registered handlers: the stream object stayed truthy, every status event stopped, and
  `pane.exited`/`pane.closed` stopped with them, so even dead-pane detection died. Silently.

  `runner.ts` responds by probing `agent.get` on a bounded backoff (`STREAM_REOPEN_DELAYS_MS`,
  250 ms → 4 s): agent alive → re-subscribe to its authoritative `pane_id`; `agent_not_found` →
  `onPaneExit()`, the existing dead-pane path. **The probe is load-bearing, not decoration** —
  `pane.exited` is a global subscription we are not listening to during the gap, so the probe is
  the only dead-pane detection for that window. Covered by `src/herdr.test.ts` against a real unix
  socket; falsifiable (neuter the handler and two of its three tests time out).

  **The mechanism that closes the restart half needs no subscription at all:** a
  `state_change_seq` recorded at prompt time and persisted beside the ticket turns completion into
  one point-in-time `agent.get`
  ([agent-status](./agent-status.md)) — verified against a live Herdr, not yet built. That is what
  makes "derive the transition from the agent's current state" sound: status *alone* is not enough,
  because the first `idle` arrives before the prompt, but status paired with a counter that has
  moved since the prompt is. A plain boot catch-up (`in_progress AND finished → in_review`) was
  designed and **deliberately dropped**, and still should be: it makes steering worse, since
  restarting while you are talking to an agent jumps the ticket immediately.

  **Until it is built: do not restart the board while an agent is working.** If Herdr restarts,
  restart the board *after* it. A Herdr server restart is still unaddressed: panes and agents die
  with it, and it is also the one thing that resets `state_change_seq` — which fails closed,
  stalling a ticket rather than falsely completing one.
- **G3 — concurrency, proven at two agents (verified).** Two tickets spawned with `Promise.all`
  both reached ready in 3.2-3.9 s, ran their turns simultaneously, and each committed its own
  file: distinct branches, worktrees, agent names and panes, with a third unrelated agent live in
  the same Herdr session. Concurrency costs nothing measurable — a concurrent spawn is as fast as
  a solo one, and `worktree.create` twice at once in one repo does not race git.
  **The `agent_pane_busy` retry is the norm, not an edge case:** across 16 measured spawns, 13
  needed it (12 × 1 retry, 1 × 2) and 3 did not, with no relation to concurrency — the three clean
  ones were the first spawns of a run. Readiness always needed polling (19-24 polls, ~125 ms
  apart); the prompt was always accepted first try. Beyond two concurrent agents is still
  unexercised, and so is the cap in [operations](./operations.md).
- **G4 — `pnpm` and worktree dependencies.** The claim that a content-addressed store makes
  per-worktree `node_modules` cheap ([reconciliation](./reconciliation.md)) is reasoned, not
  measured.
- **G5 — the attention-aware transition.** The `idle`/`done` split
  ([agent-status](./agent-status.md)) currently has a stopgap (treat both as finished). The
  intended fix — an OMP end-of-turn hook plus focus/attach awareness — is unbuilt and untested,
  and it now has something concrete to gate: the automatic move to In Review fires on a settled
  status whether or not the user is watching that pane ([operations](./operations.md)).
- **G6 — pinned to herdr 0.8.2, protocol 20.** Schema checked against 0.8.0: 90 → 91 methods, only
  `pane.input.set` added, nothing removed, and every parameter shape this document depends on is
  unchanged (`WorktreeCreateParams`, `WorktreeRemoveParams`, `AgentStartParams`,
  `AgentPromptParams`, `EventsSubscribeParams`, and `pane.agent_status_changed` still requiring
  `pane_id`). Not yet exercised on 0.8.2:

  - **Headless pane geometry is now 120×40** (was 80×24) when no client is attached (#2828). 10x
    creates panes with no client attached, so this is the size agents render into. Unmeasured.
  - **The bundled agent skill now matches the release** (#2847). `herdr --skill` has not been
    re-read since upgrading; it may describe lifecycle behaviour more precisely than
    [agent-status](./agent-status.md).
  - `pane.current` / `pane.get` / `pane.layout --current` now resolve the *calling* pane rather than
    another client's focused pane (#2297, #2298).
  - `agent send-keys` preserves Shift for `shift+tab` (#1561) — how agent permission modes are
    cycled programmatically.

  **On the next upgrade:** regenerate the schema (`herdr api schema --output <path>`), diff the
  method list, update the version and protocol in this document's header, re-read `herdr --skill`,
  and re-run the [verification](./verification.md) probes. Also re-`strace` the CLI for any command
  whose raw-socket behaviour looks wrong: the CLI adds orchestration the socket method does not
  perform ([spawn](./spawn.md)).

**G1 (`blocked`) is closed.** A prose question reports `done`; the `ask` tool reports `blocked`.
See [agent-status](./agent-status.md).
