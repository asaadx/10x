# Wiring checklist

> **Historical record.** This checklist tracked wiring the React board to the backend while agents
> still ran locally under Herdr (a terminal multiplexer). `prototype-cloud` replaced that runtime
> with Claude Code cloud sessions, so items that mention panes, worktrees, the event subscription
> or live Herdr are closed by removal rather than by the fix they describe. Current behaviour:
> [`memory/cloud.md`](../memory/cloud.md) and [`memory/frontend.md`](../memory/frontend.md).

The board is live. `frontend/src/lib/use-board.ts` polls `GET /tickets?project=` and
`GET /projects` every second and renders what comes back; `frontend/src/lib/api.ts` is the whole
HTTP seam and now carries writes as well as reads. Three card actions are real — `Plan`,
`To Do` and `Backlog` — plus `Steer`, and the composer's `Add` creates a ticket. What is still
decoration is `Start`, `Accept`, `Reject`, the sheet's `Save`, and the three destructive
confirmations (`Cancel`, `Delete worktree`, `Delete ticket`), which close their own dialog and
nothing more. `mock.ts` survives as a design fixture behind `VITE_MOCK_MODE=true` and is not what
the board renders by default. The backend is further along than any of it: projects, ticket CRUD,
the two pure moves, plan, spawn with the readiness guard, cancel, worktree removal, accept,
reject, the webhook receiver and boot reconciliation are all built and covered by `node:test` and
the `full` Playwright project.

Items tagged **MISLEADS A DEMO** are the ones where the UI states or implies something untrue
today. Those are worth reading first even if you do not fix them first.

## 1. Flow

Without these a ticket cannot travel Backlog to Done for real.

- [x] **The board fetches.** `useBoard(projectId)` in `frontend/src/lib/use-board.ts` owns the
      only timer: `POLL_MS = 1000`, both GETs in one `Promise.all`, a failed poll keeping the
      last good board and hanging the message off it as `error`, which `App.tsx` renders as a
      one-line `role="status"` stale-data banner. It also returns `refresh()`, which a write
      calls the moment its POST lands so the card does not sit a whole interval behind the
      state it just changed. Exactly one `GET /tickets` is ever in flight: a *timer* tick that
      finds one running is dropped, and a *manual* refresh is queued and served as soon as that
      one lands.

- [x] **Backlog to To Do works in the browser.** `moveTicket(id, to)` POSTs
      `/tickets/:id/status {to}` and `RunActions` in `TicketCard.tsx` calls it from `To Do` on a
      `backlog` card and `Backlog` on a `todo` one — the only two moves the server treats as
      pure (`backend/src/transitions.ts`). Anything with side effects still answers 409
      `transition_has_side_effects` naming the route that owns it, and `PATCH /tickets/:id`
      still rejects `status` outright (`IMMUTABLE`, `backend/src/ticket-store.ts:252`), so
      `/status` remains the only door.

- [x] **`Plan` starts the planning agent.** `startPlanning(id)` POSTs `/tickets/:id/plan`, which
      creates a workspace and a pane, starts the agent and sends it the ticket as its opening
      message before it answers — so the button shows a spinner and reads `Planning...` for the
      whole call and is disabled throughout, alongside `To Do`. A second POST would answer 409
      `operation_in_flight`, and a planner that really did start twice would be a second paid
      agent. Plan never changes the ticket's status: the planner PATCHes its task breakdown and
      acceptance criteria onto the ticket, and a human promotes.

- [x] **`To Do` is primary exactly when the ticket has a plan**, defined as `taskBreakdown` and
      `acceptanceCriteria` both non-empty. That is the whole readiness signal — the agent
      proposes by filling the fields, the human confirms by clicking — and `Plan` steps down to
      `outline` when it happens, so a card offers one primary action at a time and a ripe plan is
      readable off the board without opening a pane.

- [ ] **`Start` needs its handler.** The card shows `Start` only for `status === "todo"` and
      `POST /tickets/:id/spawn` claims `todo -> in_progress`, answering 409 `not_in_todo` from
      anywhere else — so the column and the route agree and wiring the click is all that is
      left. There is no `spawnTicket` in `api.ts` yet.

- [ ] **`Accept`, `Reject` and the three destructive confirmations need handlers.** `Accept` and
      `Reject` in `RunActions` have no `onClick`. `Cancel` opens a dialog whose confirm button is
      `onClick={() => setConfirmCancel(false)}`; `Delete worktree` and `DeleteTicketDialog.tsx`
      are the same shape. Every route exists.
      **MISLEADS A DEMO:** three dialogs say the work is discarded and cannot be undone, then do
      nothing.

- [x] **`Cancel` returns the ticket to To Do.** `POST /tickets/:id/cancel` claims
      `in_progress -> todo` and `DELETE /tickets/:id/worktree` takes the same edge, which is
      what the confirm dialog already promises. Server, dialog and `memory/operations.md` agree —
      the dialog's confirm button is the part that is still inert, tracked above.

