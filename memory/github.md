# GitHub: pull requests, webhooks and merge state

**Node:** github · Parent: [INDEX.md](./INDEX.md)

Everything 10x knows about GitHub. The cloud agent pushes its own branch and opens its own
**draft** PR (`prompts/implementation.md`); the board's part is **Accept**
([`backend/src/github.ts`](../backend/src/github.ts), driven by `POST /tickets/:id/accept`), the
webhook receiver, the poller's PR reconcile, and the live PR-state read the delete and archive
guards depend on.

> **Provenance.** The Accept and reconcile sections are verified against the source and
> `server-pr.test.ts` / `github.test.ts` (a fake GitHub behind `github-fetch-shim.ts`); neither
> has run against real GitHub on this branch. The webhook and merge-state section was observed in
> an earlier session against a live `gh webhook forward` on `asaadx/10x-test`, with real merges
> and a real induced conflict. Anything unobserved is labelled *inferred*.

## Accept: marking the agent's PR ready

`github.ts` is plain `fetch`, no client class and no injected transport. Accept (claim
`in_review → done` first) takes one of two paths:

- **The agent recorded `pr_number`** (the normal case) → `markPullRequestReady`: a REST
  `GET /repos/{o}/{r}/pulls/{n}`, and **only if `draft` is true** the GraphQL mutation
  `markPullRequestReadyForReview` with the PR's `node_id` — REST has no endpoint for leaving
  draft. An already non-draft PR is success with no mutation, so a retry or a human who clicked
  "Ready" on GitHub first cannot fail Accept. GraphQL answers **200 with an `errors` array** for a
  refused mutation, so both the status and the array are checked.
- **The agent pushed a branch but opened no PR** → `openPullRequest` from `tickets.branch` to
  the project's base. **No local push**: the branch is already on GitHub. A 422 "a pull request
  already exists" **adopts** the open PR for that head rather than failing.

Either way the PR as read is recorded (`setPullRequest`, then `setPullRequestState` with state and
±LOC, both keyed on GitHub's own `html_url`) with no third call. Any failure hands the claim back
to `in_review` and answers 502. 10x **never merges**.

Decisions that stay load-bearing:

- **`redact` runs on every error path.** It strips the literal token and any `https://user@`
  credential prefix, so no error message, log line or response body carries it. `server.ts`
  deliberately does **not** log the raw error separately — doing so undoes the redaction.
- **`owner/repo` comes from the project row**, never from the clone's remote — the project's
  identity is a column, validated when the project is added (`fetchRepoMetadata`, the admission
  test behind `GET /projects/lookup`).
- `pushTicketBranch` still exists in `github.ts` but nothing calls it; the agent pushes.

**Two tokens, two places.** The board's `GITHUB_TOKEN` (repo-root `.env`) is used for Accept, the
guards and the reconcile. The agent's `GH_TOKEN` is a **cloud-environment** variable the user sets
in claude.ai, used by `gh pr create` and `gh pr comment --attach` inside the session
(`docs/prototype-cloud-setup.md`). A Preview's dev server gets neither (`preview.ts`
`WITHHELD_ENV`).

## Screenshots live on the PR

The agent captures before/after with `playwright-cli` and posts them with
`gh pr comment <n> --attach` (gh ≥ 2.99) on its own draft PR. Nothing is committed and nothing is
uploaded to the board; the ticket sheet links to the PR. The legacy `screenshot_before/after`
columns are no longer written.

## Webhooks

**Built.** `POST /webhooks/github` records a PR's state and ±LOC on the ticket that owns it.
Three lines of glue in `server.ts` between one pure narrowing function and one writer.

- **The `pull_request` payload carries `additions`, `deletions`, `changed_files`, `merged`,
  `merged_at`, `merge_commit_sha`, `html_url` and `number`.** So **±LOC needs no API call** — it is
  already in the event.
- **A merge arrives as `action: "closed"` with `merged: true`.** Closed-without-merging is the same
  action with `merged: false`. That single boolean is the whole distinction the delete guard needs.
- **State is derived from `merged` + `state`, never from `action`.** `pullRequestUpdate` in
  `github.ts` maps `merged === true` → `merged`, else `state === "closed"` → `closed`, else `open`.
  Every action — opened, synchronize, reopened, closed — flows through those same three lines, so
  no allow-list can fall behind GitHub's action vocabulary.
