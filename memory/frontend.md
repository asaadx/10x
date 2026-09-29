# Frontend

**Node:** frontend · Parent: [INDEX.md](./INDEX.md)

The board's browser half — everything under `frontend/`. The server that serves it, the HTTP
surface it calls and the database behind that are in [architecture](./architecture.md).

## 1. The stack

**React 19 + Vite 8 + Tailwind v4 + shadcn-style components, all TypeScript** *(verified —
`frontend/package.json`)*. There is a build step and a bundler; nothing here is loaded as a bare
script. From the repo root: `pnpm dev:web` (Vite on 5173), `pnpm build` (the bundle the backend
then serves), and `pnpm typecheck`, whose second half is the frontend's `tsc --build` *(verified —
root `package.json`)*.

- `frontend/index.html` — 14 lines: `<div id="root">` and `<script type="module" src="/src/main.tsx">`.
- `frontend/src/main.tsx` — `createRoot` under `<StrictMode>`, wraps `<App />` in `react-router-dom`'s
  `<BrowserRouter>`. Client-side routing, so a hard refresh or a direct load of any route needs the
  backend's `SPA_ROUTES` fallback (`memory/architecture.md`) to serve `index.html` in production.
- `frontend/src/App.tsx` — the router shell, not the board. Renders `<NavBar>` (shared by every
  route) plus a `<Routes>`: `/` redirects to `/board`, `/board` mounts `BoardPage`, `/list` mounts
  `ListPage`, `/dashboard` / `/playbooks` mount their placeholder pages. Owns `theme`, `projectId` and
  the single `useBoard(projectId)` poll — state `NavBar`'s project picker and every route need, so
  it lives above the routes rather than being re-fetched per page.
- `frontend/src/pages/BoardPage.tsx` — the kanban board itself (toolbar, provisioning banner,
  columns, ticket sheet), moved out of `App.tsx` unchanged when routing was added. Owns the
  board-local state `App.tsx` does not need: search query, sort order, which ticket the sheet has
  open. `DashboardPage.tsx` and `PlaybooksPage.tsx` are inert placeholders — see
  `docs/playbooks-and-dashboard.md` for their unbuilt design.
- `frontend/src/pages/ListPage.tsx` — the same tickets as one sortable, filterable table, fed by
  the shell's `useBoard` read (no second fetch) and opening the same `TicketSheet` a card does,
  with `actionError={null}` because card-action errors live in the card's own state. Pure sort,
  filter and `localStorage` prefs (key `10x.list`, every field validated on load) are in
  `lib/list.ts`. j/k/arrows/Enter are a `window` keydown listener that ignores inputs, selects,
  open menus and the open sheet — so after picking a filter from a native select, focus must
  leave the select before j/k move the cursor *(verified — Playwright in mock mode)*.
  Mock mode has 24 generated bulk tickets (`10x-15`…`10x-38`) appended to `MOCK_TICKETS` so every
  sort key has spread. At a 420px viewport the **page** still scrolls sideways on every route,
  because `NavBar` does not wrap (~890px); the list table itself scrolls inside its own box
  *(verified — `document.documentElement.scrollWidth` 888 on `/board` too)*.
- `frontend/src/components/` — `NavBar`, `BoardToolbar`, `Column`, `TicketCard`, `TicketSheet`,
  `DeleteTicketDialog`, `ProjectDialog`, and `AgentSession` (the cloud-session pieces shared by
  card, sheet and list — see §7).
- `frontend/src/components/ui/` — the shadcn primitives. Imported today: `button`, `input`,
  `checkbox`, `separator`, `spinner`, `sheet`, `alert-dialog`, `dropdown-menu`, `native-select`.
  `badge.tsx` and `card.tsx` are present but imported by nothing *(verified — no
  `@/components/ui/badge` or `/card` import exists in `frontend/src`)*. Radix (`radix-ui`) is the
  behaviour under the overlay ones.
