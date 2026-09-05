# Parking lot

**Node 02** · Parent: [INDEX.md](./INDEX.md)

Deliberately deferred items. Each has enough research attached that picking it up later does not
mean starting from zero. Nothing here is in scope; nothing here blocks
[the Herdr nodes](./INDEX.md).

---

## Enforcing screenshot capture

**Decision: not built. The `visual-diff` skill (`skills/visual-diff/SKILL.md`) requires the
agent to say, in its own turn summary, either that it captured or exactly why it skipped — and
that is the whole enforcement.** Nothing server-side checks that a UI ticket actually produced
a `screenshot_before`/`screenshot_after` pair.

**Why this is feature creep, not a gap.** Per [agent-status](./agent-status.md), a settled turn
and a deliberate skip are indistinguishable to anything watching from outside — the only place
that distinction exists at all is the agent's own words. Two enforcement shapes would need
building to close that gap for real, and neither is free:

- **A board flag** — a card whose ticket touches UI (however that would be decided:
  `playbook`, a path glob over the diff, something else) but carries no screenshots renders a
  warning chip. Needs a definition of "this ticket touches UI" that does not exist anywhere in
  this codebase today — `playbook` is the closest candidate and it is self-reported at ticket
  creation, not inferred from the diff.
- **A gate on Accept** — refuse `POST /tickets/:id/accept` for a UI ticket with no screenshots,
  the same shape as the live PR-state guard DELETE and Archive already run. Harder to get
  right than it looks: it would have to distinguish "this ticket never needed one" from "the
  agent forgot", which is exactly the distinguishing problem above, now blocking a real
  publish rather than just a display.

Both need the same missing primitive — a reliable "does this ticket change the UI" signal —
before either is worth building. Until one exists, a ticket that forgets to capture (or
silently skips without saying so) simply shows an honest `null`/`null` pair in the sheet, which
`ScreenshotPane`'s placeholder already renders without lying.

---

## e2e model policy: cheap and often

**Decision.** The e2e suite spawns agents on a cheap model at low reasoning effort — Haiku, named
as the example — not on whatever model a human would pick for real ticket work.

**Why this does not weaken the suite.** The specs assert mechanism, not the quality of the code an
agent writes. `expectZeroResidue` checks five independent things on teardown: the worktree
directory is gone (`existsSync(run.worktreePath)`), the branch is absent from both
`worktree.list` and `git rev-parse --verify`, the agent name is gone from `agent.list`, and the
OMP transcript directory is gone from disk (verified: `e2e/fixtures.ts:534-540`). `spawnTicket`
asserts the spawn call itself returns 200 and then reads `branch`, `agentName`, `worktreePath`,
`paneId`, and `workspaceId` straight back off the API response and the stored ticket row
(verified: `e2e/fixtures.ts:436-455`) — existence and identity of state, not content. The one place
a probe agent's own output is checked is `PROBE_DESCRIPTION`, and even that is a fixed
two-character file write asserted for presence, not a judgment call on code quality (verified:
`e2e/fixtures.ts:208-213`). None of this cares whether the model reasoned well; it cares whether a
worktree, a branch, a pane, and an event exist or do not.

**The tradeoff.** A weaker model takes more turns to reach the same file write, so wall-clock time
per run goes up (inferred — no timing comparison between models exists in this repo; the only
measurement present is `spawnTicket`'s own `elapsedMs` log line at `e2e/fixtures.ts:442`, which
records duration but never varies model to compare). Cost per run goes down, because the named
alternative (Haiku) prices far below the models a human would choose for real ticket work
(inferred — no pricing figures are recorded in this repo).

