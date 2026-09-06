import { ChevronLeftIcon, ChevronRightIcon, ImageIcon, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { DeleteTicketDialog } from "@/components/DeleteTicketDialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { createTicket, moveTicket, updateTicket } from "@/lib/api.ts";
import { runFailed } from "@/lib/board.ts";
import { cn } from "@/lib/utils.ts";
import {
  PLAYBOOKS,
  type Playbook,
  type Project,
  type ScreenshotSide,
  type Status,
  type Ticket,
} from "@/types.ts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  defaultProjectId: string;
  /** The ticket being viewed, or null to create a new one. */
  ticket: Ticket | null;
  /**
   * The column whose New ticket button opened this. `POST /tickets` always lands in `backlog`,
   * so `todo` is the one value that costs a follow-up move; see `submit` below.
   */
  createInto: Status;
  /**
   * The last card action that failed for this ticket, or null. It lives in `TicketCard` state
   * — that is where the write is dispatched from — and the card hands it over when it opens
   * this sheet, so the message does NOT survive a reload or either component remounting. The
   * card only has room for a one-word `failed` chip, so this is where the text is read.
   */
  actionError: string | null;
  /** A ticket was created, so the board should re-read rather than wait out the poll. */
  onCreated: () => void;
  /** An edit was saved, so the board should re-read rather than wait out the poll. */
  onSaved: () => void;
};

/**
 * One labelled Before/After pane: the image when its url is captured, or a placeholder when it
 * isn't. Extracted so the two panes below share this markup instead of duplicating it.
 *
 * Clicking the thumbnail opens the shared `ScreenshotLightbox` below on this pane's own image —
 * enlargement state lives one level up in `TicketSheet` rather than here, so Before and After
 * share a single dialog instead of each mounting its own, and the lightbox can page between them
 * without one pane's state having to know the other exists. The thumbnail is a `<button>` rather
 * than an `onClick` on the `<img>` so it is keyboard-reachable and gets a focus ring.
 */
function ScreenshotPane({
  label,
  url,
  onEnlarge,
}: {
  label: string;
  url: string | null;
  onEnlarge: () => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      {url ? (
        <button
          type="button"
          onClick={onEnlarge}
          aria-label={`Enlarge ${label} screenshot`}
          className="block aspect-video w-full overflow-hidden rounded-md border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <img src={url} alt={label} className="size-full object-cover" />
        </button>
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-md border bg-muted text-xs text-muted-foreground">
          <ImageIcon aria-hidden className="size-5" />
          No screenshot
        </div>
      )}
    </div>
  );
}

const SCREENSHOT_LABELS: Record<ScreenshotSide, string> = { before: "Before", after: "After" };

/**
 * The single enlarged view shared by both `ScreenshotPane`s, so paging between Before and After
 * doesn't close and reopen a dialog. `side` is which one is open, or null when closed; each
 * pane's click sets it directly to its own side, so the lightbox opens on whichever was clicked
 * rather than always defaulting to one. `screenshots` is read straight off the ticket so a
 * missing side is never treated as "the same image twice".
 *
 * No close-X: it used to draw at `opacity-70` directly over the raw image with no backing chip,
 * invisible on a screenshot with a light corner. Escape and clicking the overlay both still
 * close it — that's Radix's own dismissable-layer behaviour, `showCloseButton` only toggles the
 * button.
 */
