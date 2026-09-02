# Dashboard and Playbooks

Design for the two nav destinations that exist today only as inert buttons beside Board
(`frontend/src/components/NavBar.tsx`, `DESTINATIONS`). Nothing here is built. This document decides
shape and data sourcing so that building either one is an implementation task rather than a design
task.

**Provenance convention, borrowed from `memory/INDEX.md`:** a claim about what the code does today is
*read* (I opened the file and it says so). A claim about what a change would cost or how a user
would behave is *inferred*. The two are never blurred, because half of the dashboard's value depends
on whether a number is real or invented.

## What data actually exists

Everything below is read from `backend/src/types.ts`, the schema table in
`memory/architecture.md`, and `frontend/src/mock.ts`. This section is the constraint every dashboard
figure is judged against, so it comes first.

**Persisted on the `tickets` row, therefore available for any historical query:**

| Column | Type | Notes |
|---|---|---|
| `status` | `backlog` \| `todo` \| `in_progress` \| `in_review` \| `done` | current value only, no history |
| `finished` | integer bool | a turn settled after `working` was observed |
| `died` | integer bool | the pane exited; not the same as finished |
| `pr_state` | `open` \| `merged` \| `closed` \| null | written by the webhook receiver, derived from `merged` + `state` |
| `pr_additions`, `pr_deletions` | integer, nullable | ±LOC, straight off the `pull_request` payload, no API call |
| `pr_number`, `pr_url` | integer / text, nullable | written together by `setPullRequest` at Accept |
| `created_at`, `updated_at` | ISO text | `updated_at` is last-write-wins, see the warning below |
| `project_id`, `number`, `title`, `description` | | |
| `branch`, `agent_name`, `session_dir`, `port_slot` | nullable | |

