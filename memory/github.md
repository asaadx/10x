# GitHub: publishing, webhooks and merge state

**Node:** github · Parent: [INDEX.md](./INDEX.md)

Everything 10x knows about GitHub. Publishing is **built** ([`src/github.ts`](../src/github.ts),
driven by `POST /tickets/:id/accept`). The webhook receiver is **not built** — the facts below are
what it must be written against, and they exist so nobody re-derives them by experiment.

> **Provenance.** The publishing section is verified against the source in this repo. The webhook
> and merge-state section was observed in an earlier session against a live
> `gh webhook forward` on `asaadx/10x-test`, with real merges and a real induced conflict. Measured
> numbers are real. Anything unobserved is labelled *inferred*.

## Publishing a branch as a PR

`src/github.ts` is two network calls, no client class and no injected transport: `git push` via
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

**Not built.** `POST /webhooks/github` is the next piece of work.

- **The `pull_request` payload carries `additions`, `deletions`, `changed_files`, `merged`,
  `merged_at`, `merge_commit_sha`, `html_url` and `number`.** So **±LOC needs no API call** — it is
  already in the event.
- **A merge arrives as `action: "closed"` with `merged: true`.** Closed-without-merging is the same
  action with `merged: false`. That single boolean is the whole distinction the delete guard needs.
- **`gh webhook forward --repo=… --events=pull_request --url=…` works**, creates an **ephemeral**
  hook, tears it down on exit, and sends **no HMAC signature header**. Events that occur while it
  is down are **lost, not queued** — GitHub does not replay them to an ephemeral hook.
- Consequence for the receiver: **verify the signature when a signature is present, and require one
  when a secret is configured.** That is the only shape that is safe under both `gh webhook forward`
  (no header) and a public URL or Smee (header always). The two `.env` secrets `WEBHOOK_10X` and
  `WEBHOOK_10X_TEST` are unused on the `gh` path and essential on any other.
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