**Why the tradeoff is worth taking.** Cost, not correctness, is what decides whether the suite
gets run at all. `pnpm e2e:full` is the allow-listed run that exercises every real-agent spec
(verified: `playwright.config.ts:28-31`, matching every `*.spec.ts`), and it spawns real paid
agents on every run (verified: `e2e/fixtures.ts:198-200`, "Everything below drives REAL agents in
REAL worktrees"). That cost is treated as prohibitive today, so the suite is not run. A suite too
expensive to run often is not protecting anything; it is inert. A cheap run is what turns it back
into something exercised regularly rather than avoided.

**Where the change would go, and its status.** `backend/src/runner.ts:152-158` is the single
`agent.start` call the e2e fixtures drive indirectly through `POST /tickets/:id/spawn` — `kind:
"omp"`, with an `args` array currently holding only `["--append-system-prompt", promptFile,
"--auto-approve"]` (verified: `backend/src/runner.ts:152-158`). A model and effort flag would be
additional entries in that same `args` array. The exact `omp` flag names for model selection and
reasoning effort are **unconfirmed** — a repo-wide search turns up no `--model`, no
`reasoning-effort`, and no existing reference to Haiku or any other model name anywhere in this
repo (verified: grep across the whole tree found nothing). This is not yet implemented; no file
under `e2e/` or `backend/src/` has been changed to add it.

---

## Remote access to the Herdr session from another machine

**Goal:** sit at another machine, enter the live Herdr session on the host, steer a running agent,
and have full terminal access — skills, slash commands, shell.

**Conclusion: `/collab` is the wrong tool. `herdr --remote` already does this, and it is a built-in
flag, not a feature we build.** "Herdr first" is achievable with zero application work.

**Status: unverified.** This is read from Herdr's and OMP's own documentation, not exercised. The
`/collab` limitation below is a documented guest-permission list; the `--remote` claim is a
documented flag. Neither has been run. Test before relying on it.

### Why `/collab` is the wrong tool

`/collab` is an **OMP** feature, unrelated to Herdr. It shares one running OMP session with other
OMP instances or a browser over an encrypted relay. Guests render that session natively and *can*
prompt and interrupt the agent.

But guests are deliberately limited. Per OMP's own docs, everything that mutates the host session
or machine is **host-only**: `bash (!)`, `python ($)`, `/model`, `/compact`, `/resume`, `/branch`,
and **skills**. Guests get a small allowlist (`/dump`, `/export`, `/copy`, `/help`, `/theme`,
`/settings`, `/leave`, `/exit`).

So `/collab` gives one shared agent transcript, not a terminal. It cannot satisfy "access to all the
stuff in terminal like skills and commands". Also: it shares a *single OMP session*, whereas the
goal is the *whole Herdr session* with every ticket's pane.

### What to use instead

Two paths, both stock Herdr:

| Path | Command | Notes |
|---|---|---|
| Thin client over SSH | `herdr --remote <host>` | Local client, remote server. Bridges local desktop features such as clipboard image paste. |
| Plain SSH, then run Herdr | `ssh host` then `herdr` | Behaves like tmux. Simplest. Works from a phone SSH client; the TUI adapts to narrow screens. |

Either gives the real session: every workspace, every ticket pane, every agent, with full shell,
skills, and slash commands, because the panes run on the host machine. Tailscale already provides
the SSH reachability.

For repeat use, add the host to `~/.ssh/config` and attach with `herdr --remote <alias>`.

Related flags not yet explored: `--remote-keybindings <local|server>` (default `local`),
`--handoff` (opt into live handoff on remote attach), `herdr session attach <name>` for named
sessions.

### Unexplained: prompt breakage with two clients attached

**Observed once, cause unknown.** `--remote` was attached from a second machine; later, sending a
prompt from the host machine "broke". Not reproduced, not diagnosed.

Herdr is a multiplexer and is designed for multiple attached clients, so simultaneous attach is not
inherently unsupported. Candidate explanations, none confirmed:

- Two clients driving keyboard input into the same pane, interleaving bytes mid-prompt.
- Live handoff: the server advertises a `live_handoff` capability, and `--handoff` exists for both
  update and remote attach. A second attach may have moved client ownership.
- `agent attach <target> --takeover` implies explicit contention handling for agent panes, which
  suggests attaching to a pane that already has an owner is a real state.
- Keybinding resolution differing between `local` and `server` modes, so keys were interpreted by
  the wrong side.

**Leading candidate, from the 0.8.2 changelog.** Several `--remote` defects present in 0.8.0 are
fixed in 0.8.2, and one matches the setup exactly — the second machine is a MacBook:

- *"macOS `herdr --remote` clients now keep the accepted bridge socket blocking, preventing an
  immediate disconnect after the protocol handshake."* (#2478) — a macOS remote client dropping
  right after connecting would look exactly like "it broke".
- *"Closing a terminal running `herdr --remote` no longer produces a local client core dump while
  the remote session stays alive."* (#2424)
- *"Remote clients now continue redrawing at very large terminal sizes instead of freezing when a
  full ANSI frame exceeds the transport limit."* (#2670)

So retest `--remote` **after upgrading both machines to 0.8.2** before investigating further. The
bug may simply not exist any more.

**If this recurs, capture before theorising:** `herdr status server`, `herdr status client`,
`herdr agent get <target>`, and the client/server logs in `~/.config/herdr/`
(`herdr-client.log`, `herdr-server.log`).

Practical implication for 10x: the app drives Herdr through the **socket API**, not through
keyboard input to a client, so this class of problem should not affect ticket dispatch. It affects
the human sitting at a second machine. Unverified.

---

## Preview, merge policy, and a reviewing agent

**Accept, Reject and Done are built** — the column, both endpoints and the buttons
([operations](./operations.md)). The decisions behind them, kept because they are what stops the
design being re-litigated wrongly:

- **A worktree is only reclaimed on merge.** A completed agent keeps its worktree ([teardown](./teardown.md)).
  The *only* point at which a run's worktree is genuinely finished with is when the ticket is
  merged — because a passing review does **not** imply merge. Review can pass and more work can
  still be added to the same branch. Accept therefore keeps both the worktree and the branch.
- **The implementation agent stays ALIVE through In Review**, and the ticket keeps its port block.
  Reject re-prompts that same agent so it has the full context of what it already did. The agent
  and its transcript are killed at Accept, and the port slot is released there.
- **Reject bounces to In Progress, not Backlog.** The branch, worktree and agent all still exist,
  so a Backlog respawn would collide with an existing branch and a taken agent name, and
  `worktree.create` is not idempotent.
- **Accept opens a PR and never merges.** Human review on GitHub is the quality gate, so the app
  never handles a merge conflict — it only *reads* mergeability to display it.
- **In Review → In Progress is never automatic.** That is the infinite-loop guard, and it is what
  Reject performs by hand.
- **Success is not verified by the app.** No commit counting or diffing; human PR review is the
  gate ([agent status](./agent-status.md)).

Still deferred:

- **Preview** — needs per-project run config (command, port count, path to open), absent by
  default so the button hides. A backend-only project has no meaningful preview, so do not
  generalise for projects that do not exist yet. A preview started from review binds the ticket's
  own port range.
- **A fresh reviewing agent** spawned at In Review to check the code on the same branch. In Review
  is a manual human review today.

Disk stays user-managed until merge handling exists: accepted-but-unmerged tickets keep their
worktrees indefinitely and reconciliation only makes them visible.

---

## Open question: revisit teardown as a whole

**Deliberately unresolved.** The teardown rules were built up incrementally across several
conversations, and the pieces have not been reviewed together. The [teardown](./teardown.md) trigger matrix holds the current
provisional answer; treat it as provisional until this is done in one sitting.

The question to answer, in one pass with full context:

> **What are all the cases where teardown happens, and what level of teardown does each one want?**

Enumerate the triggers, then decide the depth independently for each. Depth is not binary — these
are separate dials:

| Dial | Options |
|---|---|
| Agent process | leave running · stop it |
| Herdr pane / workspace | leave open · close |
| Worktree directory | keep · remove clean-only · force-remove |
| Branch | keep · delete |
| OMP session transcript | keep · delete |

Known triggers to cover: cancel (In Progress → Backlog), ticket deletion, project deletion, agent
finished, agent crashed, pane exited, Herdr server restart, 10x backend restart, user closed the tab
manually, reconciliation found an unowned worktree, and re-dispatch of a ticket that already has a
worktree.

Constraints already settled and not up for renegotiation: reconciliation never deletes ([reconciliation](./reconciliation.md));
`force: true` only ever follows an explicit user action ([teardown](./teardown.md)); a completed agent keeps its
worktree; a worktree is only truly reclaimable at merge (above).

---

## Open question: what Plan actually does

**Settled.** The state machine has `Backlog → To Do`, triggered by a click labelled Plan, and it
is not built on either side (verified: `memory/operations.md:19`). `backlog` holds raw ideas and
`todo` holds work that is ready to start (verified: `memory/operations.md:11`). The frontend
already renders a `Plan` button on every `backlog` card, wired to nothing (verified:
`frontend/src/components/TicketCard.tsx:212-218`).

**Two candidate readings, neither decided:**

- **Plan as a bare status flip.** One conditional `UPDATE`, claimed first like every other
  transition — the same pattern `/spawn` uses today: "Claim first, work second. No `await`
  between the check and the write" (verified: `backend/src/server.ts:325-328`). Cheap: a route
  that calls `claimTicket(id, "backlog", "todo")` and returns. Under this reading, To Do becomes
  a purely human triage step — a ticket moves there unedited.
- **Plan as spawning a real planning agent.** The agent turns an idea into an implementable
  ticket — writing a task breakdown and acceptance criteria onto the ticket — before flipping it
  to `todo`. This is what the state machine table currently implies (verified:
  `memory/operations.md:19`, "a planning agent turns an idea into an implementable ticket") and
  what the button's own tooltip already promises (verified:
  `frontend/src/components/TicketCard.tsx:214`, "Talks the idea through with a planning agent
  until it is ready to start."). This reading re-opens everything the four-call spawn sequence
  already had to answer for Start ([spawn](./spawn.md)): whether a planning agent needs its own
  worktree, whether it needs a port block, and what happens to the ticket if planning fails
  partway through.

**The mechanism question is separate from the semantics.** The route regex admits only
`/spawn`, `/cancel`, `/worktree`, `/focus`, `/accept`, `/reject` as ticket sub-paths, plus a bare
`PATCH /tickets/:id` (verified: `backend/src/server.ts:246`), and that `PATCH` rejects `status`
outright as an immutable field (verified: `IMMUTABLE`, `backend/src/ticket-store.ts:168-177`).
So Plan needs either a new route or a relaxation of the `PATCH` guard. **Inferred:** the guard
exists so that every status move goes through the compare-and-swap in `claimTicket`, so that two
concurrent requests cannot both win a transition — a `PATCH` that could write `status` freely
would be a way around that invariant. The code does not say this in so many words; it follows
from reading the CAS comment on `/spawn` (`backend/src/server.ts:325-328`) next to the
immutability list that deliberately excludes `status` from ordinary writes.

**The coupling.** Whatever Plan becomes, four places have to agree on it, and they do not today:

- The insert default — every new ticket is created with status `'backlog'`, hardcoded into the
  prepared statement (verified: `INSERT_TICKET`, `backend/src/ticket-store.ts:118-123`).
- The spawn claim's from-state — `/spawn` claims `backlog → in_progress` (verified:
  `backend/src/server.ts:326`), skipping `todo` entirely.
