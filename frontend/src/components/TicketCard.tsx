import {
  Ban,
  Check,
  FolderGit2,
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
 * Click-to-copy for the three identifiers a ticket is handled by. They are values you paste
 * into a terminal, never values you read, so the branch and worktree path collapse to an icon
 * and give the card back a line each.
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
      {copied ? <Check aria-hidden className="size-3 text-emerald-600 dark:text-emerald-400" /> : <Icon aria-hidden className="size-3" />}
      {children}
    </button>
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
          Icon-only: at five columns a card is ~185px, and "Remove worktree" beside Cancel
          overflows it. The label lives in the tooltip and the accessible name instead.
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

export function TicketCard({ ticket }: { ticket: Ticket }) {
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
      {/*
        Identity row: the id stays readable because it is what you scan and search for, while
        the branch and the worktree path — long, and only ever pasted — sit beside it as icons.
      */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CopyButton value={ticket.id} label="Ticket id" icon={Hash}>
            <span className="truncate font-mono text-xs">{ticket.id}</span>
          </CopyButton>
          {ticket.branch && <CopyButton value={ticket.branch} label={`Branch ${ticket.branch}`} icon={GitBranch} />}
          {ticket.worktreePath && (
            <CopyButton value={ticket.worktreePath} label={`Worktree ${ticket.worktreePath}`} icon={FolderGit2} />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {ticket.agentStatus && (
            <Badge variant="secondary" data-status={ticket.agentStatus} className="text-[10px]">
              {AGENT_LABEL[ticket.agentStatus] ?? ticket.agentStatus}
            </Badge>
          )}
          {/*
            No "finished" tick: `finished` is true exactly when the ticket is in review or done,
            so the column already says it. The only run fact a card can carry that its column
            cannot is a run that died.
          */}
          {failed && <Unplug aria-hidden className="size-3.5 text-destructive" />}
          {failed && <span className="sr-only" title="run died" />}
        </div>
      </div>

      <h3 className="mt-2 truncate text-sm leading-snug font-medium" title={ticket.title}>
        {ticket.title}
      </h3>

      {ticket.description && (
        <p className="mt-1 truncate text-xs text-muted-foreground" title={ticket.description}>
          {ticket.description}
        </p>
      )}

      {ticket.prUrl && PrIcon && (
        <p className="mt-2 flex items-center gap-2 text-[11px]">
          <PrIcon aria-hidden className={`size-3.5 ${PR_TONE[ticket.prState!]}`} />
          <a href={ticket.prUrl} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:underline">
            PR #{ticket.prNumber}
          </a>
          {ticket.prAdditions !== null && ticket.prDeletions !== null && (
            <span className="font-mono">
              <span className="text-emerald-600 dark:text-emerald-400">+{ticket.prAdditions}</span>{" "}
              <span className="text-red-600 dark:text-red-400">&minus;{ticket.prDeletions}</span>
            </span>
          )}
        </p>
      )}

      {failed && (
        <p className="mt-2 truncate rounded-md bg-destructive/10 p-2 text-[11px] text-destructive" title="Run died — the pane exited before finishing. The worktree was kept so you can inspect it.">
          Run died — the pane exited before finishing.
        </p>
      )}

      {/* Run actions lead; the two status-independent ones are icons pinned to the right edge. */}
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

      {/* Off unless VITE_DIAGNOSTICS=true; see frontend/.env.example. */}
      {import.meta.env["VITE_DIAGNOSTICS"] === "true" && ticket.diagnostics && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-muted-foreground">diagnostics</summary>
          <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px] text-muted-foreground">
            {Object.entries(ticket.diagnostics).map(([k, v]) => (
              <div key={k} className="contents">
                <dt>{k}</dt>
                <dd className="text-right">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </article>
  );
}
