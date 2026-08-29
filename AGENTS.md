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