- [ ] **`Steer` focuses; nothing prompts a live agent.** `SteerButton` in `TicketCard.tsx` fires
      a bare `fetch("/tickets/:id/focus", {method: "POST"})` — the one write in the frontend that
      bypasses `api.ts`, worth moving into the seam. Focus is not steering: no route sends text
      to a running agent outside `/reject`. The reject handler holds the call and the failure
      taxonomy to copy — `request("agent.prompt", {target, text})` plus the `agent_not_found`
      versus `agent_blocked` split — and a real Steer is that without the claim, plus somewhere
      to type.

- [x] **The composer creates a real ticket.** `Add` in `TicketSheet.tsx` POSTs `/tickets` with
      `{projectId, title, description}`, which is all `createTicket` narrows, then closes the
      sheet and refreshes the board. It is disabled while the request is in flight and reads
      `Adding...`; a failure keeps the sheet open with everything typed and shows the message
      above the footer, because discarding a description over a blink would be the expensive
      mistake.

- [ ] **`Save` cannot write.** `PATCH /tickets/:id` exists and accepts `title`, `description`,
      `playbook`, `taskBreakdown` and `acceptanceCriteria`. The button has no `onClick`, so every
      edit made in the sheet is discarded on close.
      **MISLEADS A DEMO:** the sheet's fields look editable and persistent.

- [x] **`New ticket` in the To Do column lands the card in To Do.** `INSERT_TICKET` hardcodes
      `status 'backlog'` because a new ticket is a raw idea, and that stays; `App.tsx` passes the
      clicked column down as `createInto`, so the To Do footer's button follows its
      `POST /tickets` with `POST /tickets/:id/status {to:"todo"}`. The pair is not atomic and is
      not pretended to be: if the move fails the ticket exists in Backlog and the error says so,
      which the card's own `To Do` button then retries.

- [ ] **`Reject` needs somewhere to type the reason.** `POST /tickets/:id/reject` answers 400
      `reason_required` on an empty or absent reason. The button has no input, so it cannot be
      wired without adding one.

- [x] **Server errors land where the click was.** Every route answers a JSON envelope —
      `{error, message?}` — and `api.ts` parses it in one place, so a failure reads as
      `POST /tickets/wire-3/status failed: 404 no_such_ticket` rather than as silence. A card's
      write shows it on the card, in place of the description on that reserved line so the card
      does not change height; the composer shows it above the sheet footer; a failed read stays
      in the stale-data banner. The codes worth surfacing verbatim are unchanged:
      `not_in_todo`, `not_in_backlog`, `not_in_status`, `illegal_transition`,
      `transition_has_side_effects` (which carries the owning route in `message`),
      `operation_in_flight`, `port_pool_exhausted`, `pr_open`, `pr_state_unknown`,
      `missing_github_token`, `agent_not_alive`, `no_branch`. Each remaining button inherits this
      by calling through `api.ts`.

## 2. Correctness

Wired or half-wired, and wrong or silently misleading.

- [ ] **`busy` is computed and ignored.** `board()` sets `busy: inFlight.has(t.id)` and the
      server answers 409 `operation_in_flight` to a second request; nothing in the frontend reads
      the field. Each card guards its own double-click locally — one `pending` slot disables
      every button that could start another write — but that is per-browser. A ticket busy
      because another tab or the reconciler is working on it still renders as idle.

- [ ] **`Preview` is a two-second timer with nothing behind it.** `RunActions` walks
      `idle -> starting -> live` via `setTimeout`. No preview route exists, and the recorded
      decision is that the button *hides* until the project carries run config
      (`memory/parking-lot.md`).
      **MISLEADS A DEMO:** it turns green and says "Live" with no dev server running.

- [x] **`Archive` is gone.** It had no flag, no column and no route, and it could not be faked
      through `status` either: `toStatus` decodes any unrecognised stored value to `backlog`
      (asserted in `backend/src/db.test.ts`). Its tooltip promised the ticket was hidden and
      nothing deleted, so it was removed rather than left lying. Done now offers no run action at
      all; the row's own `h-7` keeps a Done card the same height as every other. It comes back
      when there is an `archived` column plus a board filter, which is what
      `memory/parking-lot.md` prefers over an Archive column.

- [x] **`POST /tickets/:id/focus` has a caller.** `SteerButton` fires it on every In Progress
      card, which is what the blocked chip's "Answer it in Herdr" now leads to. The call itself
      bypasses `api.ts`; see the Steer item above.

- [ ] **`unowned` orphans are returned and dropped.** `board()` answers `{tickets, unowned}` from
      `findOrphans` and no component renders `unowned`. Visibility is the entire purpose of
      reconciliation (a retired memory node), so this is the one place the backend is still
      ahead of the UI.

