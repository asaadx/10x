# Wiring checklist

Nothing in the browser talks to the server. `frontend/src/App.tsx` imports `MOCK_PROJECTS` and
`MOCK_TICKETS` from `frontend/src/mock.ts`, and there is no `fetch`, `EventSource` or poll
anywhere under `frontend/src`. Every card action is decoration: `Plan`, `Start`, `Steer`,
`Accept`, `Reject` and `Archive` carry no `onClick` at all, and the three destructive
confirmations (`Cancel`, `Delete worktree`, `Delete ticket`) only close their own dialog. What
does work is local: the theme toggle, the project picker, search, sort, opening the sheet, the
copy-to-clipboard identifier buttons, and the checklists inside the sheet. The backend is the
opposite. Projects, ticket CRUD, spawn with the readiness guard, cancel, worktree removal,
accept, reject, the webhook receiver and boot reconciliation are all built and covered by
`node:test` and the `full` Playwright project. So the gap is almost entirely one seam plus two
genuinely missing transitions.

Items tagged **MISLEADS A DEMO** are the ones where the UI states or implies something untrue
today. Those are worth reading first even if you do not fix them first.

## 1. Flow

Without these a ticket cannot travel Backlog to Done for real.

- [ ] **The board never fetches.** `frontend/src/App.tsx:9,27` renders `mock.ts`: 17 fixed
      tickets across 2 fixed projects. Needs `GET /projects` and a `GET /tickets?project=` poll.
      This blocks every other item in this file.
      **MISLEADS A DEMO:** the board looks populated and none of those tickets exist in SQLite.

- [ ] **Backlog to To Do has no implementation on either side.** The route regex in
      `backend/src/server.ts:246` allows only `/spawn`, `/cancel`, `/worktree`, `/focus`,
      `/accept`, `/reject`, and `PATCH /tickets/:id` rejects `status` outright
      (`IMMUTABLE`, `backend/src/ticket-store.ts:168`). The `Plan` button
      (`TicketCard.tsx:211-217`) has no endpoint to call and no fallback.

- [ ] **`Start` is scoped to a column its route refuses.** The card shows `Start` only for
      `status === "todo"` (`TicketCard.tsx:219`), but `POST /tickets/:id/spawn` claims
      `backlog -> in_progress` and answers 409 `not_in_backlog` otherwise
      (`server.ts:326`). Wiring `Start` unchanged gives a 409 on every card that offers it.
      Blocked by the item above: whichever way you resolve the `todo` column, both must agree.

- [ ] **Every card action needs a handler.** `RunActions` in `TicketCard.tsx:200-318` has no
      `onClick` on `Plan`, `Start`, `Steer`, `Accept`, `Reject` or `Archive`. `Cancel` opens a
      dialog whose confirm button is `onClick={() => setConfirmCancel(false)}`
      (`TicketCard.tsx:527`); `Delete worktree` (`:506`) and `DeleteTicketDialog.tsx:40` are the
      same shape.
      **MISLEADS A DEMO:** three dialogs say the work is discarded and cannot be undone, then do
      nothing.

- [ ] **`Cancel` returns the ticket to the wrong column.** `POST /tickets/:id/cancel` claims
      `in_progress -> backlog` (`server.ts:448`) and `DELETE /tickets/:id/worktree` does the same
      (`server.ts:475`), but the confirm dialog promises "the ticket returns to To Do"
      (`TicketCard.tsx:519`). One of the two has to move.
      **MISLEADS A DEMO.**

- [ ] **`Steer` has no route.** It renders on every In Progress card
      (`TicketCard.tsx:237-240`) and nothing prompts a live agent outside `/reject`. The reject
      handler already holds the exact call and the failure taxonomy to copy:
      `request("agent.prompt", {target, text})` plus the `agent_not_found` versus
      `agent_blocked` split (`server.ts:575-591`). Steer is that without the claim.

- [ ] **The composer cannot write.** `Add` and `Save` in `TicketSheet.tsx:425-429` have no
      `onClick`. `POST /tickets` and `PATCH /tickets/:id` both exist; `Add` must send only
      `{projectId, title, description}`, which is all `createTicket` narrows
      (`ticket-store.ts:199-209`), and `Save` only `{title, description}`.