- `frontend/src/lib/` — `api.ts` (the HTTP seam), `use-board.ts` (the poll), `board.ts` (pure
  derivations), `list.ts` (the List view's sort/filter/prefs), `theme.ts` (`localStorage`-backed
  pref), `utils.ts`
  (`cn` = `clsx` + `tailwind-merge`).
- `frontend/src/index.css` — `@import "tailwindcss"` plus the shadcn token block. Dark mode is a
  **class on `<html>`**, declared with Tailwind v4's `@custom-variant dark`, because the board has
  an explicit toggle that must beat the OS preference *(verified)*.
- Icons come from **two** packages: `lucide-react` and `@tabler/icons-react` *(verified — both are
  imported in `NavBar.tsx`)*.

`@/` resolves to `frontend/src` — aliased in both `vite.config.ts` and `frontend/tsconfig.json`,
so a change to one needs the other *(verified)*.

`frontend/src/lib/board.ts` holds the derivations: `matchesProject`, `matchesSearch`, `sortTickets`,
`ticketsForColumn`, `columnIsWorking` (any `agentState` of `starting`/`working`), `runFailed`
(`agentState === "failed"`), `previewOffered` (has a `branch` and is In Progress/In Review) —
**pure, no DOM, no `fetch`**, and the only
place that decides what a column contains, which is why it is the part worth unit-testing.
`ALL_PROJECTS = "all:projects"` is the picker's sentinel, safe because a project id is a slug and
cannot contain a colon *(verified)*.

## 2. Types come from the backend, not from here

`frontend/src/types.ts` is **re-exports plus two frontend-local things**, and nothing else
*(verified)*. `@10x/backend/types` maps to `backend/src/types.ts` through the backend's `exports`
map, and that file is the single source of truth for the shared vocabulary. Frontend-local:
`SortOrder` and `COLUMNS` (five entries in state-machine order: backlog, todo, in_progress,
in_review, done).

**`PLAYBOOKS` crosses as a runtime `export {}` while everything else is `import type`.** That reads
like an inconsistency and is not: a vocabulary is data, and `PLAYBOOKS` is the exact list the backend
validates against, so re-stating it here is the drift this arrangement exists to prevent. The type
imports are erased by `verbatimModuleSyntax` (set in the root `tsconfig.json`), and the value import
is safe **because `backend/src/types.ts` has no imports at all** *(verified — grep for `^import` in
that file returns nothing)*. That import-freeness is load-bearing: it is what keeps `node:sqlite` and
every other backend module out of the browser bundle. **Adding an import to `backend/src/types.ts`
would drag it into the frontend build** *(inferred — not attempted)*.

`Status` is *both* imported and re-exported, because `COLUMNS` needs it in local scope for its
`satisfies` clause *(verified)*.

### `Ticket` here means `BoardTicket`

`export type { BoardTicket as Ticket }`. The board renders **the `GET /tickets` response shape, never
the stored row** *(verified)*. Since the cloud-session contract (`docs/prototype-cloud.md`) the
backend's `Ticket` carries the session and agent fields itself (`sessionUrl`, `sessionKind`,
`agentState`, `agentNote`, `agentUpdatedAt`, `branch`), and `BoardTicket` adds only `busy` and
`preview` *(verified — `backend/src/types.ts`)*. A component typed against the backend's `Ticket`
**compiles and then renders nothing** for those two, which is the failure mode this alias removes. Type against
`Ticket` from `@/types.ts`; never reach past it into `@10x/backend/types` for a ticket.

## 3. The data layer

**Real data is the default.** `MOCK_MODE` in `frontend/src/lib/api.ts` is
`import.meta.env["VITE_MOCK_MODE"] === "true"` — only that exact string turns fixtures on, so an
unset or misspelled variable serves the real board rather than silently serving plausible-looking
fixtures *(verified)*.

