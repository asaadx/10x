import { ImageIcon, Trash2, Upload } from "lucide-react";
import { useState } from "react";

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
import { runFailed } from "@/lib/board.ts";
import { cn } from "@/lib/utils.ts";
import { PLAYBOOKS, type Playbook, type Project, type Ticket } from "@/types.ts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  defaultProjectId: string;
  /** The ticket being viewed, or null to create a new one. */
  ticket: Ticket | null;
};

/**
 * One labelled Before/After pane: the image when its url is captured, or a placeholder when it
 * isn't. Extracted so the two panes below share this markup instead of duplicating it.
 */
function ScreenshotPane({ label, url }: { label: string; url: string | null }) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs text-muted-foreground">{label}</label>
      {url ? (
        <img src={url} alt={label} className="aspect-video w-full rounded-md border object-cover" />
      ) : (
        <div className="flex aspect-video w-full flex-col items-center justify-center gap-1.5 rounded-md border bg-muted text-xs text-muted-foreground">
          <ImageIcon aria-hidden className="size-5" />
          No screenshot
        </div>
      )}
    </div>
  );
}

type ChecklistRow = { text: string; done: boolean };

// Blank rows are dropped except the trailing one, so the list never accumulates gaps, and a
// fresh empty row is appended so the list always ends on the row that is still an input.
function normalizeChecklistRows(rows: ChecklistRow[]): ChecklistRow[] {
  return [...rows.filter((row) => row.text.trim() !== ""), { text: "", done: false }];
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
            <div key={index} className="flex items-center gap-2">
              <Checkbox
                checked={row.done}
                disabled={trailing}
                onCheckedChange={(checked) =>
                  onRowsChange(rows.map((r, i) => (i === index ? { ...r, done: checked === true } : r)))
                }
              />
              <input
                value={row.text}
                onChange={(e) => {
                  const next = rows.map((r, i) => (i === index ? { ...r, text: e.target.value } : r));
                  onRowsChange(normalizeChecklistRows(next));
                }}
                placeholder={trailing ? "Add an item…" : undefined}
                className={cn(
                  "h-6 w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground",
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

// Display names for each playbook live here once, so the picker below labels its options from
// this map instead of repeating a name per profile. Named `PLAYBOOK_LABELS`, not `PLAYBOOKS`:
// that name belongs to the shared slug array this file imports, and labels are presentation,
// which is why the map lives here and the vocabulary does not. `Record<Playbook, string>`
// makes a missing label a compile error the moment the shared array grows a slug.
const PLAYBOOK_LABELS: Record<Playbook, string> = {
  fullstack: "Full-stack",
  frontend: "Frontend",
  backend: "Backend",
  database: "Database",
  devops: "DevOps",
  docs: "Docs",
  research: "Research",
};

// A `<select>` hands back a bare string, so this is the boundary where that string becomes a
// `Playbook`. A membership test against the shared array rather than a cast: the state is
// typed against exactly the list the API validates against, so nothing but a real playbook
// can reach it, and an option that ever drifted out of `PLAYBOOKS` would be ignored here
// instead of being sent as a write the backend then rejects.
const isPlaybook = (value: string): value is Playbook =>
  PLAYBOOKS.some((slug) => slug === value);

/**
 * Opened either from the Backlog column's New ticket button, with `ticket` null, or from a
 * card's title/overflow menu, with `ticket` set — the one detail surface for both creating and
 * viewing/editing. `Sheet` is Radix Dialog underneath, so Escape, the backdrop and focus
 * containment are the platform's job rather than hand-written focus code — the same reason the
 * previous implementation used a native `<dialog>`.
 */
export function TicketSheet({ open, onOpenChange, projects, defaultProjectId, ticket }: Props) {
  const creating = ticket === null;
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [description, setDescription] = useState(ticket?.description ?? "");
  const [projectId, setProjectId] = useState(ticket?.projectId ?? defaultProjectId);
  // Playbook decides which agent profile a spawn uses. It is editable at any point, unlike
  // Project, because it is a choice rather than something derived — and changing it after a run
  // has started cannot affect the agent already running, only the next dispatch. The sheet
  // already has a row called Agent for the running Herdr agent's name, so this control is named
  // Playbook rather than colliding with it. It is local state only — nothing persists this yet,
  // same as the rest of the composer's fields before Add is wired up.
  // Every ticket has one: the column is NOT NULL, defaulting to 'fullstack', which is also
  // what the picker shows first — so seeding a create with it matches what the API would
  // store anyway.
  const [playbook, setPlaybook] = useState<Playbook>(ticket?.playbook ?? "fullstack");
  // Task Breakdown and Acceptance Criteria are the plan a Plan agent is meant to produce; there
  // is no wire field for either yet, so both live only as local state, same as Playbook above.
  // Seeded from `ticket` via a `useState` initializer rather than an effect: `App.tsx` keys this
  // component by ticket id, so React remounts (and re-runs this initializer) whenever a
  // different ticket opens — no sync needed. The `.length` check (not `??`) matters too: a
  // persisted-but-empty array must still become one blank row, or the checklist has no input
  // and can never be started.
  const [taskBreakdown, setTaskBreakdown] = useState<ChecklistRow[]>(
    ticket?.taskBreakdown.length ? ticket.taskBreakdown : [{ text: "", done: false }],
  );
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<ChecklistRow[]>(
    ticket?.acceptanceCriteria.length ? ticket.acceptanceCriteria : [{ text: "", done: false }],
  );

  // The callsite's `key` re-seeds this component when a *different* ticket is opened, but the
  // create key is the constant "new", so the composer never remounts between one creation
  // attempt and the next. This reset is what stops a half-typed new ticket from surviving
  // Cancel, and what discards unsaved edits when backing out of viewing an existing one.
  const close = (next: boolean) => {
    if (!next) {
      setTitle(ticket?.title ?? "");
      setDescription(ticket?.description ?? "");
      setProjectId(ticket?.projectId ?? defaultProjectId);
      setPlaybook(ticket?.playbook ?? "fullstack");
      setTaskBreakdown([{ text: "", done: false }]);
      setAcceptanceCriteria([{ text: "", done: false }]);
    }
    onOpenChange(next);
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
              {PLAYBOOKS.map((slug) => (
                <NativeSelectOption key={slug} value={slug}>
                  {PLAYBOOK_LABELS[slug]}
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
              <ScreenshotPane label="Before" url={ticket.screenshots.before} />
              <ScreenshotPane label="After" url={ticket.screenshots.after} />
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

          {/* Off unless VITE_DIAGNOSTICS=true; see frontend/.env.example. */}
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
            <Button disabled={title.trim() === "" || projectId === ""}>Add</Button>
          ) : (
            <Button disabled={title.trim() === ""}>Save</Button>
          )}
        </SheetFooter>
      </SheetContent>
      {!creating && <DeleteTicketDialog ticket={ticket} open={confirmDelete} onOpenChange={setConfirmDelete} />}
    </Sheet>
  );
}
