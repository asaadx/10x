# Reconciliation and disk

**Node:** reconciliation · Parent: [INDEX.md](./INDEX.md)

## Reconciliation — a view, not a destructive job

Teardown-time correctness is not sufficient: a Herdr server restart, a backend crash, or the user
closing a tab all orphan resources behind the app's back. Reconciliation is the safety net, and it
is cheap **because** of decisions already made — the branch is the identity
([naming](./naming.md)), `worktree.open` is idempotent ([teardown](./teardown.md)), and Herdr is
the source of truth about what is actually running.

**Design decision: reconciliation reports; it does not delete.** Removing a worktree can destroy
uncommitted work and is unrecoverable, so a background process must never do it on a guess. The bug
class is eliminated by making divergence *visible*, not by automating destruction.

**There are exactly two carve-outs, and both share one test: is there any unrecoverable work
here to lose?** The rule protects the user's *work* — a worktree, a branch, a transcript, none
of them recreatable.

**The port slot** ([architecture](./architecture.md)). Boot clears `tickets.port_slot` for any
ticket that is not `in_progress`. A port slot is our own bookkeeping, a row saying "this number
is spoken for", so reclaiming one cannot lose anything, while leaving it held silently shrinks a
ten-wide pool on every crash.

**The plan workspace** ([below](./reconciliation.md)). A planner holds no worktree, no branch
and no commits, so closing its pane destroys nothing — but only once its conversation is
provably over, which is why that rule is spelled out at length.

So this is a **read model, not a cron job.** Whenever the board renders, ask Herdr what exists and
display it next to what the tickets claim. A worktree indicator on the card, derived from Herdr
rather than from our own store, means "this ticket has a worktree" is always observably true or
false — and "this ticket has a worktree but shouldn't" becomes a thing you can see and act on
deliberately.

### The invariant: every ticket worktree maps to a ticket

Guaranteed by construction, and cheaply checkable, because ticket branches are namespaced
`ticket/<project>/<number>` ([branch names](./naming.md)). A worktree is **ours** only if both
hold:

