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
no work done. A settled status only means something when it is paired with proof that the agent
left settled *after* the prompt: either an observed `working` transition, or the
[`state_change_seq` comparison](#state_change_seq-is-a-valid-point-in-time-completion-proof-verified),
which needs no live subscription.

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

---

## `state_change_seq` is a valid point-in-time completion proof (verified)

`state_change_seq` on the agent record makes the pane subscription optional. Record its value
when the prompt is accepted, persist it beside the ticket, and **one** later `agent.get` decides
the turn. Nothing has to be held in memory, so a turn that ends after a backend restart is still
recorded.

The rule — every clause is load-bearing:

```
finished = (agent_status === "idle" || agent_status === "done")  // settled; both mean it
        && interactive_ready                                     // not a premature agent.start
        && state_change_seq > seqAtPrompt                         // it left settled and came back
```

The stored number is the counter value at *that agent's* last real state change, so a settled
agent whose seq has moved since the prompt must have **entered its current settled state after
the prompt** — it went `working` and came back. That is exactly the proof the observed-`working`
subscription existed to provide.

**Take `seqAtPrompt` from the `agent.prompt` response, not from a separate read.** That envelope
returns the record as it was *before* the prompt landed (observed `331`, identical to the
`agent.get` immediately preceding it), so there is no window between reading and prompting.

### It is one server-global sequence, not a per-agent counter (verified)

Each agent record carries the value the **global** counter held at that agent's most recent state
change. Two independent probes: a brand-new agent's first value was `321` while the agent beside
it sat at `320`; in a second run a fresh agent took `331`–`335`, interleaved with two unrelated
agents last seen at `329` and `330`. A per-agent counter would have started near zero.

This does not weaken the rule — the number on agent A moves only when A moves — but **comparing
seq across two agents is meaningless**, and the delta never says how many turns *that* agent ran.

A record whose agent is still `launch_pending` reads `state_change_seq: 0` (observed in the raw
`agent.start` envelope); its first real state change jumps straight to the current global value.

### It advances on real transitions only (verified)

One agent, sampled by `agent.get` every 100 ms. Every transition advanced it by exactly one:

| Transition | seq |
|---|---|
| `unknown`, `launch_pending: true` | `0` |
| → `idle` (agent detected, still pre-prompt) | `331` |
| → `working` (prompt accepted) | `332` |
| → `done` (turn ended) | `333` |
| → `working` (second prompt) | `334` |
| → `blocked` (`ask` tool) | `335` |

`blocked` advances it too, which is precisely why the rule demands a settled status: a consumer
that checks only "seq moved" reports a blocked agent as finished.

**The `done`↔`idle` relabel does NOT advance it (verified).** Focusing the tab of a `done` agent
flipped its reported status to `idle` with seq unchanged at `318`. The two are the same underlying
state and the counter agrees — a user looking at a pane cannot fake progress.

### It does not advance on noise (verified)

Sixteen seconds of deliberate noise against a settled agent: `318` in, `318` out. Individually,
with the pane's `revision` alongside for contrast:

| Noise | `state_change_seq` | `revision` |
|---|---|---|
| spinner redraws and agent output | unchanged | +124 across one turn |
| terminal title changes (dozens) | unchanged | moves |
| `agent.focus`, then `pane.focus` elsewhere | unchanged | unchanged |
| `pane.rename` (pane label) | unchanged | unchanged |
| keystrokes typed into an idle agent | unchanged | unchanged |
| `agent.read` | unchanged | unchanged |

So it is a clean work detector: no false positive from screen output or UI activity.

### `revision` is the pane's output cursor — never use it for completion (verified)

`revision` on the agent record is the **pane's** screen revision, surfaced on the agent record.
Proof: `pane.get` and `agent.get` return the identical number for the same pane, checked twice in
one run (`2` and `2`, then `52` and `52`). The schema agrees — `revision` also sits on `PaneInfo`,
on `PaneReadResult`, and as `min_revision` on the `output_matched` event match, all read-cursor
uses.

It climbs roughly 15/s on a pane with a spinner and reached six figures on a long-lived pane, all
with no status change whatsoever. **`revision` moving proves nothing about the agent's
lifecycle**, so it cannot serve as a completion signal. Its only value is the negative direction:
`revision` unchanged means the pane produced no output.

### Resets, and the one failure mode

- **Never decreases** while the server lives — no regression in ~900 samples across two runs.
- **Pane close and worktree removal do not reset it (verified).** After every probe agent was torn
  down the counter carried on upward from where it had reached.
- **A Herdr server restart resets it to `0` (inferred, not executed).** Neither field appears
  anywhere in `~/.config/herdr/session.json`, the only on-disk session state, and the schema
  declares `default: 0` — so the counter is in-memory. Restarting Herdr would have killed
  unrelated live agents on this host, so this one was reasoned rather than run.
  It fails **closed**: a stored `seqAtPrompt` above a reset counter reads as "no work yet", so a
  ticket stalls rather than falsely completing — and the pane died with the server anyway, which
  is the dead-pane path in [operations](./operations.md).

None of this changes the rule above the fold: a finished turn is still not a successful ticket.

### Where the two fields live

Both are declared on the single `AgentInfo` schema type, so they ride on `agent.get`,
`agent.list`, `agent.start` and `agent.prompt` — all four observed on the wire — plus
`session.snapshot`'s `agents[]` (schema only).

| Field | Type | `required` | Note |
|---|---|---|---|
| `state_change_seq` | `integer`, `uint64`, `minimum: 0`, `default: 0` | **no** | treat absent as `0` |
| `revision` | `integer`, `uint64`, `minimum: 0` | yes | pane cursor, not lifecycle |

Neither field is mentioned in `herdr --skill`, so the schema and the probe are the only sources.
Reproduce both with the [seq probe](./verification.md#probing-state_change_seq).
