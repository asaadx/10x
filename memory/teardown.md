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
| **Accept** (In Review → Done) | stop | close | **keep** | **keep** | **delete** |
| Agent finished its turn | leave running | leave open | keep | keep | keep |
| Agent crashed / `pane.exited` | gone | gone | keep | keep | **keep — evidence** |
| Herdr server restarted | gone | gone | keep | keep | keep |
| 10x backend restarted | leave running | leave open | keep | keep | keep |
| User closed the tab in Herdr | gone | gone | keep (orphaned) | keep | keep |
| Reconciliation finds it unowned | — | — | keep, **report** | keep | keep |
| Re-dispatch onto an existing worktree | reuse if live, else start | reuse | keep | keep | keep |

Five rules fall out of that table, and they are the whole policy:

1. **Only the first four rows destroy a worktree, and all four are explicit user actions.** Nothing
   else removes one, ever. Accept is the fifth explicit action and deliberately spares both the
   worktree and the branch.
2. **A finished agent destroys nothing.** It moves its ticket to In Review and gets a checkmark
   ([operations](./operations.md)); the agent is left **running** and the port block stays held, so
   a Reject can re-prompt it with its full context. The work is only genuinely done once merged,
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

**Accept is `retireAgent`, deliberately not `teardown`.** Accept never merges — the user merges on
GitHub — so the worktree holds the only copy of the reviewed commits until then, and reclaiming it
would destroy work the open PR still points at. `retireAgent` resolves the session dir and pane id
**before** closing the pane (teardown's ordering, for teardown's reason: once the pane is gone,
`agent.get` can find neither, and the transcript path must never be derived by hand), then closes
the pane and `rm -rf`s the transcript. No `worktree.remove`, no branch delete. An agent that is
already gone is not an error — there is simply nothing left to close.

**Delete refuses to orphan an open PR.** `DELETE /tickets/:id` still runs the full destructive
teardown from any column — force-removed worktree, `git branch -D`, transcript `rm -rf`, row
dropped, **no audit trail** — but a ticket with a `pr_number` must first be shown to have a PR that
is merged or closed.

**The guard reads GitHub live, and that is the whole point.** Trusting the stored `pr_state` would
fail open exactly when it matters: the column is `null` whenever no webhook arrived, which is the
common case, since `gh webhook forward` only runs when someone starts it and missed events are lost
([github](./github.md)). So `needsLiveCheck` short-circuits only on a **terminal** stored state —
`merged` and `closed` cannot regress, so a stored one is as good as a fresh read — and anything
else, `null` included, triggers `fetchPullRequestState`.

| Outcome | Response |
|---|---|
| stored state already `merged` / `closed` | proceed, no network call |
| live read says `open` | `409 pr_open`, with the number and URL |
| no `GITHUB_TOKEN` | `409 pr_state_unknown` |
| the read throws | `409 pr_state_unknown` — **fail closed**, because the teardown is irreversible |
| live read is terminal | persist it, then proceed |

That write-back is deliberate: it is also the recovery path for a merge event missed while webhook
forwarding was down. A ticket that never reached Accept has no `pr_number` and deletes exactly as
it always did.

**Re-dispatch means spawning a ticket whose worktree — and possibly whose live agent — already
exists.** Herdr owns the panes and agents, so both survive a 10x backend restart untouched.

**The route is no longer a backend restart (verified).** Status lives in SQLite, so a restart
brings the ticket back still `in_progress` and pressing Start answers **409 `not_in_backlog`** —
the claim is the lock and it outlives the process ([operations](./operations.md)). What remains
reachable is a **spawn that fails after `agent.start` succeeded**: the handler releases the claim
back to Backlog while Herdr keeps the agent, so the next spawn hits an existing worktree *and* an
agent still registered under the same name:

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

Measured when a backend restart still reset tickets to Backlog: re-attach took 67 ms with zero
readiness polls and the commit count unchanged. The code path is unchanged; only its trigger is.

**Consequence: the reuse path has no route left through the UI, so it is untested end to end.**
The e2e suite asserts the rejection above instead. In Review → In Progress will reopen it.

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