1. `is_linked_worktree` is true (never the source workspace,
   [below](./reconciliation.md#the-implicit-source-workspace-verified)), **and**
2. the branch matches `ticket/<project>/<number>` **and** that project and number resolve to a
   known ticket.

Anything else — a hand-made worktree on branch `my-experiment`, a colleague's checkout, an
unrecognised `ticket/` branch — is **never enumerated as removable at all.** Not "skipped for now":
outside the set the reconciler will even consider. A manual worktree is therefore safe by default,
and its non-ticket name is itself the signal that it is not ours.

### What reconciliation reads

```
worktree.list {cwd: "<repo>"} → worktrees[]:
  { path, branch, is_linked_worktree, is_prunable, open_workspace_id }
```

Match on **`branch`**, never on path — the branch is the only value that round-trips exactly.
Pair it with `agent.list` to learn whether a live agent occupies the worktree's pane.

### Divergence table

Reconciliation **never removes anything** ([teardown](./teardown.md)). Its entire output is what
the board displays; the only state it may change is the ticket's own status, and only where no
resources exist.

| Ticket says | Herdr reality | Show | May do automatically |
|---|---|---|---|
| `in_progress` | agent alive | running | re-subscribe to its pane ([agent status](./agent-status.md)) |
| `in_progress` | worktree, no agent | needs attention | nothing — a human decides |
| `in_progress` | nothing exists | not actually running | reset status to `todo`, where the spawn claimed it from — nothing to destroy |
| `todo` / `backlog` | worktree exists | worktree indicator | nothing |
| — | worktree, no ticket | listed as unowned | nothing |

Row 2 is the genuinely ambiguous one: an absent agent cannot distinguish "finished while the
backend was down" from "crashed". Rather than guess, surface it.

Row 3 is the only automatic mutation, and it is safe because there is nothing on disk to lose —
it corrects a status that is simply false. It also needs a ticket store, so it lands with the
database (below).

### Why build it early

Not for the deletion — for the **visibility**. Knowing what actually exists lowers the cost of every
other bug: teardown does not have to be perfect, a crash stops being expensive, and the
`in_progress`-with-no-agent state left by the CAS design ([operations](./operations.md)) becomes
something you can see instead of something that silently rots. Deferring it means every other
mistake is invisible until disk fills up.

Prerequisites differ by direction: reading Herdr and showing unowned worktrees needs **no ticket
store** and is buildable today. Repairing ticket state needs somewhere durable to read tickets from,
so it lands with the database.

## The plan-workspace sweep — the second carve-out

A planning agent ([spawn](./spawn.md)) owns no worktree, no branch and no commits, so nothing
above can see it: every join in `reconcile.ts` is on a branch, and there is none. Its Herdr
**workspace label** is the only handle ([naming](./naming.md)), so a planner whose ticket has
moved on leaves a pane that nothing else will ever collect.

Hence `sweepPlanWorkspaces`, at boot: `workspace.list {}`, then close the workspaces whose
planning is provably over. It is a carve-out from "reconciliation never destroys" on the same
grounds as the port slot — there is no unrecoverable work in a plan pane to lose — and it is
bounded just as tightly.

**The rule, and it is load-bearing:**

| Workspace labelled as a planner | Decision |
|---|---|
| its ticket no longer exists | **close** — deleted while its planner was open |
| its ticket has left `backlog` | **close** — a human promoted it, planning is over |
| its ticket is still in `backlog` | **spare** — the conversation may be live |
| not labelled by us | never a candidate at all |

**Why "still in backlog" must be spared.** Herdr keeps panes and agents alive across a restart
of this process — the same fact that makes `agent_name_taken` a real case in `runner.ts` — so a
plan workspace surviving a boot is the *normal* state of an ongoing conversation, not residue.
Closing it destroys work in progress, and the human is possibly typing in it at that moment.

Two further constraints, both easy to get wrong:

- **Feed it every ticket in the store, not one project's.** Labels are unique across the whole
  Herdr session, and a ticket missing from the list reads as *deleted* — so a per-project sweep
  would close every other project's live planners.
- **Run it before the "no projects yet" early return.** A deleted project takes its tickets with
  it, which is precisely the case that leaks a pane with nothing left to key on.

It logs what it closed *and* what it spared, and never throws: a sweep failure must not stop the
server coming up. A workspace it fails to close is swept at the next boot.

## What actually consumes disk (verified)

The worktree checkout itself is small. Two other things are not.

**Dependencies installed inside the worktree.** A fresh worktree of a JS/TS repo has no
`node_modules`, but the agent must install before it can build or test. Ten tickets can therefore
mean ten dependency trees — far more disk than the checkouts. *Inferred:* `pnpm` largely removes
this, since its store is content-addressed and worktrees hardlink into a shared store instead of
each holding a full copy. Not yet measured.

**OMP session transcripts, which survive worktree removal.** They live *outside* the worktree, so
`worktree.remove` does not touch them. Verified — after tearing down three probe worktrees:

```
~/.omp/agent/sessions/-.herdr-worktrees-10x-target-tkt-probe-1   20K   ← orphaned
~/.omp/agent/sessions/-.herdr-worktrees-10x-target-tkt-probe-2   16K   ← orphaned
~/.omp/agent/sessions/-.herdr-worktrees-10x-target-tkt-probe-q   12K   ← orphaned
```

Small per ticket, unbounded over time. Delete this directory as part of teardown.

**Do not derive the session directory name.** The slug is a mangled form of the worktree path
(`~/.herdr/worktrees/10x-target/tkt-probe-1` → `-.herdr-worktrees-10x-target-tkt-probe-1`).
`agent.start` returns the exact session file in `.result.agent.agent_session.value`; take its
parent directory and store that. Same rule as
[the branch-is-identity rule](./naming.md) — read identifiers from responses, never reconstruct
them.

## The implicit source workspace (verified)

Calling `worktree.create` with `cwd` pointing at a repo that has no open Herdr workspace
implicitly creates one **source workspace** for that repo (`is_linked_worktree: false`,
`checkout_path` = repo root).

It is created **once per repo and reused** — one source workspace served three successive ticket
worktrees. It is *not* a per-ticket leak. But:

- Never pass it to `worktree.remove` (returns `not_linked_worktree`).
- Close it with `workspace.close` when shutting down, not `worktree.remove`.
- *Inferred:* creating it explicitly up front, once per repo, and then passing `workspace_id`
  instead of `cwd` on every `worktree.create`, would make ownership explicit. Untested.

## Residue check (verified clean)

After tearing down four probe worktrees — two clean, two force-removed mid-flight — the
following were all empty or unchanged: `git worktree list`, `git branch`, the Herdr worktree
directory, the Herdr workspace list, and `pgrep omp`. `git worktree list --porcelain` reported
nothing prunable. Zero residue.

Manual audit commands, for a stuck state:

```bash
git worktree list                     # in the target repo
git worktree list --porcelain         # look for 'prunable'
git branch                            # stale ticket branches
herdr workspace list                  # stale workspaces
ls ~/.herdr/worktrees/<repo-name>/    # stale checkouts
du -sh ~/.herdr/worktrees             # total disk
pgrep -af omp                         # orphaned agents
```
