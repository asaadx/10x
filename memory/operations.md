# Operating 10x

**Node:** operations · Parent: [INDEX.md](./INDEX.md)

## Ticket state machine

### Scope: Backlog → In Progress → In Review → Done.

**Four columns.** Done is terminal — delete only — and is reached **only** by Accept.

| From | To | Trigger | Side effect |
|---|---|---|---|
| Backlog | In Progress | **spawn**, a click | the four spawn calls ([spawn](./spawn.md)), claimed by CAS ([below](#claiming-a-ticket-reject-concurrent-requests)) |
| In Progress | Backlog | **cancel**, a click | force-remove worktree, delete branch ([teardown](./teardown.md)) |
| In Progress | In Review | **automatic**: the agent's turn completed | none — the agent stays alive and the port block stays held |
| In Review | Done | **accept**, a click | push the branch, open a PR, retire the agent and its transcript, release the port slot. The worktree and branch **survive**; 10x never merges |
| In Review | In Progress | **reject**, a click with a mandatory reason | re-prompts the same live agent with the reason and clears `finished`. Destroys nothing |

### The automatic transition

`in_progress → in_review` fires from the spawn handler's status callback, at the same moment
`finished` is set: a settled status observed **after** `working` ([agent-status](./agent-status.md)).
It is a `claimTicket` CAS like every other transition, so it is a conditional UPDATE and not a
read-then-write. Three consequences worth knowing:

- **A turn can settle more than once.** A human steering the agent in Herdr produces a second
  `working → done` cycle. The second claim matches no row, because the ticket is already
  `in_review`, so nothing is re-transitioned.
- **`finished` is never cleared by a `working` transition.** It is cleared once, before the run.
  After a completion the ticket is already in review, so the only thing such a clear could reach
  is the completion that put it there.
- **A lost claim means do nothing.** The ticket is no longer `in_progress` — a cancel got there
  first — and forcing it would drag a ticket out of the column its owner just chose.

**The agent stays alive through In Review, and the ticket keeps its port slot.** Both are
deliberate: a Reject has to re-prompt the same agent with its full context, and a Preview started
from review binds the same port range. **The agent's dev server is killed at that moment**, though
— the reserved block is the only handle 10x has on a process it never spawned, so `dev-server.ts`
finds what listens in the block and kills it **only** after proving the process's cwd is inside
this ticket's worktree. A port alone is not proof of ownership. The reap is fire-and-forget with
an attached catch: a kill that fails must never fail the column transition that already happened.

**A ticket in review has two routes out, both by hand: Accept and Reject.** Cancel claims
`in_progress → backlog` and answers 409 from review, so an In Review card renders Accept and
Reject but **no run action** ([frontend](./frontend.md)). Delete still works from any column.

Both are claim-first, work-second. Accept hands the claim back to `in_review` if the push or the
PR call fails — a ticket in Done with no PR is worse than a visible error — but once the PR exists
the retire step can only log, because the PR is irreversible and the status now depends on it.
Reject hands the claim back to `in_review` if `agent.prompt` fails, and distinguishes
`agent_not_found` (`agent_not_alive`, the agent is genuinely gone) from any other prompt failure.

### What the app does on each agent status

```
working        → ticket stays In Progress
idle | done    → turn finished. Mark the card DONE (a checkmark) AND claim
                 in_progress → in_review. Worktree is kept (teardown.md).
blocked        → stays In Progress, flagged as needing a human
unknown        → no transition, no marking, ever
pane exited    → the run is dead. NOT finished — flag it as needing attention (gotchas.md).
                 Writes `died` and NOTHING else, so a pane dying after the turn ended cannot
                 pull the ticket back out of review.
```

### HTTP surface

The HTTP surface is documented in [architecture](./architecture.md).

### Deferred (recorded, not designed)

- **Attention-aware auto-transition.** Never move a ticket off In Progress while the user is
  focused on or attached to its pane. Intended shape: an OMP end-of-turn hook, plus a rule that a
  focused pane suppresses the transition and an unfocused one permits it. This is the real fix for
  the `idle`/`done` split ([agent-status](./agent-status.md)), replacing today's "treat both the
  same" — the transition it would gate now exists, so this is reachable work rather than a
  hypothetical.
- **Concurrency cap: 2 tickets.** Two proves concurrency; ten is a hardware question.
- **Base branch** is `main` by default, with an optional parameter to branch from something else.

Preview, merge policy and a fresh reviewing agent live in [parking-lot.md](./parking-lot.md).

---

## Operational safety

### Never point 10x at its own repo

The highest-priority hazard. If a ticket's target repo is `10x` itself, an agent commits, the dev
server hot-reloads, the backend restarts, every event subscription dies, and in-flight tickets
strand — presenting as a Herdr bug when it is self-inflicted.

Rules:

- **Separate prod and dev.** Prod is versioned, built from releases, and never modified while
  live. Neither environment hot-reloads the backend.
- **The backend must not hot-reload.** An agent that changes backend code must kill and restart it
  explicitly. Silent reloads orphan processes and worktrees no matter how good teardown is.
- Use a throwaway target repo for all testing. `~/scratch/10x-target` exists for this.
- **The structural fix is the project concept.** A ticket belongs to a project, and a project
  carries its repo path — so there is no implicit default repo to fall into, and pointing 10x at
  its own source becomes something you must deliberately configure. See
  [parking-lot.md](./parking-lot.md) → Projects.

### Claiming a ticket: reject concurrent requests

Cancel-then-immediately-re-add races teardown against spawn: `git worktree remove` is slower than
a drag. Being the only user does not help — one person drags faster than the filesystem.

**Design: compare-and-swap the real status, then do the work. Reject on CAS failure.**

```
1. Atomically flip backlog → in_progress, only if it is still backlog.
   Fails? Someone else already claimed it. Reject (409). Do nothing else.
2. Succeeded? You now own the ticket. Do the four spawn calls (spawn.md).
3. Spawn failed? Flip back to backlog. Any worktree left behind shows up in
   reconciliation (reconciliation.md).
```

The status field *is* the lock. No transient states, no separate queue, no in-memory registry.

Why this is sound rather than a shortcut:

- **`in_progress` set before the agent exists is not a lie** — it states intent: this ticket is
  claimed. "Is the agent actually up yet?" is a question for Herdr, not the database, and Herdr
  answers it precisely (`agent.list`, or no agent on the pane yet).
- **A crash leaves `in_progress` with no agent** — a state reconciliation surfaces plainly
  ([reconciliation](./reconciliation.md)). Compare that with a transient state, which leaves a
  status nothing can ever exit.
- **Spawn is idempotent** (open-by-branch, [naming](./naming.md)), so a retry after a partial
  failure is safe.
- **Flip order matters.** Flipping *after* a successful spawn is broken: during those ~3 seconds the
  ticket still reads `backlog`, so a second request passes the check and starts a second spawn.
  Claim first, work second.

**Atomicity without a database.** Today's store is in-process, and a single-threaded event loop
gives this for free: a check followed by an assignment with **no `await` between them** cannot be
interleaved. When a database arrives it becomes a conditional write
(`UPDATE … SET status='in_progress' WHERE id=? AND status='backlog'`) and the row count tells you
whether you won. Same design, same rejection rule, different substrate.

#### Why not transient statuses (`spawning`, `cancelling`)

They look cleaner but cost more, and CAS on the real status gets the same guarantee without them:

- **A crash strands the ticket permanently.** Nothing can move a ticket stuck in `spawning`; it
  needs a dedicated repair pass of transient states just to exist. CAS instead leaves a state
  reconciliation already reports.
- **They need deadlines.** A hung `agent.start` pins a ticket in `spawning` indefinitely, so every
  transient state wants a max duration and an expiry action.
- **They guard the ticket, not the resources.** Worktree, branch, pane, and agent live outside the
  store. Transient states reduce interleaving; they never make the four spawn calls atomic. The
  idempotent calls ([teardown](./teardown.md)) and reconciliation
  ([reconciliation](./reconciliation.md)) are required either way.
- **The UI must place the card mid-transition** — either it does not move for ~3 s (feels broken) or
  it moves optimistically and must roll back.
- **State count grows** with every future transition, each needing its own partner and rules.

Rejecting rather than queuing is permanent either way: a 409 shows the conflict, a queue hides it.

### Handle a dead pane

Subscribe to the global `pane.exited` ([gotchas](./gotchas.md)). An OMP crash or a stray `exit`
produces no status change, so without it the ticket hangs in In Progress forever.
