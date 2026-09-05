---
name: visual-diff
description: Capture matching before/after screenshots of this ticket's UI change for the board's Before/After panes.
allowed-tools: Bash(npx:*) Bash(curl:*)
---

# Visual diff

You are 10x's implementation agent for one ticket, working in your own worktree. This skill is
how the board's Before/After panes get filled — nobody captures them for you, and nobody
captures them after you if you don't.

## Decide first, before you touch anything

Read the ticket. If it changes something a person would *look at* — a page, a component, a
sheet, a drawer, a modal, a hover state, an empty vs. populated state — this applies. If it is
backend-only, has no dev server, or you cannot determine a dev command for this repo, it does
not: skip capture entirely and say so in your turn summary (see "Report, always" below). Do not
guess a command that doesn't exist and do not spend more than a minute deciding.

**If you are capturing, do the "before" shot now, as your very first action, before editing a
single file.** Your worktree's HEAD is the base branch until you make your first commit — this
is the only point in your whole turn where "before" exists. There is no going back for it: no
`git stash`, no `git checkout` of the base branch, no merge-base trick recovers it once you've
started editing. If you write code before capturing "before", you have lost it for this run.

## Frame the change, not the home page

Most UI changes live behind interaction, not on the page you land on. Before capturing anything:

- Identify the exact route and the exact sequence of interactions (clicks, a hover, a filled
  field, opening a sheet or drawer) needed to bring the changed surface into view.
- Write that sequence down for yourself. You will replay it **identically** for "after" — same
  route, same clicks, same order — or the two shots will not be comparable.
- If the changed element does not exist yet on the base branch — a brand-new modal has no
  trigger there — capture the closest equivalent surface for "before" instead of skipping it
  (e.g. the page it will be triggered from, or the state it replaces).

## Run the dev server yourself

Start the project's own dev server, bound inside this worktree's reserved port block — read
`PORT` (and `PORT_RANGE_START`/`PORT_RANGE_END` if you need more than one process) from the
`.env` this worktree was given, never a hardcoded port. You do not need to stop it afterward:
10x reaps whatever it finds bound inside your block once your turn settles.

## Capture with playwright-cli, not `playwright screenshot`

Use `npx playwright-cli@0.262.0` (pinned — do not let npx resolve a floating version), never
`npx playwright screenshot`: the plain screenshot command can only navigate and shoot once,
while `playwright-cli` holds a session across invocations, which is what lets you click through
a multi-step interaction before the shot is taken.

```bash
npx playwright-cli@0.262.0 open
npx playwright-cli@0.262.0 resize 1680 940
npx playwright-cli@0.262.0 goto http://localhost:$PORT/the/affected/route
# replay whatever interaction steps bring the changed surface into view, e.g.:
npx playwright-cli@0.262.0 click e12
npx playwright-cli@0.262.0 screenshot --hires --filename=/tmp/10x-before.png
npx playwright-cli@0.262.0 close
```

Parameters are fixed, identical on both sides:

- **1680x940 viewport** — the size this repo's own watched demo already uses, and it clears the
  board's `max-w-[1600px]`.
- **`--hires`** (2x pixel density) — the board is viewed on a retina display; a 1x capture looks
  soft once enlarged.
- **A plain viewport screenshot, never `--full-page`.** `ScreenshotPane` renders the image
  `aspect-video w-full object-cover`, forcing 16:9 and cropping to fill. 1680x940 is 1.787:1 and
  lands essentially uncropped; a long full-page capture would show only a cropped middle band as
  the thumbnail. The enlarged view on click is what keeps an honest crop from mattering.

Screenshots only. No video, no `ffmpeg`, no `playwright-cli video-*`.

**Capture "after" last** — after your final commit, right before you end your turn. It has to be
the last thing you do, or a later edit invalidates it the same way editing before "before"
would.

## Upload both shots

The 10x API lives at `{{apiUrl}}`, and your own ticket's id there is `{{ticketId}}` — both come
from your system prompt, not from anything in this worktree. POST each PNG's raw bytes, one
side at a time, with an `image/png` content type:

```bash
curl -sf --data-binary @/tmp/10x-before.png -H "Content-Type: image/png" \
  {{apiUrl}}/tickets/{{ticketId}}/screenshots/before
curl -sf --data-binary @/tmp/10x-after.png -H "Content-Type: image/png" \
  {{apiUrl}}/tickets/{{ticketId}}/screenshots/after
```

A non-2xx response means the upload did not land — retry once, and if it still fails, say so in
your turn summary rather than silently moving on. The images never touch your worktree's git
tree: they are POSTed straight from wherever you saved them (e.g. `/tmp`), never written inside
the repo, so there is nothing to `.gitignore` and nothing that can end up in your commit or the
pull request.

## Report, always

A settled turn and a deliberate skip look identical to anything watching from outside. Your turn
summary must say one of, plainly:

- which two screenshots you captured and uploaded, or
- exactly why you skipped: no UI change, no dev server, or no determinable dev command.

Never end your turn having simply forgotten — that is indistinguishable from success to
everyone but you.