- **The ticket is matched by `pr_url`, not `pr_number`.** PR numbers are per-repo and would collide
  across projects; the URL is globally unique and already stored. A webhook for a PR no ticket owns
  answers `{ok: true, matched: false}` and writes nothing — normal, not an error. The agent writes
  `pr_url` itself, so an agent-written URL that differs from GitHub's `html_url` matches nothing
  until Accept rewrites it ([gotchas](./gotchas.md)).
- **The route always answers 2xx.** GitHub retries a non-2xx, and a retry cannot fix a body we do
  not recognise or a PR we do not own. An unrecognised body answers `{ok: true, ignored: true}`.
- Stored in three nullable columns — `pr_state`, `pr_additions`, `pr_deletions`.
  `toPullRequestState` decodes an unrecognised value to **`null`, not a default**, unlike
  `toStatus`: "we have not heard about this PR" is a real and common state.
- **`gh webhook forward --repo=… --events=pull_request --url=…` works**, creates an **ephemeral**
  hook, tears it down on exit, and sends **no HMAC signature header**. Events that occur while it
  is down are **lost, not queued**. Nothing in `package.json` starts it, and it covers one repo per
  process.
- **No signature verification, deliberately.** `gh webhook forward` never sends a header to
  verify, and the board **binds `0.0.0.0`** (`server.ts` `.listen(PORT, …)`, no host) with **no
  auth on any endpoint** — anyone who could forge a webhook can already call
  `DELETE /tickets/:id`. HMAC on this one route would harden the least dangerous door in an
  unlocked house. The `.env` secrets `WEBHOOK_10X` and `WEBHOOK_10X_TEST` are wired to nothing.
- **What would change that: the endpoint becoming reachable from the public internet** — a tunnel,
  Smee, or a hosted deploy. The rule then needs no mode flag: **verify iff a secret env var is
  set.**

## The poller's reconcile — PR state without a webhook

Because webhook events are lossy and usually not forwarded at all, **the poller asks**:
`reconcilePullRequests` in `server.ts` runs on every poll tick, after the move to review, and for
every listed ticket with a `pr_number` whose `pr_state` is not terminal (`needsLiveCheck`: not
`merged`/`closed`) does one `GET /repos/{o}/{r}/pulls/{n}` at most once per `PR_CHECK_TTL_MS`
(60 s) per ticket, writing state and ±LOC. It is **fail-open** — no token, or a failed read,
leaves the stored value — and runs from the poller rather than the board read so `GET /tickets`
stays a pure database read (verified, `server-pr.test.ts`). This matters more than it used to: the
agent writes only `pr_number`/`pr_url`, so without the reconcile nothing would ever fill in the
PR's state or ±LOC.

**Tradeoff accepted:** a merge or close between two checks of the same ticket is invisible for up
to 60 s.

**The guards read live and fail closed.** Ticket delete, project delete and Archive each read any
non-terminal PR live before doing something irreversible: an `open` PR answers 409 `pr_open`, an
unreadable one (or no `GITHUB_TOKEN`) answers 409 `pr_state_unknown`, and a freshly read terminal
state is persisted — the recovery path for a missed event.

## Merge state can only be asked for

- **`mergeable` is NOT usable from a webhook.** It arrives `null`/`unknown`, because GitHub computes
  mergeability asynchronously after the event is sent.
- **A conflict is never pushed at all.** Verified: merging PR A made PR B conflicted and **no event
  was sent for B**. Polling is the only way to learn it.
- **A single naive read shows nothing.** `GET /repos/{owner}/{repo}/pulls/{n}` returned
  `mergeable: null` first, then `mergeable: false, mergeable_state: "dirty"` **~4 s later**. So
  **`null` means retry**, never "unknown forever". 10x does not read `mergeable` today.
- **GraphQL batching is unnecessary at this scale** and was rejected. For anyone re-checking the
  arithmetic: the real safe maxima under the 5000 points/hr ceiling are **75 and 160 tickets**.

## Credentials and test target

- `.env` holds `GITHUB_TOKEN`, fine-grained: **Contents + Pull requests write, Metadata read**,
  scoped to the repos the board publishes to. The cloud environment's `GH_TOKEN` needs
  **Contents + Pull requests write** on the same repos.
- **`asaadx/10x-test`** is the disposable target for trying real sessions: default branch
  `master`, plus `dev`, one commit.
- No test talks to real GitHub: route tests use a fake behind `github-fetch-shim.ts`, and e2e
  starts every board with `GITHUB_TOKEN=""` ([testing](./testing.md)).
