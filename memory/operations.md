# Operating 10x

**Node:** operations · Parent: [INDEX.md](./INDEX.md)

## Ticket state machine

### Scope: Backlog → To Do → In Progress → In Review → Done.

**Five columns.** Done is terminal — delete or archive only — and is reached **only** by Accept.

`backlog` holds raw ideas; `todo` holds work that is ready to start (verified: `Status` in
`backend/src/types.ts`, `COLUMNS` in `frontend/src/types.ts`). Start dispatches from **To Do**,
and a cancelled ticket goes back to **To Do**.

**[`backend/src/transitions.ts`](../backend/src/transitions.ts) is the single source of truth**
and the server validates every manual move against it (verified). Each row below is one row of
that table, and records the thing that is easy to get wrong: whether the move is a **pure status
write** or whether it **belongs to a route** because it has side effects outside the row. A pair
that is not in the table cannot be reached by any request.

| From | To | Trigger | How |
|---|---|---|---|
| Backlog | To Do | **promote**, a click | pure status write — a human accepting a plan; nothing outside the row changes |
| To Do | Backlog | **send back**, a click | pure status write — the ticket goes back to be re-planned |
| To Do | In Progress | **Start**, a click | `POST /tickets/:id/spawn`: claim, then start the cloud session ([cloud](./cloud.md)) |
| In Progress | To Do | **Cancel**, a click | `POST /tickets/:id/cancel`: clear the session columns and the reported branch, stop any Preview, tell the session to stop (best effort) |
| In Progress | In Review | **automatic**: the agent wrote `agent_state = 'done'` | the poller's `settleFinishedAgents` ([below](#the-automatic-transition)) |
| In Review | Done | **Accept**, a click | `POST /tickets/:id/accept`: mark the agent's draft PR ready, or open one from its branch. 10x never merges |
| In Review | In Progress | **Reject**, a click with a mandatory reason | `POST /tickets/:id/reject`: send the reason into the same session and reset `agent_state` to `working` |

**Plan is not a transition.** `POST /tickets/:id/plan` starts (or reopens) a planning session on
a Backlog ticket and leaves its status alone; promoting to To Do is the human's click
([cloud](./cloud.md)).

**`POST /tickets/:id/status {to}` performs the two pure moves and only those** (verified). It
refuses everything else in two distinguishable ways, because they are different mistakes: 409
`illegal_transition` for a pair the machine does not have, and 409 `transition_has_side_effects`
— carrying the `owner` that owns the edge — for a real move asked through the wrong door. The
second refusal is the load-bearing one: without it a caller writes `in_progress` straight onto a
row and the board renders a running card with no cloud session behind it. A lost CAS is 409
`not_in_status`. `PATCH /tickets/:id` still refuses `status` — and every session and agent column
— outright, so every move goes through the compare-and-swap.

### The automatic transition

`in_progress → in_review` fires from the **poller**, not from any request: every
`AGENT_POLL_MS` (default 5 s) one statement moves every ticket that is `in_progress` with
`agent_state = 'done'`, setting `finished = 1` in the same write (`db.ts`
`settleFinishedAgents`). The agent never writes `status`; it writes `done`, and the board makes
the move. Consequences worth knowing:

- **It is a CAS like every other transition.** `status = 'in_progress'` is in the `WHERE`, so a
  Cancel that won first matches nothing, and a ticket seen `done` on two ticks moves once.
