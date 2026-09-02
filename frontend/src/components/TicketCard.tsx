import { Check, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, Skull, Wrench } from "lucide-react";

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
 * One branch per status and never an `else`. Plan is scoped to `backlog`, Start to `todo`,
 * Cancel to `in_progress`, Accept and Reject to `in_review`, and the server answers 409 from
 * anywhere else — so an `else` would put a button on a card whose status cannot take it. Done
 * is terminal and draws no run action; Edit and Delete are status-independent.
 */
function RunActions({ ticket }: { ticket: Ticket }) {
  if (ticket.status === "backlog") {
    return (
      <Button size="sm" title="Talks the idea through with a planning agent until it is ready to start.">
        Plan
      </Button>
    );
  }
  if (ticket.status === "todo") {
    return <Button size="sm">Start</Button>;
  }
  if (ticket.status === "in_progress") {
    return (
      <>
        <Button size="sm" variant="destructive" title="Discards the attempt: deletes the branch and worktree.">
          Cancel
        </Button>
        {ticket.hasWorktree && (
          <Button size="sm" variant="outline" title="Reclaims disk space. The branch and its commits are kept.">
            Remove worktree
          </Button>
        )}
      </>
    );
  }
  if (ticket.status === "in_review") {
    return (
      <>
        <Button size="sm" title="Pushes the branch, opens a pull request, and retires the agent.">
          Accept
        </Button>
        <Button size="sm" variant="outline" title="Sends feedback back to the agent, which keeps working. Nothing is destroyed.">
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
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">{ticket.id}</span>
        <div className="flex items-center gap-1">
          {ticket.agentStatus && (
            <Badge variant="secondary" data-status={ticket.agentStatus} className="text-[10px]">
              {ticket.agentStatus}
            </Badge>
          )}
          {ticket.finished && <Check aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />}
          {ticket.finished && <span className="sr-only" title="finished" />}
          {failed && <Skull aria-hidden className="size-3.5 text-destructive" />}
          {failed && <span className="sr-only" title="run died" />}
          {ticket.hasWorktree && <Wrench aria-hidden className="size-3.5 text-muted-foreground" />}
          {ticket.hasWorktree && <span className="sr-only" title="worktree exists" />}
        </div>
      </div>

      <h3 className="mt-1.5 text-sm leading-snug font-medium">{ticket.title}</h3>

      {ticket.description && (
        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={ticket.description}>
          {ticket.description}
        </p>
      )}

      {ticket.branch && (
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <GitBranch aria-hidden className="size-3" />
          {ticket.branch}
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
        <p className="mt-2 rounded-md bg-destructive/10 p-2 text-[11px] text-destructive">
          Run died — the pane exited before finishing. The worktree was kept so you can inspect it.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <RunActions ticket={ticket} />
        <Button size="sm" variant="ghost">
          Edit
        </Button>
        <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive">
          Delete
        </Button>
      </div>

      {/* Development-only, per docs/ui-redesign.md. Vite drops the whole block from a build. */}
      {import.meta.env.DEV && ticket.diagnostics && (
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
