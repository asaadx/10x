# Parking lot

**Node 02** · Parent: [INDEX.md](./INDEX.md)

Deliberately deferred items. Each has enough research attached that picking it up later does not
mean starting from zero. Nothing here is in scope; nothing here blocks
[node 01](./herdr-omp-lifecycle.md).

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

## In Review, Done, and merge policy

Out of scope until Backlog ↔ In Progress is solid. Decisions already reached, so they are not
re-litigated later:

- **A worktree is only reclaimed on merge.** A completed agent keeps its worktree (node 01 §5.0).
  Even with In Review, the *only* point at which a run's worktree is genuinely finished with is when
  the ticket is merged — because a passing review does **not** imply merge. Review can pass and more
  work can still be added to the same branch.
- **The implementation agent must be dead before a ticket reaches In Review.** In Review implies the
  run is torn down.
- **In Review starts as a manual human review**, later a fresh reviewing agent working on the same
  branch.
- **In Review → In Progress is never automatic.** That is the infinite-loop guard. Performed by
  hand, it must check for a live agent first: `agent.prompt` if one exists, `agent.start` if not.
- **Success is not verified by the app.** No commit counting or diffing; human PR review is the
  gate (node 01 §4.1).

Consequence to keep in mind: until merge exists, disk is user-managed. Completed-but-unmerged
tickets keep their worktrees indefinitely, and reconciliation only makes them visible.

---

## Open question: revisit teardown as a whole

**Deliberately unresolved.** The teardown rules were built up incrementally across several
conversations, and the pieces have not been reviewed together. Node 01 §5.0 holds the current
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

Constraints already settled and not up for renegotiation: reconciliation never deletes (§5.2);
`force: true` only ever follows an explicit user action (§5.0); a completed agent keeps its
worktree; a worktree is only truly reclaimable at merge (above).

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

This subsumes the "never point 10x at its own repo" safety rule in node 01 §9: with an explicit
project per ticket, there is no implicit default repo to fall into. Data-model consequence only —
not designed yet.