- The route regex — no `/plan` action exists to move a ticket out of `backlog` any other way
  (verified: `backend/src/server.ts:246`).
- The board's Start guard — the frontend renders Start only when `ticket.status === "todo"`
  (verified: `frontend/src/components/TicketCard.tsx:220-226`).

Until this is resolved, **every Start on the board answers 409**: the board offers Start only on
`todo`, but spawn claims from `backlog`, and nothing today ever moves a ticket into `todo` — so a
card that reached `todo` by any future Plan implementation is the only card Start could ever work
on, and no such path exists yet. `memory/operations.md:13-15` already flags this as the
outstanding backend half.

**Related sub-question:** should `POST /tickets` accept a status. The board's "New ticket"
button is offered from both the Backlog and the To Do column (verified:
`frontend/src/App.tsx:55-56`, `onNewTicket` passed when `status === "backlog" || status ===
"todo"`), but the create path narrows only `projectId`, `title`, `description` — there is no
status field to accept (verified: `TicketInput`, `backend/src/ticket-store.ts:149-153`), and
`INSERT_TICKET` always writes `'backlog'` regardless of which column's button opened the sheet
(verified: `backend/src/ticket-store.ts:118-123`). Creating straight into `todo` would skip
planning entirely. This may be intended: a ticket specified well enough at creation time needs no
planning step, so the To Do composer landing in `backlog` anyway could be a gap or could be
correct — not decided here.