- **A stale `done` must never sit beside `in_progress`.** That is why Start and Reject write the
  session columns **in the same statement as the status** (`claimTicketWith`): Start resets
  `agent_state` to `starting` (clearing an earlier session's `done`), Reject resets it to
  `working`. Two separate writes would let one poll land between them, see "in progress and done",
  and bounce the ticket straight to review — for Reject, silently undoing the rejection
  (verified by reading `db.ts` `claimTicketWith` and `server.ts`; the race window itself is not
  reproduced by any test, since no test can place a poll between two writes that no longer
  exist).
- **`blocked` and `failed` move nothing.** They flag the card; a human decides.

**A ticket in review has two routes out, both by hand: Accept and Reject.** Cancel claims
`in_progress → todo` and answers 409 from review, so an In Review card renders Accept and Reject
but **no run action** ([frontend](./frontend.md)). Delete still works from any column (guarded by
the live PR check).

Both are claim-first, work-second. Accept hands the claim back to `in_review` if GitHub refuses —
a ticket in Done with no ready PR is worse than a visible error. Reject hands the claim back to
`in_review`, **restoring the agent's own last `agent_state` and `finished`**, if the message
cannot be sent (409 `prompt_failed`), because a ticket in In Progress whose agent never heard the
rejection is a silent dead end.

### What the board does on each agent state

```
starting  → written by the board at Start/Plan. Card shows a spinner. No transition.
working   → the agent's first write. No transition.
done      → impl on an in_progress ticket: the poller claims in_progress → in_review.
            plan on a backlog ticket: nothing — the human promotes it.
blocked   → no transition. Amber card; agent_note (the question) in the tooltip and sheet.
failed    → no transition. Red card. Recovery is Cancel (or opening the session).
null      → no session, or a value the agent wrote outside the union (db.ts toAgentState).
```

### HTTP surface

The HTTP surface is documented in [architecture](./architecture.md).

### Deferred (recorded, not designed)

- **Detecting a dead session.** Nothing notices an agent that stopped writing; see
  [cloud](./cloud.md) → Known gaps and [parking-lot](./parking-lot.md).
- **Concurrency cap.** Nothing limits how many sessions run at once; only Previews are capped
  (`MAX_PORT_SLOTS`).

Merge policy and a fresh reviewing agent live in [parking-lot.md](./parking-lot.md).

---

## Operational safety

### Never point 10x at its own repo

If a ticket's target repo is `10x` itself, an agent's pushed change can be Previewed — or worse,
pulled into the running board — and the board's own backend restarts under it. Previews live in
memory, so a restart kills every one and every in-flight operation.

Rules:

- **Separate prod and dev.** Prod is versioned, built from releases, and never modified while
  live. Neither environment hot-reloads the backend.
- **The backend must not hot-reload.** Restart it explicitly.
- Use a throwaway target repo for testing (`asaadx/10x-test`, [github](./github.md)).
- **The structural guard is the project concept.** A ticket belongs to a project, and a project
  carries its own GitHub identity and its own clone under `$PROJECTS_ROOT/<id>`, so there is no
  implicit default repo to fall into.

### Claiming a ticket: reject concurrent requests

A double-click, a retry, or Cancel-then-Start racing each other are real even for one user.

**Design: compare-and-swap the real status, then do the work. Reject on CAS failure.**

```
1. Atomically flip todo → in_progress, only if it is still todo — and in the same statement
   reset the session columns and mint the run token.
   Fails? Someone else already claimed it. Reject (409). Do nothing else.
2. Succeeded? You now own the ticket. Start the cloud session.
3. Start failed? Flip back to todo, clearing the session columns (502 session_start_failed).
```

The status field *is* the lock. No transient states, no separate queue, no in-memory registry
(beyond `inFlight`, which only rejects a second operation on the same ticket while one runs).

Why this is sound rather than a shortcut:

- **`in_progress` set before the session exists is not a lie** — it states intent: this ticket is
  claimed, and `agent_state = 'starting'` says the agent has not reported yet.
- **A crash between claim and `startSession` leaves `in_progress`/`starting` with no session id**
  — plainly visible on the card, and Cancel recovers it. Compare a transient state, which leaves
  a status nothing can ever exit.
- **Flip order matters.** Flipping *after* a successful start is broken: while `claude --cloud`
  runs (seconds to minutes) the ticket still reads `todo`, so a second request passes the check
  and starts a second paid session. Claim first, work second.
- **A rollback target is the inverse of the claim, never a fixed status.** Start's rollback hands
  the ticket back to `todo`, because that is where the claim came from (verified:
  `backend/src/server.ts`). Re-pointing a transition means re-pointing its rollback in the same
  edit: a rollback still aimed at `backlog` would demote a planned ticket to a raw idea.

**Atomicity is the database's, not the event loop's** (verified: `claimTicket` /
`claimTicketWith` in `backend/src/db.ts`). The claim is a conditional write —
`UPDATE tickets SET status='in_progress', … WHERE id=? AND status='todo'` — and the reported row
count is what says whether you won, so the guarantee holds across processes and, against Turso,
across machines.

#### Why not transient statuses (`spawning`, `cancelling`)

They look cleaner but cost more, and CAS on the real status gets the same guarantee without them:

- **A crash strands the ticket permanently.** Nothing can move a ticket stuck in `spawning`; it
  needs a dedicated repair pass just to exist.
- **They need deadlines.** A hung `claude --cloud` pins a ticket in `spawning` indefinitely, so
  every transient state wants a max duration and an expiry action.
- **They guard the ticket, not the resources.** The session lives in claude.ai, outside the
  store; a transient state cannot make "start a session" and "record it" atomic either.
- **The UI must place the card mid-transition** — either it does not move for the length of the
  CLI call (feels broken) or it moves optimistically and must roll back.
- **State count grows** with every future transition, each needing its own partner and rules.

Rejecting rather than queuing is permanent either way: a 409 shows the conflict, a queue hides it.
