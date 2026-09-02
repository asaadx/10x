import {
  Ban,
  Check,
  ChevronDown,
  FolderX,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Hash,
  NotebookPen,
  Pencil,
  Play,
  Trash2,
  TreeDeciduous,
  Undo2,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { runFailed } from "@/lib/board.ts";
import type { Ticket } from "@/types.ts";

const PR_ICON = {
  merged: GitMerge,
  closed: GitPullRequestClosed,
  open: GitPullRequest,
} as const;

const PR_TONE = {
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-red-600 dark:text-red-400",
  open: "text-emerald-600 dark:text-emerald-400",
} as const;

/**
 * Herdr's `idle` and `done` are the same state — the agent is alive and not generating
 * (memory/agent-status.md) — and "idle" reads as "wasting time" rather than "waiting for you".
 * Anything unrecognised is shown verbatim rather than swallowed.
 */
const AGENT_LABEL: Record<string, string> = {
  idle: "waiting",
  done: "waiting",
};

/**
 * Click-to-copy for the identifiers a ticket is handled by.
 *
 * The branch and the worktree path are pure functions of the ticket id — Herdr derives the
 * directory from the branch and the branch is `ticket/<project>/<number>` (memory/naming.md) —
 * so rendering either as text would be the id again in a longer font. They are values you paste
 * into a terminal, never values you read, which is exactly what a copy affordance is for. Both
 * are still spelled out in full when the card is expanded.
 */
function CopyButton({
  value,
  label,
  icon: Icon,
  children,
}: {
  value: string;
  label: string;
  icon: LucideIcon;
  children?: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // A card unmounts on every poll that changes it, and a pending timer would then set state on
  // a dead component.
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      title={`${label} — click to copy`}
      aria-label={`Copy ${label.toLowerCase()}`}
      className="inline-flex min-w-0 shrink items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? (
        <Check aria-hidden className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Icon aria-hidden className="size-3 shrink-0" />
      )}
      {children}
    </button>
  );
}

/** A labelled line in the expanded region: name on the left, value monospaced and wrapping. */
function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="break-all font-mono">{children}</dd>
    </>
  );
}

/**
 * One branch per status and never an `else`. Plan is scoped to `backlog`, Start to `todo`,
 * Cancel to `in_progress`, Accept and Reject to `in_review`, and the server answers 409 from
 * anywhere else — so an `else` would put a button on a card whose status cannot take it. Done
 * is terminal and draws no run action; Edit and Delete are status-independent.
 *
 * Variants carry the consequence: the forward move is primary, a reversible move is outline,
 * and only the two that destroy something are destructive.
 */
function RunActions({ ticket }: { ticket: Ticket }) {
  if (ticket.status === "backlog") {
    return (
      <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Talks the idea through with a planning agent until it is ready to start.">
        <NotebookPen aria-hidden className="size-3.5" />
        Plan
      </Button>
    );
  }
  if (ticket.status === "todo") {
    return (
      <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Spawns the agent in its own worktree, branch and port block.">
        <Play aria-hidden className="size-3.5" />
        Start
      </Button>
    );
  }
  if (ticket.status === "in_progress") {
    return (
      <>
        <Button size="sm" variant="destructive" className="h-7 gap-1.5 px-2.5 text-xs" title="Discards the attempt: deletes the branch and worktree.">
          <Ban aria-hidden className="size-3.5" />
          Cancel
        </Button>
        {/*
          Icon-only: at five columns a card is too narrow for "Remove worktree" beside Cancel.
          The label lives in the tooltip and the accessible name instead.
        */}
        {ticket.hasWorktree && (
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Remove worktree"
            title="Remove worktree — reclaims disk space. The branch and its commits are kept."
          >
            <FolderX aria-hidden className="size-3.5" />
          </Button>
        )}
      </>
    );
  }
  if (ticket.status === "in_review") {
    return (
      <>
        <Button size="sm" className="h-7 gap-1.5 px-2.5 text-xs" title="Pushes the branch, opens a pull request, and retires the agent.">
          <Check aria-hidden className="size-3.5" />
          Accept
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" title="Sends feedback back to the agent, which keeps working. Nothing is destroyed.">
          <Undo2 aria-hidden className="size-3.5" />
          Reject
        </Button>
      </>
    );
  }
  return null;
}

/**
 * Every card is the same height collapsed, whatever state its ticket is in: an identity row, a
 * one-line title, a one-line description slot that is reserved even when empty, and one row of
 * actions. Anything a ticket may or may not have — the branch, the worktree, a pull request, a
 * dead run, diagnostics — lives below the fold, so a column of cards scans as a list rather
 * than as a ragged stack.
 */