---

## Push board updates with SSE instead of polling

The harness UI polls `GET /tickets` every second. That is a placeholder, and the freshness
already exists server-side: the backend holds a long-lived Herdr subscription and learns of
`pane.agent_status_changed` the instant it fires. Only the browser is behind.

Server-Sent Events forwards it with no library — a response you simply never end:

```ts
// GET /tickets/stream
res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
clients.add(res);
req.on("close", () => clients.delete(res));

// on each Herdr event that changes a ticket:
for (const res of clients) res.write(`data: ${JSON.stringify(board())}\n\n`);
```

```js
new EventSource("/tickets/stream").onmessage = (e) => draw(JSON.parse(e.data));
```

Roughly 30 lines. Gotchas: send a periodic `:heartbeat\n\n` so idle connections are not
dropped, and delete closed clients from the set. `EventSource` reconnects by itself.

Gain: instant updates instead of up-to-1s stale, and no traffic while idle. Do it when the
real UI replaces the harness UI, not before.

---

## Webhook receiver: built, and no longer a correctness dependency

`POST /webhooks/github` is fully built ([github](./github.md)) and updates a ticket the instant
`gh webhook forward` happens to be running against it. Nothing in `package.json` starts it:
`gh webhook forward --repo=… --events=pull_request --url=…` is a foreground, ephemeral-subscription
CLI tool bound to exactly one `--repo`, architecturally unable to cover "every project this board
might have registered" without one long-running process per project — and events that occur while
it is down are lost, not queued ([github](./github.md)), so even a parked instance would silently
stop being a source of truth the moment it exited.

