# Reading agent status and completion

**Node:** agent-status · Parent: [INDEX.md](./INDEX.md)

## Agent status values

**Agent status values:** `idle`, `working`, `blocked`, `done`, `unknown`.

- `idle` — ready for input, and its tab has been seen in the focused Herdr UI.
- `done` — the **same underlying state** as `idle`, reached while the tab was *unseen*. Focusing a
  tab marks it seen; CLI reads do not. Both mean "turn finished" — see
  [reading completion correctly](#reading-completion-correctly-verified).
- `working` — a turn is in progress.
- `blocked` — Herdr recognized an approval or question UI.
- `unknown` — an agent is present but unclassified. **Does not prove completion.** Never treat
  `unknown` as done.

## OMP status is authoritative, not screen-scraped (verified)

`agent.start` returned `screen_detection_skipped: true` plus OMP's real session JSONL path
(`agent_session.source: "herdr:omp"`). OMP reports its own lifecycle state through an
integration rather than being detected from terminal output. The `done` trigger is therefore
trustworthy — this is not a heuristic.

If OMP's state ever looks wrong, diagnose with `herdr agent explain <target> --json` and
`herdr integration status`.

## Reading completion correctly (verified)

Three traps, all confirmed by probe. Getting these wrong is the difference between the flow
working and tickets silently hanging.

**`idle` and `done` are the same underlying state.** `done` = settled while the tab was *unseen*;
`idle` = settled while the tab *has been seen* in the focused Herdr UI. Focusing marks it seen;
CLI reads do not. So a pane you watched reports `idle` on completion, and a pane you ignored
reports `done`. **Treat both as "turn finished."** Listening only for `done` strands every ticket
whose pane the user looked at.

**The first `idle` arrives before the prompt.** `agent.start` returns `agent_status: "idle"` while
the agent is merely ready for input. Accepting that as completion moves a ticket on instantly with
no work done. Require an observed `working` first, or gate on the agent record's
`state_change_seq`.

**A turn ending is not the ticket succeeding.** `done` fires identically whether the agent
committed the work, asked a question in prose, errored out, or did nothing. There is no success
signal in the protocol.

**A multi-step prompt is ONE turn (verified).** Prose, several tool calls, more prose, and a commit
all sit inside a single `working` → `done` cycle, so tool-call boundaries do **not** produce
intermediate settled events. Measured on a five-step prompt (read a file, create two files, run
`ls`, commit, with prose between each): `working` at t=1.6s, `done` at t=15.0s, and **nothing in
between**. Completion logic is therefore safe from premature firing at tool boundaries.

What that does *not* cover is a turn that ends because the agent is waiting on a human — see the
prose-question case below.

**Decision: the app does not verify success.** No commit counting, no diffing the branch against
its base. Human PR review is the gate, and a stalled or empty run surfaces there. The accepted
cost is a wasted round trip — a ticket can read as finished when the agent actually stopped to ask
something. Cheap to detect later if it becomes annoying (`git rev-list base..branch --count`), but
deliberately not built.

### A prose question looks exactly like success — the `ask` tool does not

Verified with two probes on the same agent:

```
prompt: "ask me one clarifying question in prose, then stop"   → done      ← indistinguishable
prompt: "use your ask tool to ask me red or blue"              → blocked   ← detected
```

So Herdr's `blocked` detection sees a real question/approval **UI**, not prose in the transcript.
An agent that ends its turn with a question in text is reported as `done`, indistinguishable from
success. The defence is to configure the agent not to ask; per the decision above, the app does not
try to detect it, and PR review catches the rest.

`unknown` never proves completion. Never transition on it.

### `agent_blocked` is a reliable guard on 0.8.2 (verified)

`agent.prompt` refuses a blocked agent and sends **nothing**:

```
agent.get                     → agent_status: "blocked"
agent.prompt {text: "red"}    → agent_blocked:
                                "agent ticket-t-1 is blocked and requires interactive input"
```

So a blocked agent cannot silently swallow a prompt. You may rely on this rejection rather than
pre-checking `agent.get` yourself — though the ticket still needs a human either way
([operations](./operations.md)).

This was **broken on 0.8.0** (it delivered the text) and fixed in 0.8.2 (#2788). Herdr's docs
describe the **latest** release, so treat any doc-versus-behaviour mismatch as a version gap first.