export function TicketCard({ ticket }: { ticket: Ticket }) {
  const [open, setOpen] = useState(false);
  const failed = runFailed(ticket);
  const PrIcon = ticket.prState ? PR_ICON[ticket.prState] : null;

  return (
    // `article` named by its ticket id is the card's only accessible handle, and the e2e suite
    // locates every card this way. A redesign may move or restyle anything inside; this must not
    // move with it.
    <article
      aria-label={ticket.id}
      data-died={failed || undefined}
      className="group rounded-md border bg-card p-3 text-card-foreground shadow-xs transition-colors data-[died]:border-destructive/60"
    >
      {/* `h-5` is what makes every card identical: the status badge is taller than the copy
          buttons, so without it a card with a live agent stands 4px above one without. */}
      <div className="flex h-5 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CopyButton value={ticket.id} label="Ticket id" icon={Hash}>
            <span className="truncate font-mono text-xs">{ticket.id}</span>
          </CopyButton>
          {ticket.branch && <CopyButton value={ticket.branch} label={`Branch ${ticket.branch}`} icon={GitBranch} />}
          {ticket.worktreePath && (
            <CopyButton value={ticket.worktreePath} label={`Worktree ${ticket.worktreePath}`} icon={TreeDeciduous} />
          )}
        </div>

        {/*
          One slot, two occupants that never coexist: a ticket has a live agent (In Progress, In
          Review) or a pull request (Done, whose agent is retired), never both. A dead run is the
          red border, not a third chip.
        */}
        <div className="flex shrink-0 items-center gap-1">
          {ticket.agentStatus ? (
            <Badge
              variant="secondary"
              data-status={ticket.agentStatus}
              className="h-4 px-1.5 text-[10px] leading-none"
            >
              {AGENT_LABEL[ticket.agentStatus] ?? ticket.agentStatus}
            </Badge>
          ) : (
            ticket.prUrl &&
            PrIcon && (
              <a
                href={ticket.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] underline-offset-2 hover:underline"
              >
                <PrIcon aria-hidden className={`size-3.5 ${PR_TONE[ticket.prState!]}`} />
                <span className="font-mono">#{ticket.prNumber}</span>
                {ticket.prAdditions !== null && ticket.prDeletions !== null && (
                  <span className="font-mono">
                    <span className="text-emerald-600 dark:text-emerald-400">+{ticket.prAdditions}</span>{" "}
                    <span className="text-red-600 dark:text-red-400">&minus;{ticket.prDeletions}</span>
                  </span>
                )}
              </a>
            )
          )}
          {failed && <Unplug aria-hidden className="size-3.5 text-destructive" />}
          {failed && <span className="sr-only" title="run died" />}
          {/*
            The disclosure sits with the metadata it reveals, not with the run actions: the
            action row is already at its width budget on an In Review card.
          */}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            title={open ? "Hide details" : "Show details"}
            className="ml-0.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronDown aria-hidden className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      <h3
        className={`mt-2 text-sm leading-snug font-medium ${open ? "" : "truncate"}`}
        title={open ? undefined : ticket.title}
      >
        {ticket.title}
      </h3>

      {/*
        One description, two shapes. Closed it is a reserved single line — rendered even when
        empty, which is what keeps every collapsed card the same height. Open it wraps in place,
        so the full text appears where the reader is already looking instead of being repeated
        further down.
      */}
      <p
        className={`mt-1 text-xs leading-4 text-muted-foreground ${open ? "" : "h-4 truncate"}`}
        title={open ? undefined : ticket.description}
      >
        {ticket.description}
      </p>

      <div className="mt-3 flex items-center gap-1.5">
        <RunActions ticket={ticket} />
        <div className="ml-auto flex shrink-0 items-center">
          <Button size="icon" variant="ghost" className="size-7" aria-label="Edit ticket" title="Edit">
            <Pencil aria-hidden className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-destructive"
            aria-label="Delete ticket"
            title="Delete"
          >
            <Trash2 aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-2 border-t pt-3 text-[11px]">
          {failed && (
            <p className="rounded-md bg-destructive/10 p-2 text-destructive">
              Run died — the pane exited before finishing. The worktree was kept so you can inspect it.
            </p>
          )}

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {ticket.branch && <Detail term="Branch">{ticket.branch}</Detail>}
            {ticket.worktreePath && <Detail term="Worktree">{ticket.worktreePath}</Detail>}
            {ticket.agentName && <Detail term="Agent">{ticket.agentName}</Detail>}
          </dl>

          {/* Off unless VITE_DIAGNOSTICS=true; see frontend/.env.example. */}
          {import.meta.env["VITE_DIAGNOSTICS"] === "true" && ticket.diagnostics && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t pt-2 font-mono text-muted-foreground">
              {Object.entries(ticket.diagnostics).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>{k}</dt>
                  <dd className="text-right">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </article>
  );
}