- [ ] **`New ticket` in the To Do column will silently create a Backlog ticket.**
      `App.tsx:55-62` passes `onNewTicket` for both `backlog` and `todo`, but `INSERT_TICKET`
      hardcodes `status 'backlog'` (`ticket-store.ts:122`) and `POST /tickets` accepts no
      status. Either add the status write or drop the To Do footer button.
      **MISLEADS A DEMO** once the composer is wired.

- [ ] **`Reject` needs somewhere to type the reason.** `POST /tickets/:id/reject` answers 400
      `reason_required` on an empty or absent reason (`server.ts:549-551`). The button has no
      input, so it cannot be wired without adding one.

- [ ] **Server errors have nowhere to land.** Every route answers a JSON envelope with 409, 500
      or 502: `not_in_backlog`, `operation_in_flight`, `port_pool_exhausted`, `pr_open`,
      `pr_state_unknown`, `missing_github_token`, `agent_not_alive`, `no_branch`. The board has
      no toast, banner or error region anywhere. Without one, a rejected click is
      indistinguishable from today's inert click.

## 2. Correctness

Wired or half-wired, and wrong or silently misleading.

- [ ] **`busy` is computed and ignored.** `board()` sets `busy: inFlight.has(t.id)`
      (`server.ts:178`) and the server answers 409 `operation_in_flight` to a second request
      (`server.ts:260`); nothing in the frontend reads the field. Without it a double-click on
      `Start` or `Cancel` is a visible error instead of a disabled button.

- [ ] **`Preview` is a two-second timer with nothing behind it.** `TicketCard.tsx:268-296` walks
      `idle -> starting -> live` via `setTimeout` (`:350-361`). No preview route exists, and the
      recorded decision is that the button *hides* until the project carries run config
      (`memory/parking-lot.md`).
      **MISLEADS A DEMO:** it turns green and says "Live" with no dev server running.

- [ ] **`Archive` has no flag, column or route.** `TicketCard.tsx:300-315`. It cannot be faked
      through `status` either: `toStatus` decodes any unrecognised stored value to `backlog`
      (asserted in `backend/src/db.test.ts:184`). It needs an `archived` column plus a board
      filter.
      **MISLEADS A DEMO:** the tooltip promises the ticket is hidden and nothing is deleted.

- [ ] **`POST /tickets/:id/focus` is an orphan route.** It exists and calls `focusAgent`
      (`server.ts:320-322`), and `paneId`/`workspaceId` ride on every ticket
      (`server.ts:176-177`), but there is no attach affordance in `TicketCard.tsx` or
      `TicketSheet.tsx`. The blocked chip tells the user to "Answer it in Herdr"
      (`TicketCard.tsx:465`) with no way to get there from the board.

- [ ] **`unowned` orphans are returned and dropped.** `board()` answers
      `{tickets, unowned}` from `findOrphans` (`server.ts:189`) and no component renders
      `unowned`. Visibility is the entire purpose of reconciliation
      (`memory/reconciliation.md`), so this is the one place the backend is ahead of the UI.

- [ ] **`e2e/board.spec.ts` cannot pass, on five separate counts.** Read, not run. Rewrite it
      alongside the wiring rather than after: it is the only fast agent-free proof that the
      board and the API agree.
      - `shows the project and its backlog ticket` asserts the fixture-seeded title and the
        headings `Backlog 1` / `In Progress 0` (`:43-60`). All three come from `GET /tickets`;
        the board renders 17 mock cards, so the counts are wrong and the seeded title never
        appears at all.
      - `shows all four columns in order` expects exactly
        `["Backlog 1","In Progress 0","In Review 0","Done 0"]` across every `role=region`
        (`:98-109`). The board renders five columns including `To Do`
        (`frontend/src/types.ts:41-47`).
      - The two "no Accept/Reject button" tests require `Start` *inside* the Backlog region
        (`:119,133`). `Start` is To-Do-only now (`TicketCard.tsx:219`), so their positive half
        fails even though the negative half is still right.
      - The static-asset test demands `/styles.css` and `/js/{app,render,state,api,icons}.js`
        (`:170-184`), which is the old vanilla harness. Vite emits `index.html` plus hashed
        `dist/assets/*` (`frontend/vite.config.ts:22-27`), so all six 404 through
        `resolvePublicAsset`.
      - `picks up a ticket created after load without a reload` (`:149-161`) asserts the 1s poll
        that no longer exists.