function ScreenshotLightbox({
  screenshots,
  side,
  onOpenChange,
  onSelect,
}: {
  screenshots: { before: string | null; after: string | null };
  side: ScreenshotSide | null;
  onOpenChange: (open: boolean) => void;
  onSelect: (side: ScreenshotSide) => void;
}) {
  const open = side !== null;
  const bothExist = screenshots.before !== null && screenshots.after !== null;

  // Left/right cycle Before <-> After, but only while open and only when there is a second
  // side to cycle to — with one side missing, the keys have nothing to do.
  useEffect(() => {
    if (!open || !bothExist) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") onSelect("before");
      else if (event.key === "ArrowRight") onSelect("after");
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, bothExist, onSelect]);

  // Radix unmounts DialogContent while closed, so this fallback is never actually shown — it
  // only keeps the render below type-safe between the last open side and null.
  const shown = side ?? "before";
  const url = screenshots[shown];
  const label = SCREENSHOT_LABELS[shown];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="max-w-4xl p-2">
        <DialogTitle className="sr-only">{label} screenshot, enlarged</DialogTitle>
        <div className="flex items-center gap-2">
          {bothExist && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Show before screenshot"
              onClick={() => onSelect("before")}
              className="shrink-0"
            >
              <ChevronLeftIcon aria-hidden />
            </Button>
          )}
          {url && (
            <img src={url} alt={label} className="min-w-0 flex-1 max-h-[80vh] rounded-md object-contain" />
          )}
          {bothExist && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Show after screenshot"
              onClick={() => onSelect("after")}
              className="shrink-0"
            >
              <ChevronRightIcon aria-hidden />
            </Button>
          )}
        </div>
        <div className="grid justify-items-center gap-1.5">
          <span className="text-sm font-medium">{label}</span>
          {bothExist && (
            <div className="flex gap-1.5" role="group" aria-label="Screenshot">
              {(["before", "after"] as const satisfies readonly ScreenshotSide[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-label={`Show ${SCREENSHOT_LABELS[s]} screenshot`}
                  aria-current={s === shown}
                  onClick={() => onSelect(s)}
                  className={cn(
                    "size-2 rounded-full transition-colors",
                    s === shown ? "bg-foreground" : "bg-muted-foreground/40 hover:bg-muted-foreground/70",
                  )}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

type ChecklistRow = { text: string; done: boolean };

// Blank rows are dropped except the trailing one, so the list never accumulates gaps, and a
// fresh empty row is appended so the list always ends on the row that is still an input.
function normalizeChecklistRows(rows: ChecklistRow[]): ChecklistRow[] {
  return [...rows.filter((row) => row.text.trim() !== ""), { text: "", done: false }];
}

// A row's text is free-form and can be far wider than the sheet, so the row element is a
// textarea that wraps instead of an input that scrolls its caret out of view. Tailwind alone
// can't grow a textarea to fit wrapped content, so height is measured and set imperatively:
// collapse to "auto" first so a shrinking edit (deleting a wrapped line) is picked up too, then
// grow to `scrollHeight`. Called both from the row's `ref` (sizes existing content — an edited
// ticket's rows — as soon as the element mounts) and from its `onChange` (a mounted textarea's
// ref callback fires only on mount/unmount, never again, so typing needs its own resize call).
function autoGrowChecklistRow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * Task Breakdown and Acceptance Criteria are both this same growing checklist: the plan a Plan
 * agent is meant to produce, held here as local state because there is no field for it yet. The
 * trailing empty row is always present and is the input line — typing into it grows the list by
 * one, so there is no separate "add row" affordance — and the `done/total` count this heading
 * shows is what an In Review card would eventually surface.
 */
function Checklist({
  label,
  rows,
  onRowsChange,
}: {
  label: string;
  rows: ChecklistRow[];
  onRowsChange: (rows: ChecklistRow[]) => void;
}) {
  const total = rows.length - 1;
  const done = rows.slice(0, total).filter((row) => row.done).length;

  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-muted-foreground">
        {label} <span>{done}/{total}</span>
      </label>
      <div className="grid gap-1">
        {rows.map((row, index) => {
          const trailing = index === rows.length - 1;
          return (
            <div key={index} className="flex items-start gap-2">
              <Checkbox
                checked={row.done}
                disabled={trailing}
                className="mt-1"
                onCheckedChange={(checked) =>
                  onRowsChange(rows.map((r, i) => (i === index ? { ...r, done: checked === true } : r)))
                }
              />
              <textarea
                ref={autoGrowChecklistRow}
                value={row.text}
                onChange={(e) => {
                  const next = rows.map((r, i) => (i === index ? { ...r, text: e.target.value } : r));
                  onRowsChange(normalizeChecklistRows(next));
                  autoGrowChecklistRow(e.target);
                }}
                placeholder={trailing ? "Add an item…" : undefined}
                rows={1}
                className={cn(
                  "w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent text-sm leading-6 outline-none placeholder:text-muted-foreground",
                  row.done && "line-through text-muted-foreground"
                )}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Real drag target: dragging over it flips it to the primary accent, dropping resets that. It
 * takes no files — an attachment is only worth storing once it can be fed into the agent's
 * spawn prompt, which isn't wired up yet — so drop is deliberately inert.
 */
function AttachmentDropZone() {
  const [dragging, setDragging] = useState(false);

  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-muted-foreground">Attachments</label>
      <div
        // preventDefault on dragover is what makes this element a drop target at all; without
        // it the browser rejects the drop and the cursor never changes to reflect one.
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        className={cn(
          "flex h-24 flex-col items-center justify-center gap-1.5 rounded-md border border-dashed text-xs text-muted-foreground",
          dragging && "border-primary bg-primary/5 text-primary"
        )}
      >
        <Upload aria-hidden className="size-5" />
        Drag files here, or click to browse
      </div>
    </div>
  );
}

// A `<select>` hands back a bare string, so this is the boundary where that string becomes a
// `Playbook`. A membership test against the shared array rather than a cast: the state is
// typed against exactly the list the API validates against, so nothing but a real playbook
// can reach it, and an option that ever drifted out of `PLAYBOOKS` would be ignored here
// instead of being sent as a write the backend then rejects.
const isPlaybook = (value: string): value is Playbook =>
  PLAYBOOKS.some((playbook) => playbook === value);

/**
 * Opened either from a column footer's New ticket button, with `ticket` null, or from a
 * card's title/overflow menu, with `ticket` set — the one detail surface for both creating and
 * viewing/editing. `Sheet` is Radix Dialog underneath, so Escape, the backdrop and focus
 * containment are the platform's job rather than hand-written focus code — the same reason the
 * previous implementation used a native `<dialog>`.
 */
export function TicketSheet({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  ticket,
  createInto,
  actionError,
  onCreated,
  onSaved,
}: Props) {
  const creating = ticket === null;
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [projectId, setProjectId] = useState(ticket?.projectId ?? defaultProjectId);
  // Playbook decides which agent profile a spawn uses. It is editable at any point, unlike
  // Project, because it is a choice rather than something derived — and changing it after a run
  // has started cannot affect the agent already running, only the next dispatch. The sheet
  // already has a row called Agent for the running Herdr agent's name, so this control is named
  // Playbook rather than colliding with it. It is local state only: `POST /tickets` narrows the
  // body to `{projectId, title, description}`, so there is nowhere to send this yet.
  // Every ticket has one: the column is NOT NULL, and its default is the first entry of
  // `PLAYBOOKS`, which is also what the picker shows first — so seeding a create with it
  // matches what the API would store anyway, without naming a playbook value here.
  const [playbook, setPlaybook] = useState<Playbook>(ticket?.playbook ?? PLAYBOOKS[0]);
  // Task Breakdown and Acceptance Criteria are the plan a Plan agent produces, and they do come
  // off the wire — the planning agent PATCHes them onto the ticket, and both non-empty is the
  // readiness signal the card's To Do button reads. What is not wired is writing them from
  // here: Save has no handler, so edits made in this sheet are local and lost on close.
  // Seeded from `ticket` via a `useState` initializer rather than an effect: `App.tsx` keys this
  // component by ticket id, so React remounts (and re-runs this initializer) whenever a
  // different ticket opens — no sync needed. Seeding goes through `normalizeChecklistRows`
  // rather than the raw ticket array: that is what appends the trailing blank row Checklist
  // treats as the add-new-item input, for both a persisted-but-empty array and one that
  // already has real saved items — without it, the last real item gets mistaken for that
  // blank row instead.
  const [taskBreakdown, setTaskBreakdown] = useState<ChecklistRow[]>(
    normalizeChecklistRows(ticket?.taskBreakdown ?? []),
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<ChecklistRow[]>(
    normalizeChecklistRows(ticket?.acceptanceCriteria ?? []),
  );
  const [submitting, setSubmitting] = useState(false);
  // The last failed create. The sheet stays OPEN on failure and keeps everything typed —
  // discarding a description because the network blinked would be the expensive mistake — so
  // the message sits next to the button that failed and the same click retries.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Which side, if any, the shared screenshot lightbox is showing. Lives here rather than in
  // `ScreenshotPane` so Before and After share one dialog instead of each mounting its own —
  // see `ScreenshotLightbox`'s own comment for why that matters.
  const [lightboxSide, setLightboxSide] = useState<ScreenshotSide | null>(null);

  // The callsite's `key` re-seeds this component when a *different* ticket is opened, but the
  // create key is the constant "new", so the composer never remounts between one creation
  // attempt and the next. This reset is what stops a half-typed new ticket from surviving
  // Cancel, and what discards unsaved edits when backing out of viewing an existing one.
  const close = (next: boolean) => {
    if (!next) {
      setTitle(ticket?.title ?? "");
      setDescription(ticket?.description ?? "");
      setProjectId(ticket?.projectId ?? defaultProjectId);
      setPlaybook(ticket?.playbook ?? PLAYBOOKS[0]);
      setTaskBreakdown(normalizeChecklistRows(ticket?.taskBreakdown ?? []));
      setAcceptanceCriteria(normalizeChecklistRows(ticket?.acceptanceCriteria ?? []));
      setSubmitError(null);
    }
    onOpenChange(next);
  };

  /**
   * Create, then move only if the click came from the To Do column's footer.
   *
   * `POST /tickets` hardcodes `backlog` because a new ticket is a raw idea, so that button
   * needs a second call to land the card where it says it will. The pair is NOT atomic and is
   * not pretended to be: if the move fails the ticket exists in Backlog and the error says so,
   * which the card's own To Do button then retries. Refusing to create at all would be the
   * worse trade.
   */
  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createTicket({ projectId, title: title.trim(), description });
      if (createInto === "todo") await moveTicket(created.id, "todo");
      onCreated();
      close(false);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Saves edits to an existing ticket. `normalizeChecklistRows` appends a trailing blank input
   * row for editing, so its output is filtered back down to only the rows with real text
   * before either checklist reaches the PATCH body — the draft row itself is never sent.
   */
  const save = async () => {
    if (submitting || ticket === null) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await updateTicket(ticket.id, {
        title: title.trim(),
        description,
        playbook,
        taskBreakdown: normalizeChecklistRows(taskBreakdown).filter((row) => row.text.trim() !== ""),
        acceptanceCriteria: normalizeChecklistRows(acceptanceCriteria).filter((row) => row.text.trim() !== ""),
      });
      onSaved();
      close(false);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  const failed = !creating && runFailed(ticket);
  // A branch/agent name is a formula over the project slug and ticket number (memory/naming.md),
  // so it is non-empty even for a ticket that has never been spawned — dispatched is the actual
  // existence check for those two rows.
  const dispatched = ticket !== null && (ticket.sessionDir !== null || ticket.hasWorktree);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader className="shrink-0">
          <SheetTitle>{creating ? "New ticket" : ticket.id}</SheetTitle>
          {creating && (
            <SheetDescription>Describe the work. The agent reads the title and description.</SheetDescription>
          )}
        </SheetHeader>

        {/*
          Project leads: it decides which repo the agent is dispatched into, so choosing it
          after writing the work is choosing it too late. It has no default when the board is
          showing every project, because "all" is not somewhere a ticket can be created.

          `min-h-0` is load-bearing, not decoration: `SheetContent` is a flex column and a flex
          child defaults to `min-height: auto`, so without it this div refuses to shrink below
          its content and the whole sheet grows past the viewport instead of just this body
          scrolling — the same trap documented on the board grid in App.tsx. `flex-1` lets it
          claim the space left by the header and footer, and `overflow-y-auto` is what actually
          scrolls it.
        */}
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto px-4 pb-6">
          <div className="grid gap-1.5">
            <label htmlFor="c-project" className="text-xs text-muted-foreground">
              Project <span className="text-destructive">*</span>
            </label>
            {/* A ticket cannot change project once created: its branch and worktree are already
                derived from the project slug. */}
            <NativeSelect
              id="c-project"
              required
              disabled={!creating}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full"
            >
              <NativeSelectOption value="">Select a project</NativeSelectOption>
              {projects.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="c-playbook" className="text-xs text-muted-foreground">
              Playbook
            </label>
            <NativeSelect
              id="c-playbook"
              aria-label="Playbook"
              value={playbook}
              onChange={(e) => {
                const next = e.target.value;
                // Every option below is a `PLAYBOOKS` member, so the guard never rejects a
                // real change; it is what keeps an unvalidated string out of typed state.
                if (isPlaybook(next)) setPlaybook(next);
              }}
              className="w-full"
            >
              {PLAYBOOKS.map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="c-title" className="text-xs text-muted-foreground">
              Title <span className="text-destructive">*</span>
            </label>
            <Input
              id="c-title"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short summary"
            />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="c-desc" className="text-xs text-muted-foreground">
              Description
            </label>
            <textarea
              id="c-desc"
              rows={creating ? 8 : 12}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should the agent do?"
              className="min-h-24 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>

          {/* A before/after pair is evidence for the change the description above just
              described, so it reads with the description rather than after the plan below —
              shown only when at least one side has been captured. The `screenshots` object is
              always present on a ticket now (only its sides are nullable), so testing the
              object itself would show this block on every ticket; testing the sides is what
              actually means "a shot exists". `ScreenshotPane`'s placeholder covers whichever
              side is still null. */}
          {!creating && (ticket.screenshots.before !== null || ticket.screenshots.after !== null) && (
            <div className="grid gap-4">
              <ScreenshotPane
                label="Before"
                url={ticket.screenshots.before}
                onEnlarge={() => setLightboxSide("before")}
              />
              <ScreenshotPane
                label="After"
                url={ticket.screenshots.after}
                onEnlarge={() => setLightboxSide("after")}
              />
            </div>
          )}

          <Checklist label="Task Breakdown" rows={taskBreakdown} onRowsChange={setTaskBreakdown} />

          <Checklist label="Acceptance Criteria" rows={acceptanceCriteria} onRowsChange={setAcceptanceCriteria} />

          <AttachmentDropZone />

          {!creating && (
            <>
              <Separator />

              {/* These three rows always render, disabled, so the sheet does not change shape
                  between tickets. A branch name and an agent name are formulas over the project
                  slug and ticket number (memory/naming.md), so both are non-empty strings on
                  every ticket whether or not a run was ever spawned — filling the field with
                  that name would claim something exists that does not, so it is left empty with
                  a placeholder instead. */}
              <div className="grid gap-4">
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground">Branch</label>
                  <Input
                    readOnly
                    disabled
                    value={dispatched ? ticket.branch : ""}
                    placeholder="Created when the run starts"
                  />
                </div>

                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground">Worktree</label>
                  <Input
                    readOnly
                    disabled
                    value={ticket.worktreePath ?? ""}
                    placeholder="No worktree on disk"
                  />
                </div>

                {/* Accept is `retireAgent`, which closes the pane and deletes the transcript
                    (memory/teardown.md), so a Done ticket's agent is genuinely gone rather than
                    never created — its placeholder says so instead of the generic one. */}
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground">Agent</label>
                  <Input
                    readOnly
                    disabled
                    value={dispatched && ticket.status !== "done" ? ticket.agentName : ""}
                    placeholder={
                      ticket.status === "done"
                        ? "Retired when the pull request opened"
                        : "Spawned when the run starts"
                    }
                  />
                </div>

                {ticket.prUrl && (
                  <div className="grid gap-1.5">
                    <label className="text-xs text-muted-foreground">Pull request</label>
                    <a
                      href={ticket.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-sm underline-offset-2 hover:underline"
                    >
                      <span className="font-mono">PR #{ticket.prNumber}</span>
                      {ticket.prAdditions !== null && ticket.prDeletions !== null && (
                        <span className="font-mono text-xs">
                          <span className="text-emerald-600 dark:text-emerald-400">+{ticket.prAdditions}</span>{" "}
                          <span className="text-red-600 dark:text-red-400">&minus;{ticket.prDeletions}</span>
                        </span>
                      )}
                    </a>
                  </div>
                )}
              </div>
            </>
          )}

          {failed && (
            <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              Run died — the pane exited before finishing. The worktree was kept so you can inspect it.
            </p>
          )}

          {/* Off unless VITE_DIAGNOSTICS=true; see .env.example at the repo root. */}
          {!creating && import.meta.env["VITE_DIAGNOSTICS"] === "true" && ticket.diagnostics && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-2 font-mono text-[11px] text-muted-foreground">
              {Object.entries(ticket.diagnostics).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>

        {/*
          The same slot and the same styling as the create failure below, for the same reason:
          outside the scrolling body, so the message someone opened this sheet to read cannot
          be scrolled past or missed. The card carries a one-word `failed` chip and nothing
          else, so this is the only place the text exists — wrapped rather than truncated, and
          selectable so it can be copied into a bug report.
        */}
        {!creating && actionError !== null && (
          <div className="mx-4 grid shrink-0 gap-1.5">
            <label className="text-xs text-muted-foreground">Last action failed</label>
            <p
              role="status"
              className="rounded-md bg-destructive/10 p-2 text-xs break-words text-destructive select-text"
            >
              {actionError}
            </p>
          </div>
        )}

        {/*
          Outside the scrolling body and above the footer, so it is visible wherever the body
          happens to be scrolled to — a create failure the user has to scroll to find is a
          create failure they will read as a dead button. Same styling as the dead-run notice
          above.
        */}
        {submitError !== null && (
          <p role="status" className="mx-4 shrink-0 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            {submitError}
          </p>
        )}

        <SheetFooter className="shrink-0 flex-row items-center gap-2">
          {!creating && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 aria-hidden />
              Delete
            </Button>
          )}
          <SheetClose asChild>
            <Button variant="outline">Cancel</Button>
          </SheetClose>
          {creating ? (
            <Button
              disabled={submitting || title.trim() === "" || projectId === ""}
              onClick={() => void submit()}
            >
              {submitting && <Spinner aria-hidden />}
              {submitting ? "Adding..." : "Add"}
            </Button>
          ) : (
            <Button disabled={submitting || title.trim() === ""} onClick={() => void save()}>
              {submitting && <Spinner aria-hidden />}
              {submitting ? "Saving..." : "Save"}
            </Button>
          )}
        </SheetFooter>
      </SheetContent>
      {!creating && <DeleteTicketDialog ticket={ticket} open={confirmDelete} onOpenChange={setConfirmDelete} />}
      {!creating && (
        <ScreenshotLightbox
          screenshots={ticket.screenshots}
          side={lightboxSide}
          onOpenChange={(next) => {
            if (!next) setLightboxSide(null);
          }}
          onSelect={setLightboxSide}
        />
      )}
    </Sheet>
  );
}