- [ ] **`e2e/board.spec.ts` cannot pass, on three remaining counts.** Read, not run — it needs a
      live Herdr socket and binds 4310. Rewrite it alongside the wiring: it is the only fast
      agent-free proof that the board and the API agree. The poll fixed two of its five original
      failures — the seeded title and the counts now come from `GET /tickets`, and
      `picks up a ticket created after load without a reload` has its 1 s poll back. Still
      broken:
      - `shows all four columns in order` expects exactly
        `["Backlog 1","In Progress 0","In Review 0","Done 0"]` across every `role=region`. The
        board renders five columns including `To Do` (`frontend/src/types.ts`).
      - The two "no Accept/Reject button" tests require `Start` *inside* the Backlog region.
        Backlog offers `Plan` and `To Do`; `Start` is To-Do-only.
      - The static-asset test demands `/styles.css` and `/js/{app,render,state,api,icons}.js`,
        which is the old vanilla harness. Vite emits `index.html` plus hashed `dist/assets/*`, so
        all six 404 through `resolvePublicAsset`.

- [x] **The ARIA contract survived this pass**, re-verified in a browser against the built
      bundle: exactly one `<header>` (`NavBar.tsx`), five
      `<section aria-labelledby data-status>` columns whose `h2` keeps its literal `{" "}`
      separator so the accessible name computes as `Backlog 2` and not `Backlog2`, and
      `<article aria-label={ticket.id}>` cards. Keep all of it while rewriting the spec; the
      comments at each site explain why each one is load-bearing.

## 3. Persistence

Every field the UI shows now has a column (`backend/src/db.ts`, with an `addColumnIfMissing`
migration each). What is missing is the write path, and it differs per field.

- [ ] **`startedAt` is never written.** The column exists and `setRunFields` can set it, but no
      production caller does — `/spawn` writes `branch`, `agentName` and `sessionDir` only. So it
      is null on every real ticket and `RunTimer`, which gates on `startedAt !== null`, never
      renders. One write at the point the spawn compare-and-swap wins is the whole fix.
      **MISLEADS A DEMO:** every In Progress card ticks under `VITE_MOCK_MODE`, and none does
      against a live board.

- [ ] **`playbook` is stored and read by nothing.** The column is `NOT NULL DEFAULT 'Fullstack'`
      and `PATCH /tickets/:id` accepts it, but `POST /tickets` does not (`createTicket` narrows to
      `{projectId, title, description}`), the sheet's `Save` is unwired, and no spawn arg or
      prompt reads it — `playbook` appears nowhere in `runner.ts`, `prompts.ts` or `server.ts`.
      **MISLEADS A DEMO:** it implies the dispatch profile is a choice that changes a run.

- [x] **Task Breakdown and Acceptance Criteria persist.** Both are `TEXT NOT NULL DEFAULT '[]'`
      columns parsed at the decode boundary, validated item by item on the way in
      (`isChecklist`), and settable through `PATCH /tickets/:id` — which is how the planning
      agent files its plan, and what the card's readiness signal reads. Editing them from the
      sheet still depends on `Save`, tracked in section 1.

- [x] **`screenshots` are captured by the ticket's own agent and have a real write path.**
      `POST /tickets/:id/screenshots/:side` (raw PNG bytes) writes `screenshot_before` /
      `screenshot_after` (`screenshots.ts`, `backend/src/server.ts`), served back at
      `GET /screenshots/<file>`. Capture itself is the `visual-diff` skill
      (`skills/visual-diff/SKILL.md`), provisioned into every implementation agent's worktree
      at spawn (`backend/src/skills.ts`, since deleted). Deleting a ticket deletes
      both files.

- [ ] **Attachments are inert.** `attachments` is a column; `AttachmentDropZone` in
      `TicketSheet.tsx` is a real drag target whose drop handler only resets its own `dragging`
      flag, and there is no upload route. It needs both, plus a path into the spawn prompt,
      before it means anything.
      **MISLEADS A DEMO:** it accepts a drop and discards the file silently.

## 4. Polish

- [ ] **`Filters` does nothing.** The `Filters` button in `BoardToolbar.tsx` has no handler and
      no filter model behind it. Search and sort beside it are pure client-side derivations
      (`lib/board.ts`) and are correct against the live poll.

- [ ] **Two nav destinations are inert.** `DESTINATIONS` in `NavBar.tsx`: Dashboard and
      Playbooks are `disabled` and only Board carries `aria-current`. Honest today; they
      become a lie the moment either is enabled without a view behind it.

- [ ] **`diagnostics` does not survive a restart.** It comes from the in-memory `runs` map and is
      rendered only behind `VITE_DIAGNOSTICS` (`TicketSheet.tsx`). Deliberate
      (`backend/src/types.ts`), worth knowing before someone treats a zeroed panel as a bug.

- [ ] **Replace the poll with SSE.** Roughly 30 lines, sketched in `memory/parking-lot.md`, and
      the backend already holds the live Herdr subscription. The poll it replaces is what
      `e2e/board.spec.ts` asserts, so land the spec rewrite first.
