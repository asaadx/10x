# GitHub: publishing, webhooks and merge state

**Node:** github · Parent: [INDEX.md](./INDEX.md)

Everything 10x knows about GitHub. Publishing is **built** ([`backend/src/github.ts`](../backend/src/github.ts),
driven by `POST /tickets/:id/accept`), and so is the webhook receiver and the live PR-state read
the delete guard depends on ([teardown](./teardown.md)).

> **Provenance.** The publishing section is verified against the source in this repo. The webhook
> and merge-state section was observed in an earlier session against a live
> `gh webhook forward` on `asaadx/10x-test`, with real merges and a real induced conflict. Measured
> numbers are real. Anything unobserved is labelled *inferred*.

## Publishing a branch as a PR

`backend/src/github.ts` is two network calls, no client class and no injected transport: `git push` via
`execFile`, then `POST /repos/{owner}/{repo}/pulls` via `fetch`. Four decisions in it are
load-bearing.

- **`redact` runs on every error path.** The push URL embeds the token, so an unredacted failure
  would put the secret into an error message, a log line, **and the HTTP response body** the board
  renders. It strips the literal token and any `https://user@` credential prefix. `server.ts`
  deliberately does **not** log the raw error separately — doing so undoes the redaction.
- **`owner/repo` is read from the repo's `origin` remote**, not stored. `parseRemote` accepts both
  `https://github.com/owner/repo(.git)?` and `git@github.com:owner/repo(.git)?`. This is why
  `Project` can get away with storing only `repoPath`; see the design smell in
  [parking-lot](./parking-lot.md).
- **An already-up-to-date push is success.** Git exits 0 and says so, so there is no special case.
- **A 422 "a pull request already exists" ADOPTS the existing PR** rather than failing. That is the
  correct behaviour for a retry after a partial failure, not an error path.

Accept's ordering is in [operations](./operations.md): claim, push, open PR, `setPullRequest`, then
retire the agent. Only the first three can hand the claim back.

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
  across projects; the URL is globally unique and already stored, so this needs no `owner/repo`
  parsing. A webhook for a PR no ticket owns answers `{ok: true, matched: false}` and writes
  nothing — normal, not an error.
- **The route always answers 2xx.** GitHub retries a non-2xx, and a retry cannot fix a body we do
  not recognise or a PR we do not own, so a 4xx would only buy repeated deliveries of the same
  useless event. An unrecognised body answers `{ok: true, ignored: true}`.
- Stored in three nullable columns — `pr_state`, `pr_additions`, `pr_deletions` — added by
  `addColumnIfMissing` ([architecture](./architecture.md)). `toPullRequestState` decodes an
  unrecognised value to **`null`, not a default**, unlike `toStatus`: "we have not heard about this
  PR" is a real and common state, since most tickets never reach `done`.
- **`gh webhook forward --repo=… --events=pull_request --url=…` works**, creates an **ephemeral**
  hook, tears it down on exit, and sends **no HMAC signature header**. Events that occur while it
  is down are **lost, not queued** — GitHub does not replay them to an ephemeral hook.
- **No signature verification, deliberately.** `gh webhook forward` is the only delivery path that
  exists, and it never sends a header to verify. More to the point, the board **binds `0.0.0.0`**
  (`server.ts` `.listen(PORT, …)`, no host) and **has no auth on any endpoint** — anyone who could
  forge a webhook can already call `DELETE /tickets/:id`, which force-removes the worktree, deletes
  the branch and drops the row with no audit trail. HMAC on this one route would harden the least
  dangerous door in an unlocked house. The two `.env` secrets `WEBHOOK_10X` and `WEBHOOK_10X_TEST`
  are wired to nothing.
- **What would change that: the endpoint becoming reachable from the public internet** — a tunnel,
  Smee, or a hosted deploy. A tailnet does not count. The rule then needs no mode flag: **verify iff
  a secret env var is set.** Set one in production, leave it unset locally, and `gh webhook forward`
  never trips it. If the board ever goes public, webhook HMAC is far from the most urgent fix.
- Because events are lossy, the receiver **cannot be the only source of PR state**. The on-demand
  read below doubles as the recovery path.

## Merge state can only be asked for

- **`mergeable` is NOT usable from a webhook.** It arrives `null`/`unknown`, because GitHub computes
  mergeability asynchronously after the event is sent.
- **A conflict is never pushed at all.** Verified: merging PR A made PR B conflicted and **no event
  was sent for B**. Polling is the only way to learn it.
- **A single naive read shows nothing.** `GET /repos/{owner}/{repo}/pulls/{n}` returned
  `mergeable: null` first, then `mergeable: false, mergeable_state: "dirty"` **~4 s later**. So
  **`null` means retry**, never "unknown forever" — treating `null` as a terminal answer is the bug
  this note exists to prevent.
- The read set is small by construction: **open PRs only**, i.e. Done tickets whose PR has not
  merged. A ~60 s cache is enough.
- **GraphQL batching is unnecessary at this scale** and was rejected. Note for anyone re-checking
  the arithmetic: both brackets in the original estimate (6060 and 6030 points/hr) exceed the 5000
  ceiling — the real safe maxima are **75 and 160 tickets**.

## Credentials and test target

- `.env` holds `GITHUB_TOKEN`, fine-grained: **Contents + Pull requests write, Metadata read**,
  scoped to `asaadx/10x` and `asaadx/10x-test`.
- **`asaadx/10x-test`** is the disposable e2e target: default branch `master`, plus `dev`, one
  commit. Free rein — `accept.spec.ts` pushes to it and opens a real PR, then closes it in a
  failure-proof `finally`. That spec **skips itself when `GITHUB_TOKEN` is unset**
  ([testing](./testing.md)).
- **Registering a project needs `baseBranch` passed explicitly.** It defaults to `main`, which does
  not exist in these repos, and the failure surfaces much later as `worktree_create_failed`.
