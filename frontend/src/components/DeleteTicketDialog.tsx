import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import type { Ticket } from "@/types.ts";

/**
 * One confirmation shared by the card's overflow menu and the sheet, because two copies of the
 * same destructive warning drift.
 *
 * `pending`/`onConfirm` are optional: the card's callsite owns a write and threads both in, so
 * the click starts `deleteTicket` and the dialog stays open — spinner on, both buttons
 * disabled — until it settles. The sheet's callsite passes neither yet, so `AlertDialogAction`
 * falls back to Radix's own default (close on click) exactly as before; wiring that one up
 * would need an `onChanged`-equivalent refresh threaded into `TicketSheet`, which does not
 * exist today and is out of scope here.
 *
 * `AlertDialogAction` renders Radix's `Dialog.Close` underneath, which closes the dialog on
 * click unless the click handler calls `preventDefault()` first — that is what keeps this
 * open through the async call instead of vanishing before the spinner is ever seen.
 */
export function DeleteTicketDialog({
  ticket,
  open,
  onOpenChange,
  pending = false,
  onConfirm,
}: {
  ticket: Ticket;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set while the delete this dialog started is in flight. */
  pending?: boolean;
  /** Runs the delete. Omitted at a callsite that has not wired one in yet. */
  onConfirm?: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {ticket.id}?</AlertDialogTitle>
          <AlertDialogDescription>
            Stops the agent, removes the worktree, and deletes the branch and the transcript. This cannot be
            undone. The server refuses to delete a ticket whose pull request is still open.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={pending}
            onClick={(e) => {
              if (onConfirm === undefined) return;
              e.preventDefault();
              onConfirm();
            }}
          >
            {pending && <Spinner aria-hidden />}
            {pending ? "Deleting..." : "Delete ticket"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
