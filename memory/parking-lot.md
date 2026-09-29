# Parking lot

**Node:** parking-lot · Parent: [INDEX.md](./INDEX.md)

Deliberately deferred items. Each has enough context attached that picking it up later does not
mean starting from zero. Nothing here is in scope, and nothing here blocks the running system
described in [cloud](./cloud.md).

---

## Scoped agent credentials

**The largest known gap.** Every cloud agent holds `TENX_DB_TOKEN`, a Turso token that can read
and write every row of every table. "Only your own row, only these columns, never `status`" is
prompt text, and `run_token` stops a *stale* session, not a hostile or confused one
([cloud](./cloud.md) → Known gaps).

Two shapes, neither built:

- **A per-database read/write token with fewer rights.** Turso's token model would have to allow
  row- or column-level scope; *unverified* whether it does.
- **A write proxy** — a tiny HTTP endpoint that accepts `{ticketId, runToken, fields}`, checks the
  token against the row and the fields against the allow-list, and performs the UPDATE itself.
  That reintroduces something the agent must reach over the network, which is exactly what the
  design avoided by having agents talk to Turso directly: the board is on a laptop, not the
  internet. It would have to be hosted.

---

## Session status, and ending a session

There is no CLI or API to read a cloud session's status or to stop/archive one. Consequences
today: a crashed session reads *working* forever; Cancel sends a polite message and the session
keeps running until the user archives it in claude.ai. When either capability appears, the
places to wire it are `CloudDriver` in `cloud.ts` (a new method, implemented by both drivers) and
the poller's tick. Until then, a cheap stopgap would be a "stale" badge when `agent_updated_at`
is older than some threshold while `agent_state` is `starting`/`working` — the column already
exists and nothing reads it for that.

---

## A reviewing agent, and merge policy

- **Accept marks a draft PR ready and never merges.** Human review on GitHub is the quality gate,
  so the app never handles a merge conflict. It does not read `mergeable` either
  ([github](./github.md) says why a read would have to be retried).
- **In Review → In Progress is never automatic.** That is the infinite-loop guard, and it is what
  Reject performs by hand.
- **Success is not verified by the app.** The agent's `done` is trusted; the diff is the reviewer's.
- **Deferred: a fresh reviewing session** started at In Review against the same branch. It would
  be a third `session_kind` and a third prompt; the protocol (state in the row, `run_token`
  scoping) already fits it.
- **Deferred: the CTO auto-dispatcher** — something that starts To Do tickets without a click.
  Nothing limits concurrent sessions today, so this needs a cap first.

---

## Enforcing screenshot capture

**Not built.** `prompts/implementation.md` requires the agent to capture before/after and post
them on the PR for any change a person would look at, or to say in `agent_note` why it skipped.
Nothing checks that it did. Enforcing it needs a reliable "does this ticket change the UI" signal
— `playbook` is the closest candidate and it is self-reported — and a way to see PR comments
(one more GitHub read). A gate on Accept would then have to tell "never needed one" from "forgot",
which is the same missing signal.

---

## Push board updates with SSE instead of polling

The browser polls `GET /tickets` every second, and the server itself only learns anything by
polling the database every `AGENT_POLL_MS`. SSE would remove the browser's half:

```ts
// GET /tickets/stream
res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
clients.add(res);
req.on("close", () => clients.delete(res));
// after each poll tick that changed something, and after each write route:
for (const res of clients) res.write(`data: ${JSON.stringify(board)}\n\n`);
```

Roughly 30 lines, plus a periodic `:heartbeat\n\n`. Gain: no browser traffic while idle. Agent
latency is bounded by the database poll either way, so this is not worth doing before the poll
itself could be replaced by something Turso pushes.

---

## Hosting and multi-machine access

The database is already shared (Turso), so a second machine can read the same tickets. What is
still local to one machine: the board process (which runs the user's own `claude` login, so only
that user can start sessions), each project's clone, Previews, and the port pool. Open questions,
none designed:

- **No auth on the board.** It binds `0.0.0.0` with no auth on any endpoint; do not expose it
  publicly. A hosted board needs auth before anything else, and then webhook HMAC
  ([github](./github.md)).
- **Access roles for other users.** Sessions run on the board owner's subscription by design (no
  token is stored or intermediated by 10x), so "another user starts a session" means their own
  board or their own CLI, not a shared one.
- **Two boards on one database** would both run the poller. The move to review is a CAS and safe
  to race; the PR reconcile would double its GitHub reads. Previews and port slots assume one
  board per database (`releaseAllPortSlots` at boot clears every slot).

---

## Archive is one-way

`POST /tickets/:id/archive` hides a Done ticket from every list read, with no un-archive route. An
Archive **column** was considered and rejected: every other column is a stage with actions, and
Done accumulating is a filtering problem. Revisit as a filter toggle if archived tickets ever need
to be found again from the board.
