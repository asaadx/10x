# Frontend

**Node:** frontend · Parent: [INDEX.md](./INDEX.md)

The board's browser half — everything under `frontend/`. The server that serves it, the HTTP surface
it calls and the database behind that are in [architecture](./architecture.md).

## 1. Four layers, five modules

Native ES modules, no framework, no build step, no bundler. Line counts are `wc -l`, current as of
this node.

| Layer | File | Lines | Rule |
| --- | --- | --- | --- |
| transport | `js/api.js` | 88 | one `api()` wrapper — it never throws and never swallows, so a network failure and a 500 arrive in the same `{ok, status, body}` shape — plus a named function per endpoint the UI uses. **No DOM.** |
| state | `js/state.js` | 103 | the `state` object, `actionErrors`, `pendingActions`, `copyConfirms`, and the derivations (`isBusy`, `cardIsProtected`, `attachCommandFor`, `prMetaFor`). **No DOM, no `fetch`.** |
| rendering | `js/render.js` | 459 | **every `document` reference in the frontend.** Reads state, writes markup, decides nothing. |
| wiring | `js/app.js` | 276 | what a click means, and the poll loop. **Touches no DOM.** |

Three files sit outside the layering. `js/icons.js` (50) is a table, not a layer: the eight icons JS
renders — steer, finished, died, worktree, busy, and the three PR states — in one map.
`index.html` (93) is markup only: the landmarks, the composer drawer, the unowned panel and the
four columns. `styles.css` (688) is all styling and is read by nothing.

**The Done card's PR meta is the worked example of the layering.** `prMetaFor(ticket)` in
`state.js` decides *whether* there is anything to show and returns `{url, number, state, additions,
deletions}` or `null`; `render.js` only draws it. The state travels as `data-pr-state` on the
container, never as a class, and is **absent when `prState` is `null`** — null means "no webhook has
told us", which is not the same as `open`, so the card shows no icon rather than guessing one. The
±LOC pair renders only when both halves are non-null, with a real U+2212 minus.

The split exists so that **a redesign is layout, colours and icons only** — a change to
`styles.css` and to the templates in `render.js` cannot alter what the board does.

`api.js` covers eleven of the fourteen endpoints. The frontend only *reads* projects
(`GET /projects`); project creation, renaming and deletion are not wired into the UI, though those
three endpoints exist.

## 2. The render/wiring seam

Behaviour crosses it as a **`handlers` object**. `render.js` reads a button's `data-act` and
forwards it verbatim — it has no idea what `"spawn"` does — and `app.js` owns the `CARD_ACTIONS`
dispatch table, guarded by `Object.hasOwn` so an unknown action is dropped rather than thrown.
Cards are reconciled in place through the `cardEls` map, because a card mid-edit must survive a
poll landing underneath it; `cardIsProtected` is what holds such a card back for a cycle.

## 3. Classes style, attributes carry state

Two rules, both load-bearing, both stated at the top of `render.js`.

**Nothing is located by class.** Every lookup is `document.getElementById`, a `[data-*]` selector or
a role. There is no class-based `querySelector`, no `classList` read, no `className` read and no
`closest()` anywhere in `frontend/js/`. *(Verified.)* The one hit for
`git grep -nE 'classList|className|closest\(' frontend/js/` is `el.className = "card"` in
`renderColumn` — a **write** of a constant, which is the rule rather than an exception to it.

**State leaves as an attribute, never as a class:** `data-busy` / `data-blocked` / `data-died` on a
card, `data-status` on a badge and on each column, `data-icon` on a badge icon, `data-pr-state` on
a Done card's PR meta, `data-flagged` and `data-race-tag` in diagnostics, `data-empty` on the
empty-column placeholder, and the native `hidden` attribute on the unowned panel and the
board-error banner. The composer drawer is the one exception, and only because the platform owns
it: a `<dialog>`'s `open` is set by `showModal()`/`close()`, never by us.

`render.js` *does* emit class names — `card`, `badge`, `primary`, `danger`, `ghost`, `card-top` and
some thirty in total — but every one is a **static styling handle that JS only ever writes**. None
is read back, computed from state, or used to find an element. So renaming or deleting a class can
change how the board looks and **cannot** change what it does, and that single property is what
makes a restyle reviewable as a restyle. The behaviour hooks are attributes instead: `data-id` and
`data-act` on cards and buttons, `data-field` on the two edit inputs, `data-empty` on the
placeholder.

The mirror problem was fixed too: `#composer-form` was styled by the id JS needs, so the id stayed
the behaviour hook and `.composer-form` became the styling hook.

### What adding a column actually cost

