# Teardown

**Node:** teardown · Parent: [INDEX.md](./INDEX.md)

Prior attempts accumulated ~10 GB of stale worktrees for a simple reason: **they had no cleanup
code at all.** Any teardown that runs is therefore a large improvement.

## Teardown triggers and depths — the only authority on this

**Settled.** Every trigger is enumerated below with a decision for each of the five independent
dials. Anything not in this table is a bug, not a judgement call.

The dials: **agent process**, **Herdr pane/workspace**, **worktree directory**, **branch**,
**OMP transcript**.

| Trigger | Agent | Pane / workspace | Worktree | Branch | Transcript |
|---|---|---|---|---|---|
| **Cancel** (In Progress → Backlog) | stop | close | **force-remove** | **delete** | **delete** |
| **Ticket deleted** | stop | close | **force-remove** | **delete** | **delete** |
| **Project deleted** | stop all | close all, incl. source workspace | **force-remove all** | **delete all** | **delete all** |
| **Manual "remove worktree"** | stop | close | **force-remove** | keep | **delete** |
| Agent finished its turn | leave running | leave open | keep | keep | keep |
| Agent crashed / `pane.exited` | gone | gone | keep | keep | **keep — evidence** |
| Herdr server restarted | gone | gone | keep | keep | keep |
| 10x backend restarted | leave running | leave open | keep | keep | keep |
| User closed the tab in Herdr | gone | gone | keep (orphaned) | keep | keep |
| Reconciliation finds it unowned | — | — | keep, **report** | keep | keep |
| Re-dispatch onto an existing worktree | reuse if live, else start | reuse | keep | keep | keep |

Five rules fall out of that table, and they are the whole policy:

1. **Only the first four rows destroy anything, and all four are explicit user actions.** Nothing
   else removes a worktree, ever.
2. **A finished agent triggers nothing at all.** No teardown, no column change
   ([operations](./operations.md)) — just a checkmark. The work is only genuinely done once merged,
   and a passing review does not imply merge, so nothing reclaims a completed ticket's worktree
   until the user says so.
3. **A dead pane is not a finished ticket.** Crash, `pane.exited`, Herdr restart and a
   hand-closed tab all leave the worktree alone and surface the ticket as needing attention. A
   ticket in Backlog *with* a worktree does not imply garbage — the agent may just have been
   stopped, and destroying it would discard real work to save kilobytes.
4. **The transcript dies with the worktree, except on a crash** — there it is the only record of
   what went wrong, so it is kept. Note the corollary: cancelling a crashed ticket *does* delete
   it, so read it first.
5. **`force: true` only ever follows an explicit user action.** Reconciliation never forces, never
   deletes ([reconciliation](./reconciliation.md)).

**Cancel is deliberately destructive**, and knowingly so: it means "discard this attempt". It does
*not* destroy as much as it appears to, though — deleting a branch only makes its commits
unreachable, and git keeps unreachable objects for `gc.pruneExpire` (default 2 weeks). Recovery is
`git fsck --unreachable | grep commit` then `git branch <name> <sha>`. Verified: a cancelled
ticket's commit was resurrected intact. Uncommitted work in the worktree is genuinely gone.

**"Manual remove worktree" is the escape hatch** for a crashed or abandoned run where the commits
matter: it reclaims the disk but keeps the branch, so nothing is lost.

**Consequence, accepted:** disk is user-managed. Nothing reclaims space behind your back, so
worktrees for completed-but-unmerged tickets accumulate until you act. Reconciliation makes them
visible ([reconciliation](./reconciliation.md)); `pnpm` keeps each one cheap
([reconciliation](./reconciliation.md)).

**Re-dispatch is reachable today, and currently broken (verified).** Re-dispatch means spawning a
ticket whose worktree — and possibly whose live agent — already exists. The route is a **10x backend
restart**: Herdr owns the panes and agents, so they survive untouched, but the in-memory ticket
store resets every ticket to Backlog. Pressing spawn then hits an existing worktree *and* an agent
still registered under the same name:

```
agent.start → agent_name_taken: agent name ticket-target-1 is already used;
              candidates: pane_id=w34:p1 workspace_id=w34 status=Done
```

It fails in 75 ms rather than retrying, because the [spawn](./spawn.md) guard correctly treats
anything other than `agent_pane_busy` as fatal. So the symptom is honest, but the operation is
unusable.

**Fixed:** on `agent_name_taken`, resolve the existing agent with `agent.get` and re-attach to it
rather than starting one — killing a working agent would discard its context. Re-attaching is
**silent**: no prompt is re-sent, because the agent is already working this ticket and re-prompting
would make it redo work. A deliberate "work on this again" is a separate action that arrives with
In Review → In Progress. `agent.get` also returns `pane_id`, so the event subscription is re-pointed
at the agent's actual pane if it differs from the worktree's first pane.

Verified: after a backend restart, spawn re-attaches in 67 ms with zero readiness polls and the
commit count unchanged.

**This exposed a second bug worth recording.** The readiness predicate accepted only
`agent_status === "idle"`, so re-attaching to an agent that had finished a turn *unobserved* — status
`done` — polled for the full 60 s and failed with `agent_not_ready`. `idle` and `done` are the same
underlying ready state ([agent-status](./agent-status.md)); any readiness check must accept
**both**. Every reused agent is `done`, so this made the reuse path fail 100% of the time.

The same path opens up again with In Review → In Progress, where a ticket legitimately returns to a
spawnable state while its worktree still exists.

## Unforced removal on a dirty worktree fails safely (verified)

