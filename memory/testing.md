# Testing

**Node:** testing · Parent: [INDEX.md](./INDEX.md)

The two suites 10x has, what each one is for, and — the part that costs money if you get it wrong —
**which of them spawns real coding agents.** What is being tested is described in
[architecture](./architecture.md); how to reproduce a Herdr claim from scratch is in
[verification](./verification.md).

## 1. Two suites, three commands

Deliberately separate. `pnpm test` (`node --test 'src/*.test.ts'`) is the pure-unit layer and needs
nothing running. Playwright drives the real HTTP surface and the real page, and it is split into
**two projects, not one filtered run**: `pnpm e2e` (`playwright test --project=fast`) runs only
the specs known not to spawn a coding agent, and `pnpm e2e:full`
(`playwright test --project=full`) runs every spec.

**`fast` is an allow-list, and that is the whole point.** Its `testMatch` names
`projects.spec.ts`, `tickets.spec.ts` and `board.spec.ts` explicitly. A deny-list of the spawning
specs would default a newly added spec to *included*, so a spec that spawns real agents would
silently start spawning under the default `pnpm e2e`. An allow-list fails safe instead: a
forgotten new spec merely runs slower under `e2e:full` and never spawns unexpectedly.

## 2. The unit suite

**The glob matters and so do the quotes.** `node --test src` does not pick up `.ts` files —
verified: it reports `✖ src (40ms) 'test failed'`. Quote the glob so the shell hands it to Node
rather than expanding it. Current state: **118 tests, 27 suites, 0 failures**, `duration_ms` ≈ 400.

| Target | Why it is tested |
| --- | --- |
| `normalizeEvent` | Herdr emits `pane.agent_status_changed` dotted and `pane_closed` underscored. Matching either literally drops half the stream with **no error attached** — it cost this project its status pipeline once. |
| `isAgentReady` / `isSettled` | `done` and `idle` are the same underlying ready state. Accepting only `idle` broke agent reuse 100% of the time and hung for the full 60 s timeout. `interactive_ready` is the tell for a premature `agent.start` return. |
| `branchFor` / `agentNameFor` | The alignment invariant: branch lowercased with `/`→`-` must equal the agent name. If they drift, reuse, teardown and dispatch break at once. |
| agent-name budget | `ticket-` (7) + separator (1) leaves 24 of the 32-char ceiling; a 20-char slug + 4-digit number lands exactly on 32. That is *why* the slug cap is 20. |
| `validateProjectSlug` | Dots are branch-legal and agent-name-illegal, so a dotted slug fails only at spawn time, after the worktree exists. Also pins that a leading digit is legal — `10x` is this project's own name. |
| `claimTicket` | The only lock in the system: a second click loses, a mismatched `from` loses, an unknown id loses instead of throwing, bystanders are untouched, `updated_at` is bumped only on a win. Pinned on the edges the routes actually take — spawn's `todo → in_progress`, cancel's `in_progress → todo`, and the two manual Backlog/To Do moves `/status` makes — plus the rule that a **rollback restores the claim's source**, so a failed spawn lands back in To Do. Also pinned across `in_review`: a settled turn claims `in_progress → in_review`, a **second settle** finds nothing and leaves even `updated_at` alone, and a cancel cannot claim a ticket that has already moved to review — which is why an In Review card renders no Cancel. Runs against a temp DB via `mkdtempSync` and a **dynamic** import, because `db.ts` opens the database at module load and a static import would hoist above the `DB_PATH` assignment. |
| the transitions table | The state machine is data (`backend/src/transitions.ts`), so the tests are about its refusals: a pure move is allowed, a pair the machine does not have is `illegal_transition`, and a real move asked through `/status` is `transition_has_side_effects` **naming the route that owns it** — the refusal that stops a caller reaching In Progress without a worktree, a branch, a port block or an agent. Also pins that `done` is terminal, that every status appears in the machine, and — as a compile-time assertion rather than a runtime one — that the `Status` union the table restates has not drifted from `types.ts`. |
| the port pool | A wrong slot hands two live agents the same TCP port, and the symptom is an `EADDRINUSE` inside somebody's worktree rather than an error on the board. Pinned: lowest-free selection, reuse after release, exhaustion at the cap, the block arithmetic including the last slot's upper bound (4199, not 4200), and the cap coming from `MAX_PORT_SLOTS`. The persistence half additionally pins that the UNIQUE index — not the allocator — is what refuses a double assignment, and that the boot reclaim **spares an `in_review` ticket's block** while still freeing one dropped back out of a run. |
| `subscribe` `onClose` | Node emits `'close'` on a graceful hangup and `'error'` only on ECONNRESET/EPIPE, so a clean Herdr restart fired none of the registered handlers and every ticket status silently stopped updating. Pinned against a **real unix socket** (`net.createServer` in a temp dir): a far-end `end()` fires `onClose` exactly once, a caller-initiated `close()` never fires it — the flag that stops teardown triggering a pointless reopen — and an event still arrives before the close. Same **dynamic** import trick as the CAS tests, because `SOCKET_PATH` is read from the env at module load. |
| `pullRequestUpdate` | The webhook's whole decision surface, and pure, so it costs nothing to pin. Derives state from `merged` + `state` rather than `action`, so pinning **closed-but-unmerged → `closed`, not `merged`** is what stops the delete guard later reading a rejected PR as a safe one. Also pins that a missing LOC pair still yields a valid update, and that a non-`pull_request` body yields `null` instead of throwing. |
| `setPullRequestState` | Matched by `pr_url`, because PR numbers collide across repos. Pins that an unknown URL returns `false` and leaves every row untouched — a webhook for somebody else's repo is normal traffic, not an error. |
| `killDevServers` | Killing by port alone would shoot a stranger that happens to share the ticket's range, so the containment check — the process's `/proc/<pid>/cwd` must resolve inside this worktree — is the whole safety property. Pinned against **real listeners** in temp dirs: the in-worktree one is killed, the out-of-worktree one is reported in `skipped` and left **alive**. Falsifiable: drop the containment check and the stranger dies. `parseListeners` is pinned separately against captured `ss -lptnH` output, including that a Node listener reports its process name as `MainThread` — so nothing may filter on the name. |