**Why this is no longer a correctness gap.** `board()` reconciles PR state on read (`server.ts`,
`reconcilePullRequests`): every ticket whose PR is non-terminal gets a live
`GET /repos/{owner}/{repo}/pulls/{n}` at most once per `PR_CHECK_TTL_MS` (60s, matching
[github](./github.md)'s own "a ~60s cache is enough"), independent of whether any webhook was
ever wired up. A ticket accepted long before this landed, sitting with `prState: null` forever
because no webhook ever reached it, backfills itself on the next board read — no manual fix, no
webhook required.

**Tradeoff accepted.** A merge or close that happens between two live checks for the same ticket
is invisible for up to the 60s TTL — fine for a single-user board polled once a second by a
human, not fine if this ever needs push-exact notifications (driving an automated action off "PR
just merged", say). If that need appears, wiring one `gh webhook forward` per registered project,
or moving to a real endpoint with HMAC per [github](./github.md), closes the gap to
near-real-time. Not needed for correctness today — only for latency.

---

## Validate the project slug at creation time

Agent names must match `[a-z][a-z0-9_-]{0,31}` — 32 characters total. `agentNameFor` spends
`ticket-` plus a separator, leaving **24 characters for project + number**: roughly a 20-character
project slug alongside a 4-digit ticket number.

Two failure modes, both currently undetected until spawn:

- **Too long.** A 27-character project name overflows the ceiling.
- **Charset mismatch.** Branch names permit dots, agent names do not. A project slugged `my.app`
  yields a valid branch `ticket/my.app/1` and an **invalid** agent name `ticket-my.app-1`, so
  `worktree.create` succeeds and `agent.start` then fails.

Either way the error lands at step 3 of the spawn sequence, *after* the worktree exists, leaving
an orphaned worktree for what is really a naming mistake.

Fix: validate once when a project is created — `^[a-z][a-z0-9-]{0,19}$` — rather than discovering
it mid-spawn. Three lines, and the error appears where it belongs.

---

## Databases, hosting, and multi-machine access

Raised and explicitly deferred. Context captured so the discussion does not restart from scratch:

- The frontend should be reachable from the host machine and at least one other machine.
- Tailscale is already set up on both machines, but relying on it is not preferred.
- Simplest option available today: run the frontend on the host, reach it over the tailnet.
- Open questions: is there value in deploying the frontend rather than serving it locally, and
  should the ticket database be hosted rather than local?
- Leaning recorded at the time: the ticket database probably should not live only on a local
  machine.

Not answered. Do not design this until Backlog ↔ In Progress works.

---

## Projects (multi-repo)

The eventual vision is an engineering board spanning **several projects at once**, with a board
filter for one project or all. That makes a **project** a first-class concept, not a config value:

- A project is at minimum a git repo path plus a default base branch.
- A ticket belongs to a project; dispatch uses that project's repo.
- The board filters tickets by project, or shows all.

This subsumes the "never point 10x at its own repo" safety rule in [operations](./operations.md): with an explicit
project per ticket, there is no implicit default repo to fall into. Data-model consequence only —
not designed yet.

---

## Deriving `pr_url` from `owner/repo` instead of storing it

`pr_url` (`https://github.com/{owner}/{repo}/pull/{number}`) is stored on the ticket rather than
derived, because `Project` records `repoPath` (a local filesystem path) and never `owner/repo` —
the same folder-path-versus-GitHub-repo conflation flagged in [Projects](#projects-multi-repo)
above. Deriving it would need owner/repo resolved and exposed through the projects API first.
Preferred direction: an owner in `.env` plus the repo name from the project. Design smell with a
direction, not a bug. Deferred, low priority.

## The planning agent behind Plan

**Scheduled: before the demo video.** Not deferred indefinitely like the rest of this file.

**The columns exist** ([operations](./operations.md)): `backlog` holds raw ideas, `todo` holds
work that is ready to start, and the only move between them is **Plan**, the only action a
Backlog card offers. `todo` was added as a new status rather than renaming `backlog`, because a
created ticket *is* a raw idea — the existing insert default lands in the right column and no row
needed migrating.

Two halves are outstanding, and both are backend:

- **The server still claims `backlog → in_progress` for a spawn** and returns a cancelled ticket
  to `backlog`. Both should point at `todo`. The Start button is frontend-only today, so nothing
  is inconsistent at runtime yet — it becomes wrong the moment the board is wired.
- **Plan does nothing.** The button renders and has no handler.

**Plan spawns a planning agent** — Opus — that the user can talk to, to turn an idea into an
implementable ticket: the approach, the blast radius, every file that will be touched, or the
findings if the ticket is an investigation. The point is that **a ticket arriving in In Progress
has no guesswork left in it** — the implementation agent inherits a plan rather than deriving one.

Design questions to settle before building, none of them answered yet:

- **Where does the plan go?** It has to be persisted on the ticket and fed to the implementation
  agent's prompt later, or the whole point is lost. A new column, or appended to `description`?
- **Does a planning agent need a worktree?** It reads the repo but writes no code. A worktree gives
  it something to read; a branch may be pointless.
- **Does it need a port block?** It runs no dev server. If not, planning agents do not consume
  slots from the pool, which matters given the cap.
- **Model selection per spawn.** `spawn()` has one shape today and no notion of which model to
  run. Opus-for-planning is the first case that needs one.
- **What ends a planning turn?** The `in_progress → in_review` move rides the agent's turn end. A
  planning conversation is meant to be interactive, so the same rule would advance the card the
  moment the agent first stops talking.

**An Archive column was considered and is NOT recommended.** Every other column is a stage with
actions; Archive is storage, and nothing happens in it. The real need — Done accumulating — is a
filtering problem, not a pipeline one, and is better served by an `archived` flag and a toggle than
by permanent board real estate. Six columns also squeeze card width at this density, and an empty
sixth column is dead space on camera. Revisit only when Done actually becomes unusable, and then as
a filter first.

---

## Open question: steering across machines

Steering is `agent.focus` on the local host today, wired behind a Local/Remote toggle in the top
bar. Local mode calls `agent.focus` directly. Remote mode instead copies `herdr --remote
<ssh-target>` to the clipboard for the user to paste into their own terminal. This is a stopgap: it
works, and it leaves two problems unsolved.

### Problem one: focus mutates agent state

**Verified, from `herdr --skill`:** focusing a tab, or targeting a pane or agent with a focus
command, marks it seen, and `done` is the same underlying idle state as `idle` but with work
unseen. So clicking Steer flips a `done` agent to `idle`.

**Inferred consequence for the board:** any automatic transition the board keys off `done` can be
defeated by a human focusing the pane, and the board must not treat `done` as a durable fact once a
focus command has been issued against that pane.

### Problem two: the UI/UX cost

Neither mode is one click from the board. Local mode still requires tabbing into the terminal.
Remote mode requires pasting a command and then SSHing in by hand.

### Options explored

- **Render the pane in the board.** `pane.read` takes `pane_id`, `lines`, `format`, `source`, and
  `strip_ansi`, and returns `text` with a `revision`; `format` is `text` or `ansi`; `source` is
  `visible`, `recent`, `recent_unwrapped`, or `detection`. `pane.send_text` takes `pane_id` and
  `text`, and `pane.send_keys` takes `pane_id` and `keys`. Together these are a complete read/write
  loop, so a browser terminal is buildable with no new backend capability. Capability is preserved
  because the text goes to the real pane running the real agent, so skills, slash commands, and
  shell access are untouched. What is lost is fidelity: snapshots rather than a live stream, and a
  real terminal emulator would be needed to render `ansi` correctly. Safety point: approval prompts
  read through a lossy view risk approving something unread.
- **Local/remote detection.** Two code paths, and a web page cannot drive the user's terminal
  without the same locally installed helper a deeplink would need.
- **Deeplinking.** Needs a registered URI scheme plus a per-OS helper install.
- **omp's `/collab`.** Couples steering to the `omp` agent kind rather than to Herdr, so it does
  not generalise to other agent kinds. Unverified.

**Open question: whether to build the in-board terminal.** Judged too large for the current
budget, not rejected on merit.
