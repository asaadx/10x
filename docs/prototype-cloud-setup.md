# prototype-cloud — morning setup

Everything you need to try the branch against real cloud sessions. Roughly 15 minutes. The
design is in [`prototype-cloud.md`](./prototype-cloud.md).

> **Before anything else:** claim the cloud-session credit — run `/claim-credit` in Claude Code
> (or claude.ai/code). Max gets $250; the claim window closes **Oct 7, 2026** and the balance is
> reported to expire Nov 4, 2026. After it runs out, cloud sessions draw on your normal Max limits.

## 1. Check out and install

```bash
git fetch origin prototype-cloud && git checkout prototype-cloud
pnpm install
```

Node 24 as before. Nothing but the board needs to be running locally any more.

## 2. The `claude` CLI on your machine

The board starts sessions by running your own logged-in `claude` binary, so:

```bash
claude --version          # recent enough to have --cloud
claude                    # then /status: must be your claude.ai (Max) login, not an API key
```

**Smoke-test the two commands the board relies on** (these flags come from the docs and have not
been run against your account yet — this is the one real unknown):

```bash
cd ~/.10x/repos/<some-project>        # any project clone 10x already made
claude --cloud "Say hello and stop. Do not change any files." --ref main
#   → should print a https://claude.ai/code/session_… URL
claude -p "Thanks, that's all." --cloud <that-session-id> --output-format json
#   → {"ok":true,...}
```

If either flag is named differently in your CLI version, the only place to change is
`backend/src/cloud.ts` (the `cli` driver), or point `CLAUDE_BIN` at a wrapper script.

## 3. Turso (the shared database)

```bash
brew install tursodatabase/tap/turso        # or: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup                            # free tier is plenty
turso db create tenx
turso db show tenx --url                     # libsql://tenx-<you>.turso.io
turso db tokens create tenx                  # a long JWT
```

Put both in the repo-root `.env`:

```bash
TURSO_DATABASE_URL=libsql://tenx-<you>.turso.io
TURSO_AUTH_TOKEN=<token>
```

The board creates its tables on first boot. Your old `~/.10x/10x.db` is **not** migrated (it's a
prototype); leave `TURSO_DATABASE_URL` unset to run against local SQLite as before.

## 4. The cloud environment (claude.ai/code → environment menu → Edit)

Agents report progress by writing their ticket row in Turso, and post screenshots with `gh`.

- **Environment variables:**
  ```
  TENX_DB_URL=https://tenx-<you>.turso.io
  TENX_DB_TOKEN=<same token as above>
  GH_TOKEN=github_pat_…        # fine-grained PAT: Contents + Pull requests write on your repos
  ```
  (Note `https://`, not `libsql://`, for `TENX_DB_URL`.) Environment variables are visible to the
  agent — acceptable for a prototype; a scoped Turso token is the later fix.
- **Network access:** *Custom* → keep the default allowlist and add `*.turso.io`.
- **Setup script** — installs a `gh` new enough for `--attach` (≥ 2.99) and `jq`:
  ```bash
  #!/bin/bash
  set -e
  command -v jq >/dev/null || (apt-get update -y && apt-get install -y jq)
  if ! gh --version 2>/dev/null | grep -qE 'gh version (2\.(99|[1-9][0-9]{2,})|[3-9])'; then
    curl -fsSL https://github.com/cli/cli/releases/download/v2.99.0/gh_2.99.0_linux_amd64.tar.gz \
      | tar -xz -C /tmp && install /tmp/gh_2.99.0_linux_amd64/bin/gh /usr/local/bin/gh
  fi
  ```

## 5. Run it

```bash
pnpm start                 # builds the frontend, serves the board on http://localhost:4010
```

Add `dev_command` to a project (Project dialog → *Dev command*, e.g. `pnpm dev --port $PORT`) if
you want Preview to start the app, not just check it out.

### Try this flow

1. Create a ticket in Backlog → **Plan**. A cloud session opens; click **Open session** to chat
   with the planner. When it's done, the ticket's description/checklists fill in.
2. Move it to Todo → **Start**. The card shows *starting → working*; **Steer** opens the session.
3. When the agent writes `done`, the ticket moves to **In Review** by itself (the board polls
   Turso every 5 s). The draft PR link and any screenshots are on the PR.
4. **Preview** checks the branch out locally (and runs the dev command if set).
5. **Reject** with a reason → the message goes into the same session, back to In Progress.
   **Accept** → the draft PR is marked ready for review.

### Offline try-out (no Turso, no cloud)

```bash
CLOUD_DRIVER=fake FAKE_AGENT_MS=5000 pnpm start
```

A fake agent plays the protocol (working → done after 5 s) so you can click through the whole
lifecycle without spending anything.

## Known gaps (prototype)

- The board cannot read a session's real status — it trusts what the agent writes. A session that
  crashes without writing `failed` stays *working*; open it via **Steer**.
- Cancel sends a "stop" message; archiving the session is manual in claude.ai.
- If the board process crashes (not a normal Ctrl-C), a running Preview dev server keeps its
  port; the next Preview on that port fails until you kill it (`lsof -i :4100-4199`).
- Agents hold a DB token that can write any ticket (convention says "only your own row"). Each
  session's writes are scoped by a per-session `run_token`, which stops a *stale* session (one you
  cancelled, or a planner left open) from moving the current run — it is not a security boundary.
- No auth on the board yet; don't expose it publicly. Only you can start sessions because they run
  on your local `claude` login.
- The old local runtime's skills haven't been ported, except ticket-api and visual-diff, which are
  folded into the agent prompts.
