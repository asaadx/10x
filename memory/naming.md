# Identifiers: slugs, ticket ids, branches and sessions

**Node:** naming · Parent: [INDEX.md](./INDEX.md)

## Project slugs are tight on purpose

A project's `id` is its **slug**: `PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,19}$/` in
`backend/src/lifecycle.ts` — lowercase letters, digits and `-`, 1–20 characters, frozen at
creation (`PATCH /projects/:id` refuses to change it).

The slug is the first half of every ticket id, and a ticket id ends up in three places that each
punish a loose character set (verified, `lifecycle.ts` header):

- a **branch name** — `claude/10x-<id>`, handed to git;
- a **directory name** — the Preview checkout `$STATE_DIR/previews/<id>`;
- a **SQL literal an agent types by hand** — `tenx_sql "… WHERE id = ? AND run_token = ?" <id> <token>`.

**A leading digit is allowed**: `10x`, this project's own name, must be a valid slug. **Dots and
underscores are excluded** so `-` is the one separator and an id never needs quoting.

The 20-character cap and the character set predate cloud sessions — they were set by the
previous agent runtime's naming rules — and are **kept rather than relaxed** because every existing
project id already satisfies them, and loosening a rule later is free while tightening one strands
existing rows.

**Deriving a default.** `deriveProjectSlug(repoName)` lowercases, collapses anything outside
`[a-z0-9]` to `-`, trims `-`, and if the result is over 20 characters **drops whole trailing
words** (cuts at the last `-` inside the budget) rather than slicing mid-word —
`hearth-home-automation` → `hearth-home`, not `hearth-home-automati`. A name with no usable
character derives `""`, which `validateProjectSlug` then rejects. Pinned in `lifecycle.test.ts`.

## Ticket ids are `<slug>-<number>`, and the number is never reused

`id` is literally `<project_id>-<number>` (e.g. `10x-7`), with `UNIQUE (project_id, number)`.
The number comes from the project's **monotonic `next_number` counter**, advanced in the same
`batch` as the insert — never `MAX(number)+1`. Deleting the highest ticket would otherwise hand its
number to the next one, and that ticket would inherit the dead ticket's `claude/10x-<id>` branch
on GitHub, its open PR (if any), and its identity in any cloud session still writing to that id.
Details in [architecture](./architecture.md).

## Branches: requested versus reported

- **Requested:** `sessionBranchFor(id)` = **`claude/10x-<id>`** (`backend/src/prompts.ts`), put
  into the implementation prompt as `{{branch}}`. `claude/`-prefixed because that is what cloud
  sessions reliably push (`docs/prototype-cloud.md`) *(inferred from the docs; not observed on a
  real session)*. A plan session has no branch.
- **Reported:** the agent writes the branch it **actually** pushed into `tickets.branch`.
  Everything downstream reads that column — Accept's fallback `openPullRequest`, and Preview's
  fetch — so the requested name is a request, not a derivation anything relies on.
- **Untrusted.** Because the agent writes it, Preview refuses a `branch` that fails
  `isSafeBranch` (`preview.ts`: `^[A-Za-z0-9._/][A-Za-z0-9._/-]*$`, no `..`, no `.lock`) before
  it reaches git's argv.
- Cancel clears `branch` on the row; the branch itself stays on GitHub (nothing in 10x deletes
  one).

The fake driver writes `branch = claude/10x-<id>` when it plays an implementation agent, and
tells impl from plan by whether the opening message contains `claude/10x-` ([cloud](./cloud.md)).

## Session ids

`claude --cloud` prints `https://claude.ai/code/<id>`, and ids come in two shapes, `session_…`
and `cse_…`; `parseSessionUrl` takes the **first** match of
`https://claude\.ai/code/(session_\w+|cse_\w+)` anywhere in stdout. Stored as `session_id` and
`session_url`; the fake driver issues `session_fake_<n>`. Opaque — never constructed, only
stored and passed back to `claude -p … --cloud <id>`.

## Preview names

| Thing | Name | Why |
| --- | --- | --- |
| Fetched ref | `refs/10x/preview/<id>` in the project's clone | per ticket, so two Previews of one project never race on the single `FETCH_HEAD` |
| Checkout | `$STATE_DIR/previews/<id>` (detached worktree) | swept wholesale at boot |
| Log | `$STATE_DIR/previews/<id>.log` | the dev command's stdout and stderr |

## Scopes, side by side

| Identifier | Example | Unique within | Written by |
|---|---|---|---|
| Project slug | `10x` | the database | the user, at creation; immutable |
| Ticket id | `10x-12` | the database | the board (`<slug>-<next_number>`) |
| Requested branch | `claude/10x-10x-12` | the repo | the board, in the prompt |
| Reported branch | whatever was pushed | the repo | the agent |
| Session id | `session_…` / `cse_…` | claude.ai | the `claude` CLI |
| Run token | a UUID | one session start | the board ([cloud](./cloud.md)) |
