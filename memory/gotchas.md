# Gotchas and known gaps

**Node:** gotchas · Parent: [INDEX.md](./INDEX.md)

The traps that do not belong to one subsystem, each paired with the symptom it produces. The
session-specific gaps (no status, no archive, full-access token) are in [cloud](./cloud.md) →
Known gaps; this node does not repeat them.

## Gotchas

- **A Hrana SQL error is an HTTP 200.** `POST /v2/pipeline` answers 200 with
  `{"type":"error"}` in the result for a failed statement, so `curl -sf` exits 0. The board's
  driver checks every result (`sql.ts` `first`, and `step_errors` for a batch) and throws; an
  agent's `tenx_sql` does not, which is why both prompts tell the agent to read every response.
  Symptom when ignored: an agent that believes it reported `done` and a card that never moves.
- **Zero rows affected is the stale-session signal.** Every agent UPDATE is scoped by
  `run_token`, so after a Cancel or a re-Start the old session's writes succeed at the HTTP level
  and change nothing. That is the design, not a bug to retry ([cloud](./cloud.md)).
- **A stale `done` beside `in_progress` is moved on the next poll.** Anything that puts a ticket
  back into `in_progress` must reset `agent_state` **in the same statement** as the status
  (`claimTicketWith`) — Start and Reject do. A new route that claims `in_progress` with a bare
  `claimTicket` and resets `agent_state` afterwards would bounce the ticket straight to review.
- **An empty `.env` line is `""`, not unset.** `process.loadEnvFile` sets `FOO=` to the empty
  string, and `.env.example` lists most variables that way. Read them with `||` (or check
  `.trim() === ""`), never `??` — `cloud.ts`, `server.ts` (`AGENT_POLL_MS`) and `sql.ts`
  (`TURSO_DATABASE_URL`) all do. Symptom: running a binary named `''`, or a poll interval of 0.
- **`agent_state` is agent-written free text.** It is parsed, not cast (`db.ts`
  `toAgentState`): anything outside the union reads as `null`, never as a state that could trigger
  the move to review. The same distrust applies to `branch` — Preview refuses an unsafe name
  before git sees it (`preview.ts` `isSafeBranch`) — and to `playbook`, which nothing validates
  on an agent write.
- **The fake agent scopes by `session_id`, the real one by `run_token`.** Tests that pass with
  `CLOUD_DRIVER=fake` prove the board's side of the protocol, not that a real agent's scoped
  writes land ([cloud](./cloud.md) → The fake driver).
- **A Preview's dev server does not get the board's secrets.** `GITHUB_TOKEN`, `GH_TOKEN`,
  `TURSO_*` and `TENX_DB_*` are stripped from its environment (`preview.ts` `WITHHELD_ENV`),
  because it runs unreviewed agent code. A project whose dev server genuinely needs one of those
  has to get it some other way.
- **A Preview is gone after a board restart; the session is not.** Previews live in memory and
  the boot sweep deletes their checkouts and releases every port slot. Cloud sessions keep running
  and keep writing; the first poll after boot catches up on whatever they wrote.
- **A timed-out `claude --cloud` may still have started a session.** The board hands the claim
  back and never learns the id; the 502 body's stdout tail is the only trace. Do not lower
  `CLOUD_TIMEOUT_MS` to make Start feel snappier.

---

## Known gaps and settled mechanisms

- **G7 — the base branch a session starts from.** Start and Plan pass `--ref <base_branch>`, the
  **bare** upstream name, and the session clones the repo in the cloud, so it starts from
  GitHub's tip of that branch *(inferred from the CLI docs; not observed)*. 10x never refreshes its
  own local clone after provisioning — it is only the CLI's `cwd` and the place Preview fetches
  into, and Preview fetches the agent's branch explicitly (`+refs/heads/<branch>:refs/10x/preview/<id>`),
  so a stale local base is harmless *(verified: `preview.test.ts` previews a branch that exists
  only on the upstream)*. `base_branch` stays the bare name because both `--ref` and a PR's base
  want it that way.
- **G8 — a repo with no commits is seeded, not rejected (verified).** A branch is a label pointing
  at a commit, so a commitless repo has no base branch whatever the GitHub API says:
  `GET /repos` returns `default_branch: "main"` as a *setting*, while a clone of that repo has zero
  refs, a dangling HEAD (`git rev-parse --verify HEAD` → `fatal: Needed a single revision`), and a
  local `init.defaultBranch` name that need not match GitHub's. A session told `--ref main` on such
  a repo has nothing to start from.

  Detection needs no API call: `git ls-remote --heads <url>` returns zero refs with exit 0 on an
  empty repo, and exit 128 on one that cannot be reached. `provision.ts` uses that
  (`remoteHasCommits`), then — when the user agreed in the project dialog — writes a first commit
  on `base_branch` after `git symbolic-ref HEAD refs/heads/<base>`, because the clone's HEAD points
  at the local default, not GitHub's. `GET /projects/lookup` reports `empty` from the same check.
  **Never trust `default_branch` as proof a ref exists.**
- **G10 — nothing notices a dead agent.** A session that never writes `working`, or stops writing
  mid-run, leaves the card on `starting`/`working` indefinitely. `agent_updated_at` is stored but
  nothing compares it to the clock. Recovery is manual: open the session, then Cancel.
- **G11 — `pr_url` must match exactly.** The webhook and `setPullRequestState` match tickets by
  `pr_url`, and the agent writes that value itself. A URL with a trailing slash or a different
  host form matches nothing, silently, until Accept overwrites it with GitHub's own `html_url`
  *(inferred; not observed)*.