- `lib/api.ts` is the **whole HTTP seam** — every request the board makes goes through one
  `request(method, path, body?)` helper, so a read failure and a write failure read the same:
  method, path, status, and the backend's own error code. It parses the `{error, message?}` JSON
  envelope every route answers with, and falls back to the status text for a body that is not one
  (the dev proxy's own 404, an HTML error page). Losing that code would make every failed write
  read as the same dead button — `transition_has_side_effects` names a caller bug,
  `not_in_backlog` a race, `operation_in_flight` a double-click *(verified)*.
  Reads: `getBoard(projectId)` → `/tickets`, where the `ALL_PROJECTS` sentinel is expressed by
  *omitting* `?project=`, which is how the backend spells "every project"; and `getProjects()` →
  `/projects`. Writes are being added here one button at a time, so **read the file rather than
  trusting a list of them** — a button with no wiring is a missing function here, never a
  half-working handler in a component *(verified: the file's own header states this)*.
  No write bypasses the seam: Steer is an `<a href={sessionUrl}>`, not a request.
  **`VITE_MOCK_MODE` covers reads and project CRUD only — every ticket-mutating write is real,
  always** *(verified)*. `getBoard`/`getProjects` and `createProject`/`updateProject`/
  `deleteProject`/`provisionProject`/`lookupRepo` all branch on `MOCK_MODE` before touching the
  network. `createTicket`, `moveTicket`, `updateTicket`, `startPlanning`, `spawnAgent`,
  `acceptTicket`, `cancelTicket`, `deleteTicket`, `archiveTicket`, `rejectTicket`, `startPreview`
  and `stopPreview` do not — they call `request()` unconditionally. The dev proxy also always points at
  `http://127.0.0.1:4010` regardless of mock mode, and that port is 10x's own live board, not a
  disposable target — a ticket's Preview gets its dev server port from `.env`'s
  `PORT_RANGE_START..END`, never 4010. Clicking Add/Save/Delete/Accept/Reject/Cancel-run while
  "smoke-testing in mock mode" therefore mutates the **real** board over that proxy; this created
  a stray real ticket during 10x-30's own smoke test, cleaned up with `DELETE /tickets/<id>`
  directly against 4010. Mock-mode UI testing of a ticket-mutating button needs either a
  throwaway backend on that port or verification some other way (unit test, code review, or a
  single real click immediately reverted).
- `lib/use-board.ts` owns the only timer: `POLL_MS = 1000`, `setInterval`, both GETs in one
  `Promise.all`. An in-flight tick is **skipped, not queued** — `GET /tickets` is a round trip to
  the hosted database, so overlapping polls stack requests for no extra freshness. A failed poll **keeps the last good board** and hangs the message off it as
  `error`; `App.tsx` renders that as a one-line `role="status"` stale-data banner above the columns,
  never as an overlay. `current` and the in-flight guard are effect-scoped, keyed on `projectId`,
  so a stale response cannot overwrite a newer selection. `useBoard` also returns a **`refresh()`**
  so a write can force an immediate re-read instead of waiting up to a second for the next tick
  *(verified)*.
- **Polling is the only change signal.** Cloud agents write their state straight into the shared
  database, so neither the backend nor the browser is told when it changes; the board sees it on
  the next read. SSE is parked under *Push board updates with SSE instead of polling* in
  [parking-lot](./parking-lot.md). Do not re-argue it here.
- `frontend/src/mock.ts` is retained for design work: fixtures covering every visual state the board
  can reach, typed against the real response shape so they cannot drift from it *(verified)*.
  `MOCK_MODE` starts no timer, and tickets stay static from `mock.ts`. **Projects do not:**
  `use-board.ts` reads `mockProjects.list()` and subscribes to `mockProjects.subscribe`, both
  exported from `api.ts`, so a project added or deleted in the dialog appears without a poll.
  That store is what makes the project dialog — including the queued → downloading → ready
  timeline — usable with no backend running *(verified)*.

**The Vite dev proxy is what makes any of this same-origin.** `vite.config.ts` proxies `/tickets`,
`/projects` and `/webhooks` to `http://127.0.0.1:4010` (the `/screenshots` proxy went with the
screenshot routes); in production the backend serves the built
bundle itself. Paths in `api.ts` are therefore relative on purpose, no origin is ever configured, and
**the zero-dependency backend needs no CORS handling — because it never sees a cross-origin request**
*(verified)*. `build.outDir` is `dist` with the default asset layout, which matters because the
backend's static handler allow-lists only `.html/.css/.js/.svg/.woff2/.ico/.png`
([architecture](./architecture.md)).

## 4. Two layout rules that are easy to destroy

Both are commented at their site; both fail as "the whole page scrolls" rather than as an error.

**`grid-rows-[minmax(0,1fr)]` on `<main>` in `App.tsx`** *(verified)*. A grid's implicit row is
`auto`, so without it the row sizes to the tallest column, the columns grow past the viewport, and
the **page** scrolls instead of each column scrolling inside itself. `min-h-0` on the same element
does the same job one level up, letting the grid shrink below its content. The column's own
`min-h-0 flex-1 overflow-y-auto` list in `Column.tsx` depends on both.

**`min-h-0` on the sheet body in `TicketSheet.tsx`** *(verified)*. `SheetContent` is a flex column
and a flex child defaults to `min-height: auto`, so without it the body refuses to shrink and **the
sheet grows past the viewport** instead of its body scrolling.

## 5. The ARIA contracts the e2e suite depends on

UI assertions use accessible semantics only, so a restyle lands without touching a spec. These are
the four the suite actually locates by; widening any of them into classes or text layout breaks that.

**Exactly one `<header>`** — in `NavBar.tsx`, and the only one in `frontend/src` *(verified)*. It
contains the project picker, named solely by `aria-label="Project"` (the visible "Project" text is
gone). `e2e/board.spec.ts` locates it as
`page.getByRole("banner").getByRole("combobox", { name: "Project" })`; scoping to the landmark is
what separates it from the `TicketSheet`'s own `Project` field.

**That picker must stay a native `<select>`.** `ui/native-select.tsx`, not Radix `Select`
*(verified)*. `board.spec.ts` asserts `picker.getByRole("option", { name })` **without opening
anything**, and Radix portals its options and mounts them only while open — swapping in `Select`
makes that assertion find zero options.

**Columns are `<section aria-labelledby={`${status}-heading`} data-status={status}>`** in
`Column.tsx`, so the region's accessible name carries the live count ("Backlog 2") with no duplicated
string to drift. Two things inside it are contracts, not styling:

- **The count stays inside the `h2`.** Styling it as a pill is safe; moving it out of the heading
  breaks every `getByRole("region", { name: "Backlog 1" })` in the suite.
- **The literal `{" "}` between the label and the count is load-bearing.** Flex `gap` is drawn, not
  text, so without a real whitespace node the accessible name computes as **`Backlog2`** and every
  column locator misses. **This has regressed once already.**
- A control belonging to a column goes **outside** the `h2`'s subtree — the New ticket button lives
  in the column footer for exactly this reason, or it would append its label to the region name.

**Cards are `<article aria-label={ticket.id}>`** in `TicketCard.tsx` *(verified)*. This is now **the
only place a ticket id is exposed to assistive tech** as a name. `spawn.spec.ts` locates a
specific ticket as `getByRole("region", {name: /^In Review/}).getByRole("article", {name: id})` and
then the buttons and links inside it by role and name, so which column a card is in is part of the
contract. `board.spec.ts` asserts all five column names in order
(`["Backlog 1", "To Do 0", "In Progress 0", "In Review 0", "Done 0"]`) and that a Backlog card
offers Plan but no Start *(verified — read from the specs; see [testing](./testing.md))*.

## 6. `capitalize` lies to `textContent`

CSS `text-transform` changes rendering, not the DOM, so a `capitalize`d node's `textContent` is the
lowercase source string while the screen shows it capitalised. Asserting on text content there
produces a false defect report; this cost real time once (on the since-deleted steer-mode toggle).
Assert the accessible name or take the screenshot — never `textContent` on a `capitalize`d node.

## 7. Cloud sessions on the board

The UI for locally run agents is gone *(verified — this branch)*: no steer-mode toggle or
`lib/steer-mode.ts`, no `/focus` call, no worktree/agent-name copy buttons, no Delete worktree, no
diagnostics panel, no `unowned` list, no Before/After screenshot viewer. `components/AgentSession.tsx` holds what
replaced them, shared by card, sheet and List:

- **`AgentStateBadge`** — the agent's self-reported `agentState` (starting = spinner, working =
  pinging sky dot, done, blocked = amber, failed = destructive); renders nothing for `null`. A
  blocked agent's `agentNote` (its question) is the badge's tooltip. `aria-label="Agent <state>"`.
  On a card it takes the chip slot the run timer used to hold (the timer shows only while
  `agentState` is null) and is suppressed on Done cards. A blocked card gets an amber border
  (`data-blocked`), a failed one a destructive border (`data-failed`).
- **`SessionLink`** — Steer is an `<a target="_blank" rel="noopener noreferrer">` to `sessionUrl`
  via `Button asChild`; with no session it is a disabled button whose reason sits on a wrapper
  `title` (a disabled button gets no pointer events). In Progress cards show it as **Steer**; a
  Backlog card with an open *plan* session shows it in place of Plan (a second Plan = a second paid
  session). Every card with a `sessionUrl` also gets a small "Open session" icon link in its top
  row, which is how In Review (three buttons already) reaches its session.
- **Preview** — state is `ticket.preview` from the poll, never local: `previewPhase()` maps it to
  none / running / checkout (`command === ""`, no dev command) / exited. The card slot is a
  **Preview** button (`POST /tickets/:id/preview`), a **Live** link to `preview.url`, or a
  Checkout/Exited button that opens the sheet; Stop preview is in the card's overflow menu.
  `PreviewPanel` in the sheet has start/stop, the url, the copyable checkout path, and for the
  no-dev-command case a hint to set one on the project. Offered only when `previewOffered()`.
- **The sheet's Agent panel** (`<section aria-label="Agent">`, first in the body) shows session kind,
  badge, relative `agentUpdatedAt`, Open session, and `agentNote` — amber "The agent is asking"
  when blocked. Screenshots live as a PR comment, so the sheet links **Screenshots on PR** to
  `prUrl` beside the PR link.
- **Both pages pass the LIVE ticket to `TicketSheet`** (`tickets.find(id) ?? snapshot`), not the
  snapshot from when it opened, so agent state and Preview update while the sheet is up. Safe
  because the form fields are seeded by `useState` initializers under `key={id}` and never
  re-synced from props *(inferred — mock mode does not poll, so typing across a live poll was not
  exercised)*.
- **List** has an **Agent** column (sort key `agent`, first click descending = blocked, failed,
  working, starting, done, none).
- **Project dialog** has an optional **Dev command** field. `POST /projects` does not accept
  `devCommand` *(verified — `backend/src/projects.ts` createProject reads no such key)*, so a new
  project gets it through a follow-up `PATCH` — not atomic with the create.
- **Mock fixtures** (`mock.ts`) cover plan and impl sessions, every agent state (10x-9 blocked with
  a question, 10x-4 failed, 10x-11 starting with no link = disabled Steer), and all preview
  phases (10x-3 running, 10x-test-2 checkout-only, 10x-14 exited); project `10x` has a dev command
  and `10x-test` none *(verified — screenshots in mock mode)*.