In Review was the first real test of these seams, and it landed in **four edits and no stylesheet
change**: a `<div class="column" role="region" aria-labelledby data-status>` in `index.html`, one
`renderColumn(...)` line in `renderBoard`, one `else if` in the card's action list, and nothing
else. Done, the fourth column, cost the same shape plus **two lines of CSS**: 4 lines of
`index.html`, 20 of `render.js`, 4 of `api.js`, 2 of `app.js`, 2 of `styles.css` *(verified from
the commit diffstat)*. No layout change either time.

Two reasons it was that cheap, both worth preserving. `main.board` is a **flex row of `flex: 1;
min-width: 0` columns**, so an n-th column shares the width without any per-column rule to add or
a grid template to renumber. And `renderColumn(containerId, countId, status, handlers)` was already
parameterised by status, so a column is data rather than code.

The one thing the seams did **not** decide is what a card in a new column may offer. That was a
real bug found by the exercise: the action list branched `backlog` / `else`, so a ticket in review
inherited In Progress's Cancel — a button whose endpoint answers 409 from there. **One branch per
status, never an `else`**, so a new status renders no action rather than the wrong one.

## 4. Design tokens

`styles.css` declares **77 custom properties, all of them on `:root`** — every colour, space,
radius and type value in the design. The spacing scale is **named by its current pixel value**
(`--space-9: 9px`): the design uses fourteen distinct spacings, enumerating them is the finding, and
a name that lied about its value would make collapsing the list harder rather than easier. Two icons
live in `:root` rather than in `icons.js` — `--icon-disclosure-closed` and
`--icon-disclosure-open`, the diagnostics disclosure triangles — because they are CSS `content` and
JS never renders them.

**Adding a token means adding a line, never rewriting the block.** A missing custom property fails
**silently** — `var(--gone)` resolves to nothing and the element quietly inherits, with no console
rules hundreds of lines below `:root` (the idle/done badge, the completion checkmark, a card
accent), so dropping them while adding `--purple` broke three unrelated surfaces and the only
symptom was a green `+412` rendering purple. Verified in the browser, not by review.

## 5. It polls

`setInterval(loadTickets, 1000)` and `setInterval(loadProjects, 5000)`. A failed poll keeps the
last-known board on screen and shows the board-error banner with the actual message rather than
blanking it.
The 1 s poll is a **placeholder**: the backend already learns of `pane.agent_status_changed` the
instant it fires, so only the browser is behind. SSE is parked, with a sketch, in
[parking-lot](./parking-lot.md).

## 6. The attach command is built client-side

```js
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);
const host = location.hostname;
const prefix = LOOPBACK.has(host) ? "herdr" : `herdr --remote ${host}`;
return `${prefix} agent attach ${ticket.agentName}`;
```

It lives in `state.js`, not on the server, because it needs `location.hostname` — which the server
cannot know — so a server-side copy would be unreachable duplication. The board is always served
*from* the Herdr host (the backend needs Herdr's unix socket), so `location.hostname` is always the
right host: open it on the host and you are already there, so a bare `herdr agent attach` is correct
and `--remote` would make herdr SSH to itself; open it over the tailnet and that same hostname is
the one to pass. Zero configuration, correct from either machine. (`--remote` is a global flag, so
it precedes the subcommand.)

## 7. What the e2e suite is allowed to locate

**UI assertions use accessible semantics only** — a redesign is planned, and this is the contract
that lets one land without touching the specs. It held: the light re-palette, removing the
connection pill and moving the composer into a drawer were **18/18 green with no spec edited**.
The `<header>` is the `banner` landmark, and scoping to it is what separates the board's project
combobox from the drawer's identically labelled one — now doubly unambiguous, since a closed
`<dialog>` is out of the accessibility tree entirely.
Each **column is a `region` labelled by its own heading** via `aria-labelledby`, so its accessible
name carries the live count (`"Backlog 1"`) with no duplicated string to drift, and the heading
itself is still assertable. **A control belonging to a column goes beside that heading, never
inside it** — the New ticket button nested in the `h2` would have made the region's name
`"Backlog 1 New ticket"`.

**A card is an `article` named by its ticket id**, which is how a spec says "*this* ticket shows the
finished badge": `getByRole("region", {name: /^In Review/}).getByRole("article", {name: id})`,
then `getByTitle` inside it — the badges' `title` is their accessible handle. `resilience.spec.ts`
and the completion test in `spawn.spec.ts` use exactly that, and **which column a card is in is now
part of the contract**: a settled turn moves the ticket to In Review by itself, so the locator's
column is the assertion.

**`spawn.spec.ts`'s first test has not been migrated and still scopes by
`#in-progress-cards [data-id="<id>"]`** — DOM structure plus an element id, which is why
`id="in-progress-cards"` and the cards' `data-id` must both stay until it is. It is the last place
the suite breaks its own rule; port it to the locator above. Do not widen any of these into
asserting on classes or text layout.