The tests deliberately cover the three things that have actually broken — event-name normalisation,
the idle-or-done readiness predicate, and the CAS — plus the naming invariants that guard them.
Nothing tests plumbing. See [verification](./verification.md) and [gotchas](./gotchas.md).

## 3. The e2e suite

`playwright.config.ts` + `e2e/`. **`workers: 1` is correctness, not speed:** the whole suite shares
one backend, one port and one state dir. `e2e/fixtures.ts` is the contract every spec imports —
`startBoard` (server on **4310**, avoiding 4010 and the 4100-4199 dev-server pool, readiness polled
on `GET /projects`), `makeRepo`, `cleanupAll`, `requireHerdr`, plus the spawn helpers below. Every
spec calls `requireHerdr()`, the agent-free ones included: they need a live Herdr socket even though
they never start an agent.

| Spec | Project | Tests | Covers | Real agents |
| --- | --- | --- | --- | --- |
| `projects.spec.ts` | fast | 5 | registration, slug / repo / duplicate validation | none |
| `tickets.spec.ts` | fast | 4 | ticket CRUD and monotonic numbering across a delete | none |
| `board.spec.ts` | fast | 9 | the four columns and their order, empty In Review and Done, Accept/Reject button presence per column, picking up a ticket via the poll, the static asset route | none |
| `spawn.spec.ts` | full | 3 | spawn, **the automatic move to In Review** observed on a real turn, cancel | 3 |
| `teardown.spec.ts` | full | 2 | ticket delete, worktree-only delete (branch survives) | 2 |
| `resilience.spec.ts` | full | 4 | backend restart, `finished` and the review column surviving a pane close, compare-and-swap, two concurrent tickets | 5 |
| `ports.spec.ts` | full | 2 | `.env` written and git-excluded, pool exhaustion → 409, slot reused after cancel | 3 |
| `accept.spec.ts` | full | 1 | publish the branch as a PR, ticket to Done, agent retired | 1 |
| `reject.spec.ts` | full | 2 | re-prompt back to In Progress destroying nothing, empty reason → 400 | 2 |