- [ ] **Keep the ARIA contract while rewriting that spec.** Exactly one `banner` landmark
      (the `<header>` in `NavBar.tsx`) holding the `aria-label="Project"` `NativeSelect`,
      distinct from the sheet's own Project select (`TicketSheet.tsx:239-241`);
      `<article aria-label={ticket.id}>` (`TicketCard.tsx:368-369`);
      `<section aria-labelledby>` whose `h2` carries the count with
      a literal `{" "}` (`Column.tsx:68-73`). The comments there explain why each one is
      load-bearing.

## 3. Persistence

Fields that exist in the UI with nowhere to be stored. Each of these three is hardcoded `null`
by the server at `server.ts:179-184`.

- [ ] **`startedAt`.** No `started_at` column. `RunTimer` gates on `startedAt !== null`
      (`TicketCard.tsx:471`), so the elapsed timer runs on mock data and would disappear the
      moment the board is wired. One write at the point the spawn compare-and-swap wins
      (`server.ts:326`) plus the column.
      **MISLEADS A DEMO:** every In Progress card is ticking right now.

- [ ] **`playbook`.** No column and no write path. The sheet's `Playbook` select is local state
      seeded from `ticket?.playbook ?? "fullstack"` (`TicketSheet.tsx:181`) and reset on close
      (`:196`), and `createTicket` has no such field. It needs a column, a `POST /tickets`
      field, and a read in the spawn args or prompt.
      **MISLEADS A DEMO:** it implies the dispatch profile is a choice that sticks.

- [ ] **`screenshots`.** No table and no capture path. The sheet renders the Before/After panes
      only when the pair is non-null (`TicketSheet.tsx:308`), so a live board degrades honestly
      here; only the mock fixtures ever show the placeholder panes.

- [ ] **Task Breakdown and Acceptance Criteria have no wire field.** Both are local
      `ChecklistRow[]` state (`TicketSheet.tsx:184-185`) reset on close (`:197-198`). They are
      exactly the output a Plan agent is meant to produce, so this is blocked by the
      Backlog-to-To-Do item in section 1 for its meaning, though not for its storage.
      **MISLEADS A DEMO:** they look like editable persistent lists and vanish on close.

- [ ] **Attachments are inert.** `AttachmentDropZone` (`TicketSheet.tsx:121-149`) is a real drag
      target whose drop handler only resets its own `dragging` flag. It needs storage and a path
      into the spawn prompt before it means anything.
      **MISLEADS A DEMO:** it accepts a drop and discards the file silently.

## 4. Polish

- [ ] **`Filters` does nothing.** The `Filters` button in `BoardToolbar.tsx` has no handler and
      no filter model behind it. Search and sort beside it are pure client-side derivations
      (`lib/board.ts:26-45`) and stay correct once the poll lands.

- [ ] **Two nav destinations are inert.** `DESTINATIONS` in `NavBar.tsx`: Dashboard and
      Playbooks are `disabled` and only Board carries `aria-current`. Honest today; they
      become a lie the moment either is enabled without a view behind it.

- [ ] **`diagnostics` does not survive a restart.** It comes from the in-memory `runs` map
      (`server.ts:185`) and is rendered only behind `VITE_DIAGNOSTICS`
      (`TicketSheet.tsx:399`). Deliberate (`backend/src/types.ts:83-92`), worth knowing before
      someone treats a zeroed panel as a bug.

- [ ] **Replace the poll with SSE, after the poll works.** Roughly 30 lines, sketched in
      `memory/parking-lot.md`, and the backend already holds the live Herdr subscription. Do the
      poll first: it is what the e2e spec asserts, and the deferral note says to do this when
      the real UI replaces the harness UI rather than before.
