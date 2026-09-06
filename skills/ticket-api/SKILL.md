---
name: ticket-api
description: Read tickets on the board for context, and update your own ticket's title, description, playbook, task breakdown, or acceptance criteria as you work.
allowed-tools: Bash(curl:*) Bash(jq:*)
---

# Ticket API

You are 10x's implementation agent for one ticket, working in your own worktree. This skill is
how you talk to the board itself — not the project you're editing — to read other tickets for
context, re-check your own ticket's current fields, or record progress on it as you go: updating
its description with something you learned, or checking off a task or acceptance-criteria item.

The 10x API lives at `{{apiUrl}}`, and your own ticket's id there is `{{ticketId}}` — both come
from your system prompt, not from anything in this worktree.

## Reading tickets

One route, no filter required, an optional one if you want it:

```bash
curl -sf {{apiUrl}}/tickets                       # every non-archived ticket, every project
curl -sf "{{apiUrl}}/tickets?project=<projectId>" # scoped to one project
```

**There is no single-ticket route.** `GET {{apiUrl}}/tickets/{{ticketId}}` does not exist. To
read one ticket — your own, or another one you need context from (its status, its plan, whether
it's still in flight) — fetch the list and pick the entry by `id`:

```bash
curl -sf {{apiUrl}}/tickets | jq --arg id "{{ticketId}}" '.tickets[] | select(.id == $id)'
```

Reading another ticket is fine and expected — that's what this route is for. Nothing in this
skill writes to one: the PATCH below only ever targets `{{ticketId}}`, your own.

## Updating your own ticket

`PATCH {{apiUrl}}/tickets/{{ticketId}}` takes a JSON body with any subset of five fields:
`title`, `description`, `playbook`, `taskBreakdown`, `acceptanceCriteria`. Send only the fields
you're changing — a field you omit is left exactly as it was.

```bash
curl -sf -X PATCH {{apiUrl}}/tickets/{{ticketId}} \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated after discovering the actual API shape mid-implementation."}'
```

`playbook`, if you set it, must be exactly one of Fullstack, Frontend, Backend, Database,
DevOps, Docs or Research — anything else is refused with a 400.

Everything else on the ticket (`status`, `branch`, `agentName`, `finished`, `died`, `archived`,
`number`, `projectId`, `sessionDir`) is owned by the spawn/teardown lifecycle, not by this route:
naming any of them, even with the value it already has, is refused as a 400 `immutable_field`.
That includes `status` — this skill is not how your ticket moves to review; ending your turn
does that. It also means you can only ever PATCH `{{ticketId}}`: there is no lifecycle route
here for another ticket, and none for `/status`, `/accept`, `/reject`, `/archive`, `/cancel`, or
delete on any ticket, including your own.

## Checking off a task or acceptance-criteria item

`taskBreakdown` and `acceptanceCriteria` are each a JSON array of `{"text": "…", "done": bool}`,
and the PATCH above **replaces the whole array** — there is no route that toggles a single item.
Ticking one box is a read-modify-write, every time:

1. **GET** your own ticket and pull out the current array (`taskBreakdown` or
   `acceptanceCriteria`).
2. **Flip** the one item's `done` flag in place — match it by `text` — leaving every other item,
   text and flag alike, untouched, in its original order.
3. **PATCH** the *entire* array back under that same field name.

```bash
TICKET=$(curl -sf {{apiUrl}}/tickets | jq --arg id "{{ticketId}}" '.tickets[] | select(.id == $id)')

UPDATED=$(echo "$TICKET" | jq '.taskBreakdown |= map(
  if .text == "Wire the new endpoint" then .done = true else . end
)')

curl -sf -X PATCH {{apiUrl}}/tickets/{{ticketId}} \
  -H "Content-Type: application/json" \
  -d "$(echo "$UPDATED" | jq '{taskBreakdown: .taskBreakdown}')"
```

A PATCH that sends only the one item you touched — instead of the full array read back in step
1 — silently **deletes every other item** from the stored ticket: the column is JSON text,
written whole, with no merge on the server side. Always round-trip the complete array you just
read, never a fragment you construct by hand.

## What this skill does not do

- No `/status`, `/accept`, `/reject`, `/archive`, `/cancel`, or delete, on your ticket or any
  other — those are lifecycle moves the board makes, not calls an implementation agent makes on
  itself or on anyone else.
- No before/after screenshots — that's `skill://visual-diff`.
- No attachments — there is no write path for them anywhere in the backend today, on this route
  or any other.