**32 tests in all.** The three `fast` specs are **18 of them and run in ~7 s with no agent and no
model cost, so run them freely** *(verified)*. The other six specs are 14 tests and **16 real agent
spawns**, so `pnpm e2e:full` costs real model turns and is not a routine check. The automatic
In Review transition is asserted inside the existing completion test rather than in a new one,
precisely so covering it cost **zero extra spawns**.

*(Test counts verified with `playwright test --list`. The 13 spawns in the first four full specs
were measured; the 3 added by `accept`/`reject` are counted from their `spawnTicket` calls, not
yet observed on a run.)*

`accept.spec.ts` **skips itself without `GITHUB_TOKEN`**, because it pushes to `asaadx/10x-test`
and opens a real PR, then closes it in a failure-proof `finally`.

**A completion spec's teardown must be `DELETE /tickets/:id`, not `/cancel`.** Cancel claims
`in_progress → todo`, and any test that waits for a turn to finish has a ticket that already
moved itself to In Review, where cancel answers 409 — which would leave a real agent running.

**A spawn spec runs a real OMP agent, so teardown is the load-bearing part.** Every spawn is
registered with `cleanupAll` *before* its request goes out, each test tears its own spawn down at
the end, and `cleanupAll` falls back to `worktree.open`+`worktree.remove` straight at Herdr when
the backend is gone. Per-test budgets are set with `test.setTimeout`: **120 s** spawn-only,
**180 s** spawn-plus-completion, **240 s** for the two serial spawns in `ports.spec.ts`; the
config's 30 s default stays for the non-spawn specs. Measured: spawn returns in **3.5–3.9 s** and
the probe turn finishes **7–12 s** after that, against the 600 s `globalTimeout`.

Three things the suite reads outside the HTTP API, each for a reason:

- **`storedTicket`** opens the SQLite file, because `board()` derives `branch` and `agentName` when
  the columns are null — so the API reports them either way and cannot show teardown clearing them.
- **`liveAgentNames` / `liveWorktreeBranches`** ask Herdr directly, so "no agent, no worktree" is
  asserted against the source of truth rather than against our own join.
- **`restartBoard`** starts a second backend on the *same* state dir. `startBoard` would hand out a
  fresh empty database and prove nothing about a restart.

`cleanupAll` also closes each throwaway repo's implicit Herdr **source workspace** and `rmdir`s
`~/.herdr/worktrees/<repo>/`: both outlive the last ticket worktree, and each e2e run would
otherwise leave one of each behind ([reconciliation](./reconciliation.md)).

**Repos are created on `dev`, and specs pass `baseBranch: "dev"` explicitly.** `baseBranch` defaults
to `main` and is only handed to git at `worktree.create` time, so registering a project whose base
branch does not exist succeeds and fails at spawn instead. *(Verified.)*

**Herdr absent is survivable for reads and fatal for teardown.** *(Verified with
`HERDR_SOCKET_PATH` pointed at a nonexistent socket.)* The server boots, `GET /projects` and
`GET /tickets` both answer 200, and boot reconciliation only warns — every Herdr read is wrapped
and degrades. But `teardown` rethrows any `worktree.open` failure that is not `worktree_not_found`,
so `DELETE /tickets/:id` answers **500 `socket_error`**. That is why `requireHerdr` exists: without
the preflight the failure reads as a mystery, not as a missing dependency.

**What a UI spec may assert** — accessible semantics only, and the one spec that has not been
migrated to them yet — is part of the frontend's contract, in [frontend](./frontend.md).
