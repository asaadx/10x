# Frontend

**Node:** frontend · Parent: [INDEX.md](./INDEX.md)

The board's browser half — everything under `public/`. The server that serves it, the HTTP surface
it calls and the database behind that are in [architecture](./architecture.md).

## 1. Four layers, five modules

Native ES modules, no framework, no build step, no bundler. Line counts are `wc -l`, current as of
this node.

| Layer | File | Lines | Rule |
| --- | --- | --- | --- |
| transport | `js/api.js` | 80 | one `api()` wrapper — it never throws and never swallows, so a network failure and a 500 arrive in the same `{ok, status, body}` shape — plus a named function per endpoint the UI uses. **No DOM.** |
| state | `js/state.js` | 87 | the `state` object, `actionErrors`, `pendingActions`, `copyConfirms`, and the derivations (`isBusy`, `cardIsProtected`, `attachCommandFor`). **No DOM, no `fetch`.** |
| rendering | `js/render.js` | 415 | **every `document` reference in the frontend.** Reads state, writes markup, decides nothing. |
| wiring | `js/app.js` | 244 | what a click means, and the poll loop. **Touches no DOM.** |

Three files sit outside the layering. `js/icons.js` (34) is a table, not a layer: the five icons JS
renders — steer, finished, died, worktree, busy — in one map. `index.html` (73) is markup only: the
landmarks, the composer, the unowned panel and the two columns. `styles.css` (651) is all styling
and is read by nothing.

The split exists so that **a redesign is layout, colours and icons only** — a change to
`styles.css` and to the templates in `render.js` cannot alter what the board does.

`api.js` covers nine of the twelve endpoints. The frontend only *reads* projects
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
`closest()` anywhere in `public/js/`. *(Verified.)*

**State leaves as an attribute, never as a class:** `data-busy` / `data-blocked` / `data-died` on a
card, `data-status` on a badge and on each column, `data-icon` on a badge icon,
`data-state="live|failing"` on the connection pill, `data-flagged` and `data-race-tag` in
diagnostics, `data-empty` on the empty-column placeholder, and the native `hidden` attribute on the
unowned panel and the board-error banner.

`render.js` *does* emit class names — `card`, `badge`, `primary`, `danger`, `ghost`, `card-top` and
some thirty in total — but every one is a **static styling handle that JS only ever writes**. None
is read back, computed from state, or used to find an element. So renaming or deleting a class can
change how the board looks and **cannot** change what it does, and that single property is what
makes a restyle reviewable as a restyle. The behaviour hooks are attributes instead: `data-id` and
`data-act` on cards and buttons, `data-field` on the two edit inputs, `data-empty` on the
placeholder.

The mirror problem was fixed too: `#composer-form` was styled by the id JS needs, so the id stayed
the behaviour hook and `.composer-form` became the styling hook.

## 4. Design tokens

`styles.css` declares **77 custom properties, all of them on `:root`** — every colour, space,
radius and type value in the design. The spacing scale is **named by its current pixel value**
(`--space-9: 9px`): the design uses fourteen distinct spacings, enumerating them is the finding, and
a name that lied about its value would make collapsing the list harder rather than easier. Two icons
live in `:root` rather than in `icons.js` — `--icon-disclosure-closed` and
`--icon-disclosure-open`, the diagnostics disclosure triangles — because they are CSS `content` and
JS never renders them.

## 5. It polls

`setInterval(loadTickets, 1000)` and `setInterval(loadProjects, 5000)`. A failed poll keeps the
last-known board on screen and flips the connection pill to "poll failing" rather than blanking it.
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
that lets one land without touching the specs. The `<header>` is the `banner` landmark, and scoping
to it is what separates the board's project combobox from the composer's identically labelled one.
Each **column is a `region` labelled by its own heading** via `aria-labelledby`, so its accessible
name carries the live count (`"Backlog 1"`) with no duplicated string to drift, and the heading
itself is still assertable.

**A card is an `article` named by its ticket id**, which is how a spec says "*this* ticket shows the
finished badge": `getByRole("region", {name: /^In Progress/}).getByRole("article", {name: id})`,
then `getByTitle` inside it — the badges' `title` is their accessible handle. `resilience.spec.ts`
uses exactly that.

**`spawn.spec.ts` has not been migrated and still scopes by `#in-progress-cards [data-id="<id>"]`**
— DOM structure plus an element id, which is why `id="in-progress-cards"` and the cards' `data-id`
must both stay until it is. It is the last place the suite breaks its own rule; port it to the
locator above. Do not widen any of these into asserting on classes or text layout.
