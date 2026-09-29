import { GitPullRequest, Images, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentStateBadge, PreviewPanel, SessionLink } from "@/components/AgentSession.tsx";
import { DeleteTicketDialog } from "@/components/DeleteTicketDialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { createTicket, moveTicket, updateTicket } from "@/lib/api.ts";
import { previewOffered, runFailed } from "@/lib/board.ts";
import { relativeTime } from "@/lib/list.ts";
import { clearNewTicketDraft, readNewTicketDraft, writeNewTicketDraft } from "@/lib/new-ticket-draft.ts";
import { cn } from "@/lib/utils.ts";
import {
  PLAYBOOKS,
  PRIORITIES,
  type Playbook,
  type Priority,
  type Project,
  type Status,
  type Ticket,
} from "@/types.ts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  defaultProjectId: string;
  /**
   * The ticket being viewed, or null to create a new one. The caller passes the LIVE ticket
   * from each poll, not a snapshot from when the sheet opened, so the agent's state, note and
   * preview update in place. The form fields are seeded once (see the `useState` initializers)
   * and are not overwritten by that.
   */
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
  /** A write that keeps the sheet open (Preview start/stop) landed; re-read the board now. */
  onChanged: () => void;
};

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

// Same boundary as `isPlaybook`, for the other closed vocabulary this sheet writes.
const isPriority = (value: string): value is Priority =>
  PRIORITIES.some((priority) => priority === value);

/**
 * The picker shows stars, not the bare word: position in `PRIORITIES` is the star count, so
 * this is a plain literal map rather than a formula that could drift from either the count or
 * the word. Built once here rather than composed inline in the option's JSX, which would
 * otherwise split "the star glyphs" and "the capitalised word" across two expressions the
 * option had to be trusted to space correctly.
 */
const PRIORITY_LABELS: Record<Priority, string> = {
  low: "\u2605 Low",
  medium: "\u2605\u2605 Medium",
  high: "\u2605\u2605\u2605 High",
};

const SESSION_KIND_LABEL = { plan: "Planning session", impl: "Implementation session" } as const;

/**
 * The agent block at the top of an existing ticket: what the agent last said about itself and
 * the way to talk to it. First in the body because a blocked agent's question is the thing
 * someone opens the sheet to read. Always rendered for an existing ticket, with a disabled
 * Open session, so the sheet keeps one shape whether or not a session was ever started.
 */