**Resolved live on every `GET /tickets`, therefore a snapshot and never a time series:**
`agentStatus` (Herdr's string, passed through untouched), `hasWorktree`, `worktreePath`, `paneId`,
`workspaceId`, `busy`, and the `unowned` orphan list.

**Present in the response type but always `null` from the server today.** Each one carries a doc
comment in `backend/src/types.ts` saying so, and `frontend/src/mock.ts` marks its fixtures
"fixture-only":

- `startedAt` : no `started_at` column. A real value needs one write at the moment the spawn CAS wins.
- `screenshots` : no table, no capture path.
- `playbook` : no column, no write path. `null` means "predates the field", not "has no playbook".

**Per-run and deliberately not persisted:** the whole `Diagnostics` record (`startAttempts`,
`paneBusyRetries`, `startReturnedStatus`, `startReturnedReady`, `startReturnedAfterMs`,
`neededReadinessPoll`, `readinessPolls`, `readyAfterMs`, `promptAttempts`,
`promptNotReadyRetries`, `reusedExistingAgent`). It lives in the in-memory `runs` map in
`server.ts` and its type comment states that losing it on restart is correct.

Three consequences that shape every decision further down:

1. **There is no event log.** No transition history, no reject log, no run table. A ticket carries
   its *current* state and two timestamps. Any question of the form "how many times did X happen"
   is unanswerable today unless X leaves a permanent mark on the row.
2. **`updated_at` is not a transition timestamp.** `claimTicket` writes it on every status change,
   `setPullRequest` and the webhook writer touch the row too, and `PATCH /tickets/:id` writes it
   when a title is edited. So `updated_at` on a merged ticket is "the last time anything touched
   this row", which is *usually* the merge webhook and is not guaranteed to be. Treating it as a
   merge time is the single most tempting mistake available here.
3. **`died` and `finished` are re-armed by a respawn.** Step 5 of the spawn lifecycle calls
   `setRunFields(id, { finished: false, died: false })`. So a count of dead runs is a count of
   tickets *currently* showing a dead run, not a historical failure count.

---

# Page one: Dashboard

## The decision

One hero chart plus five supporting figures. The hero chart is **merged tickets per week, as
columns, with net LOC as a line on a second axis, over the last twelve weeks.** Everything else on
the page is a small tile or a short list, and nothing on the page is a gauge, a donut, or a
percentage without a denominator next to it.

**Why this hero chart.** The user needs a defensible sentence of the form "here is the impact this
had". The only two facts in the system that a sceptic cannot argue with are *a pull request merged*
and *the diff size GitHub itself reported*. Both are already recorded: `pr_state = 'merged'` and
`pr_additions`/`pr_deletions`, written by the webhook receiver from the payload with no API call
(`memory/github.md`). Anything derived from agent status, `finished`, or wall-clock durations is
softer, because a turn ending is not the ticket succeeding (`memory/agent-status.md`) and the app
deliberately never verifies success itself (`memory/parking-lot.md`).

**The one thing it needs that does not exist: a merge timestamp.** The webhook payload carries
`merged_at` (`memory/github.md` lists it alongside `additions` and `deletions`), and the receiver
currently drops it. Bucketing by week needs it. This is one nullable column and one field in the
existing writer, so it is the cheapest new capture on this page by a wide margin, and it is the only
one the hero chart cannot be built without.

### Hero chart specification

| Property | Value |
|---|---|
| Mark | Vertical columns, one per ISO week, plus one line series |
| X axis | ISO week start date, oldest on the left, last 12 weeks, empty weeks drawn as zero rather than skipped |
| Y axis (left, columns) | Count of tickets whose `pr_state = 'merged'` and whose `merged_at` falls in that week |
| Y axis (right, line) | Net LOC for the same bucket: `sum(pr_additions) - sum(pr_deletions)` |
| Column segmentation | By `project_id`, stacked, when the project filter is "All projects"; a single unsegmented column otherwise |
| Question answered at a glance | "How much work actually landed each week, and was it growing or shrinking the codebase?" |
| Empty state | Fewer than two non-zero weeks: show the figure as a single number ("3 tickets merged, +412 / -87 LOC") instead of a chart, because a two-point line implies a trend that is not there |

Drawing empty weeks as zero matters more than it looks. A single user on one host will have weeks
with nothing merged, and a chart that silently omits them turns a gap into apparent continuity.

**Deliberately not the hero:** tickets *created* per week. `created_at` is real and free, so it is
tempting, but created tickets measure typing, not impact, and putting them on the hero axis would
answer the wrong question convincingly. It belongs as a faint reference series at most, and I would
leave it off entirely.

### Supporting figures

Each row names the field it reads or the capture it needs. Nothing in this table is proposed without
one or the other.

| Figure | Question | Source | Status |
|---|---|---|---|
| Column counts, five tiles in state-machine order | "Where is everything right now?" | `status`, grouped, from `GET /tickets` | **Exists.** `COLUMNS` in `frontend/src/types.ts` already gives the order and labels |
| PR outcome mix: merged / closed unmerged / open / no PR | "Of the work I accepted, what fraction actually landed?" | `pr_state`, counting `null` as its own bucket | **Exists.** `null` genuinely means "no news about this PR", per `toPullRequestState`, so it must be a visible bucket and not folded into zero |
| Diff size distribution of merged tickets | "Am I shipping small changes or big ones?" | `pr_additions + pr_deletions` per merged ticket | **Exists.** No new capture. Render as a sorted bar list of the last N merges, not a histogram: at single-user volume a histogram has three bars |
| Needs attention | "What is stuck?" | Live: `died && !finished` (this is exactly `runFailed` in `frontend/src/lib/board.ts`), plus `agentStatus === "blocked"`, plus the `unowned` orphan list from the same response | **Exists, snapshot only.** Cannot be trended: `died`/`finished` are re-armed on respawn |
| Spawn health of live runs | "Is the readiness guard firing, and is that normal today?" | `diagnostics.paneBusyRetries`, `.readinessPolls`, `.readyAfterMs`, `.reusedExistingAgent` | **Exists for runs since boot only.** In-memory, per run, gone on restart. A *trend* of spawn timings needs new capture, see below |

### Figures worth wanting that need new capture

Listed so they are not silently proposed as if the data were there.

| Figure | Missing capture | Cost |
|---|---|---|
| Cycle time: To Do to merged | `started_at` (documented as absent in `BoardTicket`) and `merged_at` | Two nullable columns, two writes. `started_at` has a natural single write point already identified in its own doc comment: the moment the spawn CAS wins |
| Spawn timing trend, for example p50 `readyAfterMs` per week | A persisted run record. `Diagnostics` is explicitly per-attempt debugging output | A `runs` table plus a write at the end of each spawn. This is a real design change, not a column, because it makes "a run" a first-class entity the system currently does not have |
| Rework rate: rejects per accepted ticket | Nothing records a Reject. `POST /tickets/:id/reject` takes a mandatory reason and re-prompts the same agent; the reason is not stored | Either a counter column or the `runs` table above. Note `frontend/src/mock.ts` ticket `10x-6` is a ticket *about* remembering the last reject reason, so the reason has product value beyond analytics |
| Throughput by playbook | `playbook` has no column | One column, plus the Playbooks page below. Until then a playbook breakdown would be entirely fictional |
| Agent-hours or cost | Nothing measures either. Herdr owns pane lifetime, and OMP owns token spend | Out of reach without reading OMP transcripts in `session_dir`. Not proposed |
| Time in each column | No transition history | The `runs` table plus per-transition rows. This is the largest of the five and I would not build it for one user |

### Page layout

Reading order top to bottom, one column of full-width blocks, matching the board's centred
max-width container so the chrome lines up:

1. **Hero chart**, full width, roughly 280px tall.
2. **Five column-count tiles**, one row, in state-machine order.
3. **PR outcome mix** beside **diff size distribution**, two up.
4. **Needs attention**, a list, each row linking to the ticket sheet on the Board.
5. **Spawn health**, collapsed by default, labelled "since backend start" so nobody reads it as history.

Blocks 4 and 5 are lists rather than charts on purpose. Both answer "which one", and a chart answers
"how many".

**Data source.** Everything except the hero chart is derivable from the existing
`GET /tickets` response, which the board already polls every second. The hero chart needs an
aggregate over merged tickets including ones outside the current project filter, so it wants its own
endpoint. [inferred] `GET /metrics?weeks=12` returning pre-bucketed rows is the smaller change than
teaching the client to aggregate, because the client would otherwise need every ticket ever created
rather than the board's working set.

**Refresh.** The dashboard should *not* inherit the 1s poll. Merge events arrive by webhook, minutes
apart at best. Fetch on mount plus a manual refresh control. `memory/parking-lot.md` records SSE as
the eventual replacement for polling; the dashboard does not need it and should not block on it.

**Project filter.** [inferred, needs the user's call] The nav's project select currently scopes the
board. The dashboard should honour it, with the hero chart's stacking switching to a single series
when one project is selected, because a "here is the impact" number for a specific repo is the more
useful sentence.

---

# Page two: Playbooks

The user's definition, verbatim, which the whole page is built to serve:

> A single markup file (YAML) that acts like a container for agentic work. Packages the specific
> task, inputs, context, required skills, tools, user permissions, validation rules, expected
> outputs, and security boundaries. Combines flexible, agent-driven steps (for judgment) with
> predictable, deterministic steps (for standard code logic).

## Where playbooks live

**Decision: one YAML file per playbook on disk, under `$STATE_DIR/playbooks/<slug>.yaml`, not rows
in SQLite.**

| Option | For | Against |
|---|---|---|
| Files on disk | The artifact the user described *is* a file, so export is a copy and import is a paste. Diffable, git-committable, editable outside the app when the app is down. `STATE_DIR` already exists and defaults to `~/.10x` | No transactional rename, no query. Needs a directory listing on each request |
| SQLite rows | Consistent with tickets, one storage mechanism, atomic writes | Buys nothing. There is no query to run over a few dozen playbooks, and the schema would store the YAML as a text blob anyway, which is a file in a table. Round-tripping through a table risks reformatting a file whose comments and ordering are meaningful |
| Files in the project repo | Playbooks version with the code they drive | Playbooks are cross-project by nature (a `docs` playbook is not repo-specific), and 10x must never write into a project's tracked tree. Rejected |

Slug rules should copy the project-slug rule rather than inventing a second one:
`^[a-z][a-z0-9-]{0,19}$`. `memory/parking-lot.md` documents exactly how a slug that cannot become a
filename or an identifier fails late and expensively, and the same trap applies to a filename.

**Endpoints** [inferred, this is a proposal not a reading]: `GET /playbooks` (list with metadata),
`GET /playbooks/:slug` (raw text), `PUT /playbooks/:slug` (write raw text),
`POST /playbooks/:slug/duplicate`, `DELETE /playbooks/:slug`. Five routes, all boring, matching the
existing "one verb per irreversible act" rule from `memory/architecture.md`.

## The zero-dependency collision, stated plainly

`memory/architecture.md` records that `backend/package.json` has **no `dependencies` key at all**,
that this is a constraint rather than an accident, and that adding a runtime dependency is a
decision to be argued for. Node's standard library has no YAML parser.

So a YAML-native feature collides with the project's hardest architectural rule. The three ways out:

| Route | Consequence |
|---|---|
| Backend treats YAML as opaque bytes; the frontend parses and validates | Zero-dependency rule survives intact. The frontend already carries React, Vite and Tailwind, so a `yaml` dependency there is unremarkable. Cost: the *spawn path* cannot read a playbook's `skills` or `tools` to build `agent.start` args, so either the client sends the resolved fields with the spawn request, or the backend gets a parser after all |
| Accept one backend dependency for YAML | Simplest code, and it breaks the one property the architecture node says is checkable by reading a manifest |
| Backend hand-parses the flat subset it needs | No dependency, and a hand-rolled YAML subset parser is a class of bug generator. Rejected outright |

**Leaning, not a decision:** start with route one and keep every playbook field the *editor* needs on
the client. Revisit when spawn genuinely needs to read a playbook, because that is the point where
the tradeoff is real rather than hypothetical. This is listed under open questions because it is the
user's call, not mine.

## List view

**Decision: a table, not cards.** Playbooks are compared field by field before being picked, and a
card grid hides exactly the fields the comparison needs.

Per row:

| Column | Source |
|---|---|
| Name and slug | the file's `name` field, and the filename |
| Summary, one line clamped | the file's `description` field |
| Steps, as `4 agent / 2 fixed` | counted from the `steps` list by `mode` |
| Permissions, as a compact set of chips (`write`, `commit`, `network`) | the `permissions` block |
| Tickets using it | needs the `playbook` column that does not exist yet. Until then this cell reads a dash, not a zero |
| Validity | a badge from client-side validation: valid, warnings, or invalid with a count |
| Last edited | file mtime |

Row actions, matching what was asked for: **Edit** (opens the editor), **Duplicate** (opens a name
prompt pre-filled `<slug>-copy`), **Export** (downloads the file verbatim), **Delete** (guarded, see
below). Header actions: **New playbook** (from a blank template, not an empty file) and **Import**.

**Delete guard.** Deleting a playbook a ticket references should refuse and name the tickets, in the
same spirit as the existing delete guard that refuses to delete a ticket whose PR is still open
(`409 pr_open`, `memory/teardown.md`). The precedent is there; reuse the shape.

The seven slugs in the `Playbook` union (`fullstack`, `frontend`, `backend`, `database`, `devops`,
`docs`, `research`) become the seven seed files shipped on first run. Their *content* does not exist
anywhere in the repo today, which is a real gap: the union names seven profiles and defines none of
them.

## Editor

**Decision: a raw YAML code editor is the source of truth, with a read-only structural outline
beside it and validation docked underneath. A form is offered only for the flat header fields
(`name`, `description`, `model`, `timeout`).**

| Option | For | Against |
|---|---|---|
| Raw YAML only | The file is the artifact. Comments, ordering and blank lines survive byte for byte. An advanced user is never blocked by a field the form lacks | Discoverability is zero. A new playbook from scratch means knowing the schema by heart, which the template mitigates but does not solve |
| Form only | Discoverable, unambiguous, validation is per-field and immediate | A form that round-trips this definition is a schema editor: nested steps of two different kinds, arbitrary tool and permission maps, free prose. And every save reserialises, so comments and ordering are lost. That is disqualifying for a file the user will also read in a terminal |
| **Split: YAML source of truth, form for scalars, outline for navigation** | Keeps byte fidelity where it matters, gives newcomers a way in, and the outline makes a 120-line file navigable | Two editing surfaces need one model. The rule that resolves it: the form may only touch scalar values whose YAML node is known, so a form edit is a surgical single-line replacement rather than a reserialise |

The surgical-replacement rule is what makes the split honest. If the form ever needs to add,
reorder, or delete a node, it stops being a projection and becomes a serialiser, and the byte
fidelity argument collapses. Fields the form cannot express surgically simply are not in the form.

**Steps get an outline affordance, not a form.** The definition's central idea is a mix of
agent-driven and deterministic steps, so the outline should render that mix visibly: a distinct
marker per `mode`, and a count in the header. Reading "4 agent, 2 fixed" off the outline is the
fastest way to see whether a playbook is doing what its author intended.

## How validation errors surface

**Decision: three tiers, three different presentations, and a save that is never blocked.**

| Tier | Detection | Presentation |
|---|---|---|
| **Parse error** | YAML parse failure | Red gutter marker at the reported line and column, the message inline, and the outline frozen at its last good state rather than emptied. An emptied outline reads as "your file is gone" |
| **Schema violation** | Missing required key, unknown key, wrong type, bad enum value | Amber gutter marker plus a row in the problems list, each row clickable to jump to the line. Unknown keys are warnings, not errors: an unrecognised key is how a playbook written for a newer version degrades |
| **Reference error** | A named skill, tool, or validation command that does not resolve | Warning only, with the unresolved name quoted. The resolver cannot be authoritative from the browser, so this must never harden into an error |

**Saving invalid YAML is allowed. Attaching an invalid playbook to a ticket is not.** Blocking the
save is the intuitive choice and the wrong one: it traps a half-finished edit with no way out except
discarding it. The gate belongs at the point of use, where the consequence is real, which is the
same reasoning as the existing "reject rather than queue" rule in `memory/operations.md`. The list
view's validity badge is what makes an invalid draft impossible to forget.

The problems list is docked, not a toast. Toasts are wrong for a list that changes on every
keystroke.

## How a playbook relates to a ticket

**Read from the code:** `BoardTicket.playbook` is typed `Playbook | null`, a closed union of seven
slugs. Its doc comment states there is no column and no write path, so the server always sends
`null`, and `null` means the ticket predates the field rather than having no playbook. In
`frontend/src/mock.ts` most fixtures carry a real slug and at least one is left at the inherited
`null` specifically so the empty case is visible in the UI.

Three decisions follow.

**One playbook per ticket, referenced by slug, stored in a column.** The field is already singular
and nullable in the type, the board's ticket sheet already has a playbook picker as local component
state, and a many-to-many would need a join table to express something no one has asked for.

**The union has to open up.** `Playbook` as a closed union is correct today precisely because 10x
owns the vocabulary, as its own doc comment argues. The moment playbooks are user-authored files
that vocabulary belongs to the user, so the type becomes a `string` and the seven values become seed
files. That is a deliberate loss: the board loses its exhaustive option list and gains a list
fetched from `GET /playbooks`. It should be made knowingly, not discovered when a user's eighth
playbook fails to typecheck.

**The playbook body should be snapshotted at spawn, not resolved live.** [inferred] A ticket that
ran three weeks ago ran against the file as it was then. Resolving the slug at read time would
misattribute a later edit to an earlier run, which quietly poisons any per-playbook figure on the
dashboard. The cheap version is to write the resolved YAML into the run's system-prompt file, which
`memory/spawn.md` establishes already lives outside the worktree so it never pollutes the ticket's
diff. That gives an audit trail for free without a new table.

## Example playbook

Realistic for this repo: the `frontend` profile, written against the actual rules in `AGENTS.md`,
`memory/testing.md` and `memory/architecture.md`. Sections follow the user's definition in order.

```yaml
# 10x playbook. One file per profile, lives in $STATE_DIR/playbooks/.
# Referenced by slug from a ticket; snapshotted into the run's system prompt at spawn.
name: Frontend
slug: frontend
description: A React and Tailwind change inside frontend/, committed on the ticket branch.
version: 1

task:
  # The agent receives the ticket title and description through agent.prompt, never as an
  # omp positional argument: a positional arg makes OMP work during startup and races
  # Herdr's readiness detection (memory/spawn.md).
  goal: >
    Implement the ticket's change in frontend/ and commit it on the ticket's own branch.
    Stop when the change is complete and the checks below are green.
  scope:
    include:
      - frontend/src/**
      - frontend/index.html
    exclude:
      - backend/**       # a frontend ticket that edits the server is mis-filed
      - memory/**        # updated deliberately, as its own step, never as a side effect

inputs:
  - name: ticket
    from: prompt
    required: true
  - name: port_block
    from: worktree_env    # 10x writes PORT, PORT_RANGE_START and PORT_RANGE_END into .env
    required: true
    note: Read the port from .env. Never hardcode one, never bind outside the block.

context:
  read_first:
    - memory/INDEX.md     # then only the nodes the ticket touches
    - memory/frontend.md
    - AGENTS.md
  conventions:
    - Two-space indent, double quotes.
    - Nothing is located by a CSS class and no class carries state.
    - Comments state a mechanism, not an intention.

skills:
  required:
    - react
    - tailwind
  optional:
    - playwright          # only if the ticket touches e2e/

tools:
  allow:
    - read
    - edit
    - write
    - grep
    - glob
    - bash
  deny:
    - web_search          # a frontend ticket in this repo has no external unknowns

permissions:
  filesystem: write       # inside the worktree only
  network: none
  git:
    commit: true
    push: false           # a ticket agent never pushes; Accept publishes (memory/operations.md)
    branch_switch: false
  approval_mode: auto     # spawned unattended with --auto-approve

steps:
  - id: orient
    mode: agent           # judgment: which memory nodes and which files matter here
    do: >
      Read the ticket, then the context files above, then the components the ticket names.
      Do not grep the repo for something a memory node already answers.

  - id: implement
    mode: agent
    do: Make the smallest change that satisfies the ticket. Reuse the existing component patterns.

  - id: typecheck
    mode: deterministic   # standard code logic: one command, one exit code
    run: pnpm typecheck
    on_failure: fix_and_retry
    max_retries: 3

  - id: unit
    mode: deterministic
    run: pnpm test
    on_failure: fix_and_retry
    max_retries: 3

  - id: commit
    mode: deterministic
    run: git commit -am "$COMMIT_SUBJECT"
    requires: [typecheck, unit]

  - id: memory
    mode: agent
    do: >
      If you learned something durable, update the matching memory/ node in place and mark the
      claim verified or inferred. If you learned nothing durable, skip this step and say so.

validation:
  required:
    - pnpm typecheck
    - pnpm test
  forbidden:
    # Sixteen real coding agents, real money, explicit per-run human permission only.
    - pnpm e2e:full
  conditional:
    - when: touched(e2e/**)
      run: pnpm e2e       # needs a live Herdr socket and binds 4310, so never run speculatively

outputs:
  - kind: commit
    on: ticket_branch
    required: true
  - kind: summary
    format: markdown
    contains: [what_changed, why, files_touched]
  - kind: screenshots
    when: ui_visible_change
    required: false
    # NOT captured today: BoardTicket.screenshots has no table and no capture path, so this
    # section is aspirational until one exists.

security:
  boundaries:
    - Never operate outside this ticket's worktree.
    - Never target the 10x repo itself with a ticket. An agent committing here restarts the
      backend and strands every in-flight ticket (memory/operations.md).
    - Never read or echo .env values other than the port block. GITHUB_TOKEN is redacted on
      every error path in the server and must not be undone here.
    - Never delete a branch, a worktree, or a git remote.
  secrets:
    exposed: []
    redact: [GITHUB_TOKEN, WEBHOOK_10X, WEBHOOK_10X_TEST]
```

Two notes on that file, both worth keeping in mind while implementing the editor.

The `steps[].mode` field is the whole point of the format and the only field that encodes the user's
"flexible plus predictable" idea. `deterministic` steps carry a `run` and an exit code, and are
therefore machine-checkable before the agent starts. `agent` steps carry prose. A validator can
enforce that distinction (`run` requires `mode: deterministic`, `do` requires `mode: agent`), and
that single rule catches the most likely authoring mistake.

`outputs[].kind: screenshots` is in the example because the definition asks for expected outputs, and
it is annotated in place because nothing captures screenshots today. A playbook that promises an
output the system cannot produce is worse than one that omits it, so the editor should surface that
annotation as a reference warning rather than letting it read as working configuration.

---

# Open questions

These need the user's decision. None is resolved above, and each one changes what gets built.

**Dashboard**

1. **Add `merged_at`?** The hero chart cannot be bucketed by time without it. It is one nullable
   column and one field in the existing webhook writer. Yes or no decides whether the hero chart is
   the chart specified above or a static total.
2. **What about tickets merged before that column exists?** Options: leave them out of the chart,
   approximate them from `updated_at` with a visible "approximate" marker, or backfill once from the
   GitHub API. Backfilling is a one-off script and a token, not a feature.
3. **Is `started_at` worth its write?** It unlocks cycle time and nothing else. Its doc comment
   already names the exact write point.
4. **Does "a run" become a first-class record?** A `runs` table is the single unlock for spawn-timing
   trends, reject counts, and dead-run history: three of the four missing figures. It is also the
   largest change proposed in this document, and it contradicts the current, deliberate decision
   that per-run diagnostics are debugging output rather than state. This is the biggest call on the
   page.
5. **Does the dashboard obey the nav project filter, or always aggregate across projects?** Affects
   whether the hero chart stacks by project or shows a single series.
6. **What period?** Twelve weeks is proposed. A rolling quarter, a calendar month, or all-time are
   equally defensible and change the axis and the empty-state rule.
7. **Does the "needs attention" list belong here at all**, given the board already shows a dead run
   and a blocked agent on the card itself? It may be duplication rather than a dashboard.

**Playbooks**

8. **Where does YAML get parsed, and is a backend runtime dependency acceptable?** This is the only
   question on the page that touches an architectural invariant. Deciding "frontend only" is free
   today and has to be revisited the first time spawn needs to read a playbook field.
9. **Does `Playbook` stop being a closed union?** User-authored playbooks require it. Keeping the
   union means playbooks are seven fixed profiles whose bodies are editable, which is a smaller and
   entirely reasonable feature, but it is a different feature.
10. **Do the seven seed playbooks get authored as part of this work, and by whom?** Their content
    does not exist anywhere in the repo. An empty Playbooks page with seven empty files is worse
    than no page.
11. **Are playbooks global or per project?** Global is assumed above. Per project needs a
    `project_id` in the path or the file, and it interacts with the multi-repo direction recorded in
    `memory/parking-lot.md`.
12. **Does an invalid playbook block a spawn?** The proposal is yes, gate at use, allow the draft to
    save. The alternative is spawning anyway with the invalid sections ignored, which is defensible
    if the invalid part is a warning-tier reference error.
13. **Is the YAML schema versioned?** `version: 1` sits in the example. Without a stated policy for
    an unknown version, an old playbook and a new binary have no defined behaviour.
14. **Export scope:** a single file download only, or multi-select into a bundle? Single file is
    assumed above. A bundle needs an archive format and a matching importer.
15. **Is editing a playbook that a live run is using allowed?** The snapshot-at-spawn proposal makes
    it harmless, but only if that snapshot is actually taken. Without it, an edit mid-run changes
    nothing for the running agent and everything for the record of what it ran.
