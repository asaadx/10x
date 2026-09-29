# Plug-and-play projects

> **Historical design record.** Written and built before `prototype-cloud` replaced the local
> agent runtime (Herdr: a terminal multiplexer running agents in per-ticket worktrees) with Claude
> Code cloud sessions. Its references to that runtime are left as they were, because they are the
> reasoning behind decisions that still stand (10x owns its clones; empty repos are seeded). The
> current mechanism is [`memory/cloud.md`](../memory/cloud.md); what project delete does today is in
> [`memory/architecture.md`](../memory/architecture.md).

**Status:** built. Read this for why the feature is shaped as it is, not how it is built.

Today, adding a project means leaving the board: clone the repo yourself, find its folder path,
invent a short name, know its main branch, and send all four to the server by hand. There is no
"add project" button anywhere. On a fresh install the board is five empty columns with no way
forward.

---

## 1. What you do

Click **+** next to the project picker. Fill in three things:

- **Name** — what you want to call it
- **Description** — a line or two about what it is
- **GitHub link** — paste the URL

Click **Add project**. Done.

All of it, end to end, is four steps:

1. **Check the link is real and you can read it** — one request to GitHub.
2. **Clone it** into `~/.10x/repos/<short-name>`.
3. **If the repo is brand-new and has no commits**, make the first one ([§4](#4-the-empty-repo-case)).
4. Ready.

A clone always has its `.git` folder by construction, so there is nothing to verify afterwards.
That is the whole mechanism; everything below is what the dialog shows you while it happens, and
what happens when you delete.

## 2. What happens on its own

While you are still typing, 10x looks the repo up on GitHub. If the link is wrong, the repo does
not exist, or your token cannot see it, **it tells you in the dialog** — not later, halfway through
your first ticket.

Once it resolves, everything else is worked out and shown to you rather than asked for:

| Worked out | From |
|---|---|
| Main branch | the repo's default branch |
| Name and description prefill | the repo's own name and description |
| Short name (`hearth-home`) | the repo name, shortened at word boundaries |
| Where the code lives | `~/.10x/repos/<short-name>`, downloaded for you |

The project appears in the picker immediately, marked **"downloading…"**. Big repos take a few
minutes.

**You can write tickets straight away** — filling the backlog does not need the code. Only
**Start** is disabled until the download finishes. If the download fails, the project says
**"needs attention"** with **Retry** and **Re-link** buttons, and the rest of the board keeps
working.

## 3. What it will not let you do

**Every project needs a GitHub link.** Not a restriction we picked for fun — the board's finish
line *is* GitHub. Accept pushes the branch and opens a pull request. With nowhere to push, a
ticket reaches In Review and sits there forever, and cannot even be archived. So a
laptop-only repo would be a road with no end, and the dialog refuses one. Same for GitLab or a
self-hosted host.

## 4. The empty-repo case

This is the one you will hit first, since you are testing with a brand-new repo.

A branch is a label pointing at a commit. A repo with no commits has no `main` yet — GitHub's page
still loads, but the branch is not real. Agents work by making a copy of `main`, so **the first
ticket you Started would fail.**

So if the repo is empty, the dialog says so and offers to make the first commit for you — a README
built from the name and description you just typed. This is exactly what GitHub's own *Add a
README* checkbox does when you create a repo; you just do not have to remember it.

You can untick it. Then you are told plainly there is nothing to branch from, and you can push a
commit yourself and come back.

## 5. Destructive and dangerous actions

Everywhere this feature can do something you cannot undo, listed so you can veto it. **None of it
ever touches GitHub** — the remote is only ever read, pushed to from a ticket, or given the one
first commit in [§5.1](#51-seeding-the-first-commit-writes-to-your-repo-).

### 5.1 Seeding the first commit writes to your repo ⚠️

This is **the only time 10x writes to your repo outside a ticket.** It commits a README and pushes
it to your main branch.

- Only ever on a repo with **zero commits** — it can never overwrite anything, because there is
  nothing there.
- Shown in the dialog, with a checkbox.
- **Ticked by default** — decided.

### 5.2 Deleting a project ends the work inside it ⚠️

**Today this is broken, and worse than it looks.** Deleting a project drops the project and its
tickets from the database and does *nothing else*: agents keep running in Herdr, working copies and
branches stay on disk, and because the ticket rows are gone, **the board cannot even report the
leftovers**. You get agents burning tokens on tickets that no longer exist, invisible to you.

Proposed instead: the dialog says exactly what will be destroyed, then destroys it.

> **3 tickets** removed from the board
> **1 running agent** stopped (jarvis-8)
> **2 working copies** and their unmerged branches deleted
> **10x's downloaded copy of the repo** deleted (812 MB — re-adding downloads it again)
> Your repo on GitHub is untouched — anything pushed or merged is safe.

**Anything committed and pushed survives. Uncommitted work in a worktree does not.**

**It refuses while a pull request is open — the same rule that already protects deleting a single
ticket.** Deleting a ticket removes its working copy *and* deletes its branch, so if a PR is open
against that branch you have just destroyed what someone is reviewing: the PR is left pointing at
a branch that no longer exists. So the board refuses — *"PR #41 is still open, merge or close it
on GitHub first"* — and you deal with the PR before deleting.

Two details of that guard worth knowing, because both are deliberate:

- **It asks GitHub live, every time**, rather than trusting the PR state it has stored. Nothing
  keeps that stored value up to date, so it is usually blank — a guard reading only the database
  would wave you through in exactly the case that matters.
- **No GitHub token means it also refuses.** It cannot prove the PR is safe to destroy, so it
  will not guess.

Applying the same rule to a whole project: if any ticket in it has an open PR, the delete is
refused until that PR is merged or closed.

### 5.3 Deleting a project removes it from the machine

Total cleanup, not an option. Nothing about the project is left behind:

| Removed | Where |
|---|---|
| Every running agent | stopped in Herdr |
| Every working copy and its branch | `~/.herdr/worktrees/<project>/` |
| The downloaded repo | `~/.10x/repos/<project>/` |
| Every ticket | the board |
| **Nothing on GitHub** | the remote is never touched |

**Two locations, not one.** Herdr does not put working copies inside the repo — verified against
live Herdr: a worktree created with `cwd: …/clone10x` landed at
`~/.herdr/worktrees/clone10x/<branch>`. Deleting only the downloaded repo would leave those
working copies behind, broken (their `.git` link points at a repo that no longer exists) and
invisible to the board.

The cost is that re-adding the project downloads it again — minutes for a large repo. Accepted:
a "delete" that quietly keeps a gigabyte around is the behaviour this feature exists to replace,
and the dialog states the size it is about to remove.

### 5.4 The short name is permanent

It goes into every branch and agent name that project ever creates (`ticket/hearth-home/1`), and
existing work already carries the old value, so it can never be changed. You get to edit it in the
dialog before it is frozen, and it is flagged when it has been shortened.

Getting it wrong means creating a new project, not renaming this one.

### 5.5 Two smaller notes

- **Re-linking** a broken project points it at a different repo. Only offered for a project in the
  "needs attention" state, because doing it to a healthy project would orphan its branches.
- **10x never touches a folder it did not create.** If something already sits where it wants to
  download, it refuses rather than overwriting. The single exception is cleaning up its *own*
  half-finished download.

## 6. A separate bug this fixes on the way past

Not part of adding a project — a pre-existing bug that this feature makes unavoidable, so it is
listed here and ships as its own ticket.

Tickets will start from the **latest** code on your main branch. Today they start from whatever
the local copy happens to have, so a ticket begun three weeks behind quietly branched off
three-week-old code. Once 10x owns the copy, nobody pulls it by hand, so this stops being
optional.

**Settled, verified against live Herdr** — one run on a clone deliberately two commits behind:

| what 10x asks for | what the agent gets |
|---|---|
| `base: "main"` — today | the **stale** commit |
| `base: "origin/main"` — the fix | the **current** commit |

That is the whole change: fetch before starting a ticket, and name the branch `origin/main`
instead of `main`. One line, no unknowns. Details in [gotchas](../memory/gotchas.md) **G7**.

Worth knowing only because a ticket may now be based on newer code than you expected.

## 7. Decisions

All settled. Nothing in this document is waiting on a decision.

**The seed commit is ticked by default.** An unusable brand-new project is the worse failure, and
the panel explaining what will be committed is impossible to miss.

**Deleting a project is total cleanup.** Agents stopped, working copies and unmerged branches
deleted, and the downloaded copy of the repo removed — the project leaves the machine entirely.
Behind the itemised list and the open-PR guard in
[§5.2](#52-deleting-a-project-ends-the-work-inside-it-). Anything pushed to GitHub survives
regardless. A "delete" that leaves agents running and a gigabyte on disk is what we have today,
and it is worse than destroying cleanly.

**An open pull request must be named, not just counted.** The refusal has to say *which* PRs are
blocking and link straight to them, with the ticket each belongs to — the fix is on GitHub, so the
dialog should take you there instead of making you go and find it. Cards already show a linked
`PR #41` with its state and diff size, so this closes the one place the information was missing:
the moment you try to delete.

**10x always downloads its own copy**, even when the repo is already somewhere on your machine.
It costs disk and buys an isolation guarantee: 10x's copy is never dirty, never on a branch you
left checked out, never mid-rebase, so your work and the agents' can never collide. It is also
the only version that behaves identically on a machine where the repo is absent, which is the
whole point of the feature.

**GitHub is checked for new commits when a ticket starts, and only then.** One check, at the one
moment it matters; it adds a second or two to Start and is always correct. Rejected: also checking
on the board's one-second poll, which would buy a *"main is 3 commits ahead"* label at the cost of
constant network traffic.

**The seed commit is authored by you.** 10x asks GitHub who your token belongs to — one request —
and uses that name and email. It is your repo's first commit and it sits at the bottom of the
history forever, so it should read like yours, not like a tool's.


## 8. How this splits into tickets

Ten tickets. Two constraints shape the order, and neither is taste:

- **The UI is built first, against mocks.** `VITE_MOCK_MODE` renders the board from
  `frontend/src/mock.ts` with no backend and no polling, so the real dialog can be built and
  argued about before an endpoint exists. That is also where the only remaining design risk is —
  every backend decision here is settled and every mechanism verified, so that work is mechanical,
  while the dialog is the part still likely to change on contact.
- **`server.ts` is serialised.** Tickets spawn concurrent agents in separate worktrees and two
  agents editing one file do not merge. `backend/src/server.ts` is 1143 lines and almost every
  slice wants a piece of it, so all of that work happens in one wave, one owner at a time.

### Wave 1 — the type, so the UI has something to compile against

**T1. Schema and type migration.**
Five columns via `addColumnIfMissing` (`description`, `owner`, `repo`, `provision_state`,
`provision_error`), extend `rowToProject`'s guard, `toProject`, and the `Project` type. Backfill
`owner`/`repo` from each existing project's `origin`; a project with no GitHub remote becomes
`failed` with a re-link message rather than silently blank.

**This wave exists only because it unblocks the UI.** `frontend/src/types.ts` re-exports the
backend's vocabulary on purpose, so a wire-format change is a compile error — which means the UI
cannot mention `provisionState` until the backend type has it. It is the smallest ticket here.

### Wave 2 — the UI, against mock data (parallel)

**T2. The dialog.**
The three-field dialog in real shadcn components: debounced lookup with its resolved/error states,
the derived panel, the editable slug, and the empty-repo panel. Plus the three icon buttons beside
the picker, with edit and delete disabled on *All projects*. Also
`createProject`/`updateProject`/`deleteProject`/`provisionProject` in `api.ts` — written against
the contract [§5](#5-destructive-and-dangerous-actions) implies, since the dialog is what decides
what the endpoint must accept.

**T3. Board states.**
Option-label suffixes, the provisioning and failure banners, the zero-projects empty state, Start
disabled while a project is not ready, and the new `mock.ts` fixtures the two tickets need — a
downloading project, a failed one, a ticket with an open PR. Shares `App.tsx` with T2; if that
conflicts in practice, merge the two rather than fighting it.

`docs/prototypes/project-setup.html` is the reference for both. It is a throwaway single file —
the point of these tickets is the same thing in the real components, judged in the real board.

**One thing mock mode does not do today: writes.** `use-board.ts:50` returns early and serves
static fixtures from `mock.ts`, so there is nothing for the dialog to submit *to*. T2 has to add a
simulated write path — a project appears as `pending`, moves to `cloning`, then `ready` after a
delay, with switchable lookup and download outcomes. Without it the dialog renders but cannot be
used, which defeats the point of building it first. The prototype already models exactly this and
is the reference.

### Wave 3 — backend pieces, deliberately no `server.ts` (parallel)

**T4. Slug derivation.**
`slugify` in `lifecycle.ts` beside `validateProjectSlug`, with the word-boundary rule and the
table in [§5.4](#54-the-short-name-is-permanent). Pure function, own tests, no callers yet.

**T5. Provisioning.**
New `provision.ts`: `PROJECTS_ROOT` env (default `$STATE_DIR/repos`), the `ls-remote` reachability
and emptiness probe, clone-or-adopt with its idempotency cases, the empty-repo seed commit, and
the `provision_state` transitions. Almost entirely a new file, so it collides with nothing.

**T6. GitHub metadata read.**
`fetchRepoMetadata(owner, repo, token)` in `github.ts` for the admission test. **Adds only** — it
does not remove `originOwnerRepo`, whose three call sites are in `server.ts` and belong to wave 4.

### Wave 4 — `server.ts`, one owner at a time (serial)

**T7. Project routes.**
`POST /projects` on the `{remote, name, description}` contract with the admission test and the new
error codes; `PATCH` immutability for `repoPath`/`owner`/`repo` with the re-link carve-out;
`POST /projects/:id/provision`; wire T5 in. This is the ticket that breaks the existing contract,
so it also updates the ten unit files that seed `INSERT INTO projects (… repo_path …)` directly,
`e2e/fixtures.ts`'s `createProject`, and all five cases in `e2e/projects.spec.ts`. Finishes green
or it is not finished.

**T8. Guards and the agent prompt.**
`409 project_not_provisioned` on spawn and plan, placed **before** the status claim so a refusal
never moves a ticket. Project name and description into `RunSpec` and `openingMessage`
([§2](#2-what-happens-on-its-own)) — reverted after real use: the description is prose the user
edits for the board, not a contract with every future agent, so it stays display-only and never
reaches `RunSpec`. Delete `originOwnerRepo` and pass `owner`/`repo` to its three call sites.

**T9. Project delete becomes total cleanup.**
The gap in [§5.2](#52-deleting-a-project-ends-the-work-inside-it-): `DELETE /projects/:id` is one
SQL statement today and leaves agents running that no row points at. Loop the per-ticket teardown
that already exists (`teardown` / `retireAgent` are already exported from `runner.ts`), close the
source workspace, remove both directories from
[§5.3](#53-deleting-a-project-removes-it-from-the-machine), and add the open-PR guard mirroring
`DELETE /tickets/:id`. Independently valuable — today's version leaks running agents whether or
not any of this ships — but it touches `server.ts`, so it lives in this wave rather than jumping
the queue.

### Anytime — unrelated to this feature

**T10. Branch off `origin/<base>` after a fetch.**
Fixes the staleness bug in [§6](#6-a-separate-bug-this-fixes-on-the-way-past). `runner.ts` only:
`git fetch --prune origin` before `worktree.create`, and `base: "origin/" + spec.base`. Already
verified against live Herdr, so it is a change plus a test, not an investigation. Touches nothing
any other ticket touches, and is worth doing regardless.

### Ordering summary

```
T1                    ← the type, so the UI compiles
  T2  T3              ← the UI, on mock data — where the design risk is
  T4  T5  T6          ← backend pieces, parallel, no server.ts
       T7 → T8 → T9   ← server.ts, serial
T10                   ← anytime, independent
```

**Shortest path to trying it on a real new repo:** T1 → T5 → T7, with T2 whenever you want to look
at it. The rest is real work but none of it blocks a first end-to-end run.

---

**Prototype:** `docs/prototypes/project-setup.html` — open it in a browser, no setup. Every state
above is clickable, and the strip at the bottom forces each one (empty repo, no access, download
failure, first run).

**Technical mechanics** are not in this document on purpose. The verified findings behind §4 and §6
live in [gotchas](../memory/gotchas.md) as **G7** and **G8**. The project-delete gap behind §5.2
was recorded in a memory node for the retired local runtime; what project delete does now is in
[architecture](../memory/architecture.md) (the HTTP surface table).
