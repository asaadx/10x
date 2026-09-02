# Parking lot

**Node 02** · Parent: [INDEX.md](./INDEX.md)

Deliberately deferred items. Each has enough research attached that picking it up later does not
mean starting from zero. Nothing here is in scope; nothing here blocks
[the Herdr nodes](./INDEX.md).

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