function AgentPanel({ ticket, failed }: { ticket: Ticket; failed: boolean }) {
  const blocked = ticket.agentState === "blocked";
  return (
    <section aria-label="Agent" className="grid gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-xs font-medium">
            {ticket.sessionKind === null ? "No session yet" : SESSION_KIND_LABEL[ticket.sessionKind]}
          </span>
          <AgentStateBadge state={ticket.agentState} note={ticket.agentNote} />
          {ticket.agentUpdatedAt !== null && (
            <span
              className="text-[11px] text-muted-foreground"
              title={`Last report ${new Date(ticket.agentUpdatedAt).toLocaleString()}`}
            >
              {relativeTime(ticket.agentUpdatedAt, Date.now())}
            </span>
          )}
        </div>
        <div className="shrink-0">
          <SessionLink ticket={ticket} label="Open session" variant="outline" />
        </div>
      </div>
      {ticket.agentNote !== null && ticket.agentNote !== "" && (
        <div
          className={cn(
            "rounded-md p-2 text-xs whitespace-pre-wrap break-words select-text",
            blocked
              ? "border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
              : "bg-background text-foreground/90",
          )}
        >
          <span className="mb-1 block text-[11px] font-medium text-muted-foreground">
            {blocked ? "The agent is asking \u2014 answer in the session" : "Last note from the agent"}
          </span>
          {ticket.agentNote}
        </div>
      )}
      {failed && (
        <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
          The agent reported that it could not finish. Open the session to see why, then Cancel to try again.
        </p>
      )}
    </section>
  );
}

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
  onChanged,
}: Props) {
  const creating = ticket === null;
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [projectId, setProjectId] = useState(ticket?.projectId ?? defaultProjectId);
  // Playbook decides which agent profile a spawn uses. It is editable at any point, unlike
  // Project, because it is a choice rather than something derived — and changing it after a run
  // has started cannot affect the agent already running, only the next dispatch. `POST /tickets` only takes `{projectId, title,
  // description}`, so a non-default choice made here reaches the server as a follow-up PATCH
  // `submit()` sends after the create succeeds.
  // Every ticket has one: the column is NOT NULL, and its default is the first entry of
  // `PLAYBOOKS`, which is also what the picker shows first — so seeding a create with it
  // matches what the API would store anyway, without naming a playbook value here.
  const [playbook, setPlaybook] = useState<Playbook>(ticket?.playbook ?? PLAYBOOKS[0]);
  // Priority is editable at any point too, the same as Playbook, and it is never settable in
  // the `POST /tickets` body itself: the column's `'low'` default covers a bare create, and a
  // non-default choice reaches the server the same way Playbook's does, via `submit()`'s
  // follow-up PATCH. Seeded from `PRIORITIES[0]` ("low") for the same reason Playbook seeds
  // from its own first entry — it is what the API would store anyway.
  const [priority, setPriority] = useState<Priority>(ticket?.priority ?? PRIORITIES[0]);
  // Task Breakdown and Acceptance Criteria are the plan a Plan agent produces, and they do come
  // off the wire — the planning agent PATCHes them onto the ticket, and both non-empty is the
  // readiness signal the card's To Do button reads. Editing them here writes back too: `save()`
  // PATCHes an existing ticket, and `submit()` follows a create with the same PATCH when either
  // checklist has real rows.
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
  // True whenever this create-mode session was seeded from a stored draft, so the "Restored
  // unsaved draft" note can stay up for as long as this open/close session lasts (`App.tsx`
  // keys the composer "new" for every creation attempt, so a Cancel- or Escape-driven close
  // does not remount it) — set for real by the seeding effect below, on every open, not just
  // the first.
  const [restoredDraft, setRestoredDraft] = useState(false);
  // Refs, not state: neither is meant to trigger a render, and a scheduled re-render landing a
  // new value in either is exactly the bug they exist to prevent (see the two effects below).
  const wasOpenRef = useRef(false);
  const skipNextDraftSyncRef = useRef(false);

  // Re-seeds the composer from this scope's stored draft on every open — including a reopen
  // with no remount, since the composer's `key` is the constant "new" (see the comment on
  // `close` below), so Escape/backdrop-dismiss-then-reopen is the SAME instance, not a fresh
  // mount. Gated on the open:false -> true edge via `wasOpenRef` rather than firing whenever
  // `defaultProjectId`/`projects` merely change while already open — the board polls every
  // second, and re-seeding mid-type would fight typing.
  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!creating || !justOpened) return;
    // The sync effect below must not immediately persist this seeded (or, with no stored
    // draft, still-default) snapshot back — that write belongs to a real subsequent change.
    skipNextDraftSyncRef.current = true;
    const stored = readNewTicketDraft(defaultProjectId);
    setRestoredDraft(stored !== null);
    if (stored === null) return;
    // A draft's project can have been deleted since it was written; fall back to today's
    // default rather than seeding the `<select>` with a value that names no option.
    setProjectId(projects.some((p) => p.id === stored.projectId) ? stored.projectId : defaultProjectId);
    setPlaybook(stored.playbook);
    setPriority(stored.priority);
    setTitle(stored.title);
    setDescription(stored.description);
    setTaskBreakdown(normalizeChecklistRows(stored.taskBreakdown));
    setAcceptanceCriteria(normalizeChecklistRows(stored.acceptanceCriteria));
  }, [open, creating, defaultProjectId, projects]);

  // Mirrors every create-mode field into this scope's draft as it changes, so an Escape or
  // backdrop click — which close the sheet without clearing anything; see `cancel` below for
  // the path that does clear — has already saved whatever was typed. Skips the write that
  // immediately follows the seeding effect above: that snapshot is either a fresh default or
  // the very value just read back out of storage, and persisting it again would turn "no draft
  // yet" into a stray draft containing nothing but defaults.
  useEffect(() => {
    if (!creating || !open) return;
    if (skipNextDraftSyncRef.current) {
      skipNextDraftSyncRef.current = false;
      return;
    }
    writeNewTicketDraft(defaultProjectId, {
      projectId,
      playbook,
      priority,
      title,
      description,
      taskBreakdown,
      acceptanceCriteria,
    });
  }, [
    creating,
    open,
    defaultProjectId,
    projectId,
    playbook,
    priority,
    title,
    description,
    taskBreakdown,
    acceptanceCriteria,
  ]);

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
      setPriority(ticket?.priority ?? PRIORITIES[0]);
      setTaskBreakdown(normalizeChecklistRows(ticket?.taskBreakdown ?? []));
      setAcceptanceCriteria(normalizeChecklistRows(ticket?.acceptanceCriteria ?? []));
      setSubmitError(null);
    }
    onOpenChange(next);
  };

  /**
   * Create, then a follow-up PATCH for whatever the create body can't carry, then move only if
   * the click came from the To Do column's footer.
   *
   * `POST /tickets` narrows its body to `{projectId, title, description}`, so Playbook,
   * Priority, Task Breakdown and Acceptance Criteria typed into this same sheet need a second
   * call — the same `updateTicket` shape `save()` already sends for an existing ticket. Skipped
   * when every one of those still matches what a bare create already stores (`PLAYBOOKS[0]`,
   * `PRIORITIES[0]`, both checklists empty), so a bare ticket costs one request, not two. This
   * follow-up is NOT atomic with the create, same trade as the todo-column move below: a
   * failure leaves the ticket sitting in Backlog with that field unset, surfaced through
   * `submitError` the same way a failed move already is.
   */
  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const created = await createTicket({ projectId, title: title.trim(), description });
      const normalizedTaskBreakdown = normalizeChecklistRows(taskBreakdown).filter(
        (row) => row.text.trim() !== "",
      );
      const normalizedAcceptanceCriteria = normalizeChecklistRows(acceptanceCriteria).filter(
        (row) => row.text.trim() !== "",
      );
      const hasNonDefaultFields =
        playbook !== PLAYBOOKS[0] ||
        priority !== PRIORITIES[0] ||
        normalizedTaskBreakdown.length > 0 ||
        normalizedAcceptanceCriteria.length > 0;
      if (hasNonDefaultFields) {
        await updateTicket(created.id, {
          playbook,
          priority,
          taskBreakdown: normalizedTaskBreakdown,
          acceptanceCriteria: normalizedAcceptanceCriteria,
        });
      }
      if (createInto === "todo") await moveTicket(created.id, "todo");
      clearNewTicketDraft(defaultProjectId);
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
        priority,
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
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader className="shrink-0">
          <SheetTitle>{creating ? "New ticket" : ticket.id}</SheetTitle>
          {creating && (
            <SheetDescription>Describe the work. The agent reads the title and description.</SheetDescription>
          )}
          {creating && restoredDraft && (
            <p role="status" className="text-xs text-muted-foreground">
              Restored unsaved draft.
            </p>
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
          {!creating && <AgentPanel ticket={ticket} failed={failed} />}

          <div className="grid gap-1.5">
            <label htmlFor="c-project" className="text-xs text-muted-foreground">
              Project <span className="text-destructive">*</span>
            </label>
            {/* A ticket cannot change project once created: its id and branch are already
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
            <label htmlFor="c-priority" className="text-xs text-muted-foreground">
              Priority
            </label>
            <NativeSelect
              id="c-priority"
              aria-label="Priority"
              value={priority}
              onChange={(e) => {
                const next = e.target.value;
                // Every option below is a `PRIORITIES` member, so the guard never rejects a
                // real change; it is what keeps an unvalidated string out of typed state.
                if (isPriority(next)) setPriority(next);
              }}
              className="w-full"
            >
              {PRIORITIES.map((name) => (
                <NativeSelectOption key={name} value={name}>
                  {PRIORITY_LABELS[name]}
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

          <Checklist label="Task Breakdown" rows={taskBreakdown} onRowsChange={setTaskBreakdown} />

          <Checklist label="Acceptance Criteria" rows={acceptanceCriteria} onRowsChange={setAcceptanceCriteria} />

          <AttachmentDropZone />

          {!creating && (
            <>
              <Separator />

              <div className="grid gap-4">
                {/* Written by the agent once it has pushed; nothing is created locally. */}
                <div className="grid gap-1.5">
                  <label htmlFor="c-branch" className="text-xs text-muted-foreground">
                    Branch
                  </label>
                  <Input
                    id="c-branch"
                    readOnly
                    disabled
                    value={ticket.branch ?? ""}
                    placeholder="Reported by the agent once it pushes"
                  />
                </div>

                {ticket.prUrl && (
                  <div className="grid gap-1.5">
                    <span className="text-xs text-muted-foreground">Pull request</span>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <a
                        href={ticket.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm underline-offset-2 hover:underline"
                      >
                        <GitPullRequest aria-hidden className="size-3.5" />
                        <span className="font-mono">{ticket.prNumber === null ? "PR" : `PR #${ticket.prNumber}`}</span>
                        {ticket.prAdditions !== null && ticket.prDeletions !== null && (
                          <span className="font-mono text-xs">
                            <span className="text-emerald-600 dark:text-emerald-400">+{ticket.prAdditions}</span>{" "}
                            <span className="text-red-600 dark:text-red-400">&minus;{ticket.prDeletions}</span>
                          </span>
                        )}
                      </a>
                      {/* The agent posts before/after shots as a comment on its own PR
                          (`gh pr comment --attach`); nothing is uploaded to the board, so the
                          PR's conversation is where they are. */}
                      <a
                        href={ticket.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      >
                        <Images aria-hidden className="size-3.5" />
                        Screenshots on PR
                      </a>
                    </div>
                  </div>
                )}

                {previewOffered(ticket) || ticket.preview !== null ? (
                  <PreviewPanel ticket={ticket} onChanged={onChanged} />
                ) : null}
              </div>
            </>
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
          <Button
            variant="outline"
            onClick={() => {
              // Decoupled from the Sheet's own `onOpenChange={close}` on purpose: Escape and a
              // backdrop click go through that path untouched and must never clear a draft,
              // only Cancel does.
              if (creating) clearNewTicketDraft(defaultProjectId);
              close(false);
            }}
          >
            Cancel
          </Button>
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
    </Sheet>
  );
}
