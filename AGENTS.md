# AGENTS.md

## Directive: consult `memory/` before exploring the codebase

Before any broad investigation — repo-wide greps, reading files to build a mental model,
tracing how a subsystem works, or answering "how does X work here?" — **read
[`memory/INDEX.md`](./memory/INDEX.md) first** and open any node it links that matches your
task.

`memory/` is a living document. When you learn something durable that is not recorded — a
verified mechanism, a non-obvious constraint, a gotcha that cost you time, a root cause, or a
decision and its reasoning — **update the relevant node and keep `memory/INDEX.md` linked and
accurate** as part of the same task. Mark each claim **verified** (observed, with evidence) or
**inferred** (reasoned, unconfirmed), and never blur the two.

Treat `memory/` as present-tense truth: assume it is current and correct. When you find
something in it that is wrong, **overwrite it in place** — never append a correction, a
changelog, or a "previously we thought…" note. Verify secondhand claims before recording them as
fact, or label them explicitly as unconfirmed leads.

Memory is not a substitute for reading code you are about to change. Use it to know *where* to
look and *what is already known*, then read that code directly.

## Directive: verify every Herdr name against the schema before writing code

Never write a Herdr method, subscription type, or event name from memory or from a doc. Confirm it
exists first:

```bash
herdr api schema --output herdr-api.schema.json   # gitignored; regenerate on demand
```

Then **search** it for the specific name — never load the whole file into context, it is ~250 KB:

```bash
grep -o '"pane\.agent_status_changed"' herdr-api.schema.json
```

Methods live in `schemas.request.oneOf[].properties.method.const`, subscription types in
`schemas.request.$defs.Subscription.oneOf[].properties.type.const`, and emitted event names in
`schemas.event.$defs.EventKind.enum`.

**The schema proves a name exists. It does NOT prove the separator used on the wire.** Verified:
subscription types are always dotted, but emitted names are mixed — `pane.agent_status_changed`
arrives dotted while `pane_closed` arrives underscored, and the schema lists both with underscores.
So always normalise (`event.replaceAll(".", "_")`) before comparing, and never match a literal
event name.

A wrong event name fails **silently**: no error, no exception, just events that never arrive. It
cost this project a working status pipeline once, where the only symptom was a checkmark that never
appeared while the agent worked correctly and committed.
