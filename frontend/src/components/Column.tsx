import { Plus } from "lucide-react";

import { TicketCard } from "@/components/TicketCard.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { columnIsWorking } from "@/lib/board.ts";
import type { Status, Ticket } from "@/types.ts";

/**
 * One per column, in state-machine order. Colour starts where work does: the two pre-start
 * columns are neutral and violet, and blue/amber/green then track a live agent.
 */
const DOT: Record<Status, string> = {
  backlog: "bg-neutral-400",
  todo: "bg-violet-500",
  in_progress: "bg-blue-500",
  in_review: "bg-amber-500",
  done: "bg-emerald-500",
};

type Props = {
  status: Status;
  label: string;
  tickets: Ticket[];
  onNewTicket?: () => void;
};

export function Column({ status, label, tickets, onNewTicket }: Props) {
  const headingId = `${status}-heading`;
  const working = status === "in_progress" && columnIsWorking(tickets);

  return (
    // A `region` labelled by its own heading, so the accessible name carries the live count
    // ("Backlog 2") with no duplicated string to drift. The e2e suite locates columns this way.
    <section
      aria-labelledby={headingId}
      data-status={status}
      className="flex min-w-0 flex-col rounded-md border bg-muted/40"
    >
      {/*
        The New ticket button is a SIBLING of the heading, never inside it: `aria-labelledby`
        points at the h2, so a button nested in it would append its label to the region's
        accessible name ("Backlog 2 New ticket").
      */}
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b px-3">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[status]}`} />
        {/*
          The count stays INSIDE the h2: `aria-labelledby` points here, so the region's
          accessible name is "Backlog 2" and the e2e suite locates columns by it. Styling the
          count as a pill is safe; moving it out of the heading is not.

          The `{" "}` is load-bearing for the same reason. Flex `gap` is drawn, not text, so
          without a real whitespace node the accessible name computes as "Backlog2" and every
          column locator in the suite misses.
        */}
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-sm font-medium tracking-tight">
          <span className="truncate">{label}</span>{" "}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-[11px] font-normal text-muted-foreground tabular-nums">
            {tickets.length}
          </span>
        </h2>

        <div className="ml-auto flex items-center gap-1">
          {working && <Spinner aria-label="agent working" className="size-3.5 text-blue-500" />}
          {onNewTicket && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={onNewTicket}>
              <Plus aria-hidden className="size-3.5" />
              New ticket
            </Button>
          )}
        </div>
      </div>

      {/* Scrolls inside a fixed-height column, so the board never grows past the viewport. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {tickets.length === 0 ? (
          <p data-empty className="px-1 py-6 text-center text-xs text-muted-foreground">
            nothing here
          </p>
        ) : (
          tickets.map((t) => <TicketCard key={t.id} ticket={t} />)
        )}
      </div>
    </section>
  );
}