`worktree.remove` on a dirty worktree returns **`dirty_worktree_requires_force`** and fails
**safely** — the worktree stays intact, the agent keeps running, no partial state.

This error is a **safety feature, not an obstacle**, and how you treat it depends entirely on who
asked:

| Caller | On `dirty_worktree_requires_force` |
|---|---|
| Explicit user action (cancel, delete, manual remove) | retry with `force: true` — the user asked to discard |
| Reconciliation or any background pass | **stop.** Surface it. Never force. |

## Result codes (all observed)

| Result | Meaning | Action |
|---|---|---|
| `worktree_removed` | success | done |
| `dirty_worktree_requires_force` | uncommitted or untracked files present | depends on caller — see table above |
| `workspace_not_found` | that **workspace** is gone — says nothing about the worktree | resolve by branch instead ([below](#a-closed-workspace-orphans-its-worktree)) |
| `not_linked_worktree` | target is the source workspace, not a ticket worktree | **never remove** — guard against this |
| `worktree_create_failed` | git refused: invalid branch name, or the worktree already exists | [naming](./naming.md) |
| `worktree_not_found` | `worktree.open` found no such branch or path | with a branch: nothing on disk, already clean |
| `agent_pane_busy` | pane's shell is not at its prompt yet | retry with backoff ([spawn](./spawn.md)) |
| `invalid_agent_name` | name broke `[a-z][a-z0-9_-]{1,32}` — usually a leading digit | prefix it ([naming](./naming.md)) |
| `agent_name_taken` | an agent with that name is already live, with its pane/workspace listed | reuse it: `agent.prompt`, not `agent.start` ([above](#teardown-triggers-and-depths--the-only-authority-on-this)) |

## A closed workspace orphans its worktree

`worktree.remove` **requires** a `workspace_id`. If the workspace is closed while the worktree
still exists on disk, that stored ID is dead and the folder is unreachable through `remove`.

Verified — and closing a **tab** does it too, which is what a user actually clicks:

```
tab.close w1E:t1                        → "ok"   (last tab, so the workspace closes with it)
workspace.get w1E                       → not found
worktree.list                           → branch tkt/tabtest, open_workspace_id: null
ls ~/.herdr/worktrees/<repo>/           → still on disk
```

So `workspace_not_found` means *"that workspace is gone"*, **never** *"the worktree is gone"*.

Two consequences:

- **Never call `workspace.close` on a ticket workspace.** Use `worktree.remove`.
- **Never rely on a stored workspace ID for teardown.** Resolve it by branch at teardown time —
  which the single path above already does, making this failure mode unreachable.

The user closing a tab in the Herdr TUI is a path the application cannot prevent, which is why
reconciliation ([reconciliation](./reconciliation.md)) is mandatory rather than optional — it is
how you find out.

## Teardown algorithm (single ticket)

**One path, no conditionals.** Resolve the workspace by branch, then remove. This works whether
the workspace is open, was closed behind your back, or the whole thing is already gone — so there
is no need to persist a workspace ID for teardown at all. The ticket's branch is sufficient.

```
1. Close the run's event-subscription connection.
2. worktree.open { branch }
   - worktree_not_found → nothing on disk. Already clean. Skip to step 5.
   - otherwise         → take workspace_id from .result.workspace.workspace_id
3. worktree.remove { workspace_id, force: true }
   - worktree_removed    → continue
   - not_linked_worktree → BUG: you resolved the source workspace. Abort, do not retry.
4. Delete the OMP session directory recorded for this run.
   It lives outside the worktree and survives removal.
5. Branch: delete it if the ticket was cancelled or deleted (work is discarded).
           keep it otherwise (see the trigger table above).
```

Step 4's session directory is the one that outlives the worktree — see
[reconciliation and disk](./reconciliation.md).

`force: true` is correct here because this path only ever runs for an explicit user action
([above](#teardown-triggers-and-depths--the-only-authority-on-this)): a cancelled ticket almost
always has uncommitted work, and forced removal against a live agent is clean (below). Using
`force: false` first only buys a `dirty_worktree_requires_force` round trip. **Reconciliation never
calls this path.**

## `worktree.open` by branch is idempotent (verified)

Safe to call unconditionally — that is what makes the single path above work.

```
worktree.create { branch: "tkt/GH-77" }  → w1J, 1 tab, 1 pane
worktree.open   { branch: "tkt/GH-77" }  → already_open: true, w1J, 1 tab, 1 pane
worktree.open   { branch: "tkt/GH-77" }  → already_open: true, w1J, 1 tab, 1 pane
```

An already-open worktree returns the **same** workspace ID and creates no duplicate tab or pane.
A worktree that exists on disk but has no workspace gets a fresh workspace. A branch with no
worktree returns `worktree_not_found` — which is the "already clean" signal, not an error to
report.

Pass `--no-focus` / `focus: false` so re-opening during teardown never yanks the user's view.

## Forced removal against a live agent is clean (verified)

Tested against an agent in `working` state with an untracked file and a live `sleep 120` child
process. After `force: true`: worktree directory deleted, pane killed, `omp` process gone, and
the `sleep 120` grandchild reaped. **No orphaned processes.** The whole process tree dies with
the pane.

## `worktree.remove` never deletes the branch (verified)

Confirmed: `tkt/probe-1` survived removal, still carrying commit `f61fb69`. That split is exactly
what you want:

- **Worktree** — the bulky part. Removed only by an explicit user action
  ([trigger table](#teardown-triggers-and-depths--the-only-authority-on-this)).
- **Branch** — cheap, and it holds the work. Deleted only on cancel or ticket deletion.

So a completed ticket keeps both, and a cancelled ticket loses both. Nothing else changes either.
