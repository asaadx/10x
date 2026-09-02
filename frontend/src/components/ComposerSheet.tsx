import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.tsx";
import type { Project } from "@/types.ts";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  defaultProjectId: string;
};

/**
 * Opened only from the Backlog column, which is the only column a new ticket can enter.
 *
 * `Sheet` is Radix Dialog underneath, so Escape, the backdrop and focus containment are the
 * platform's job rather than hand-written focus code — the same reason the previous
 * implementation used a native `<dialog>`.
 */
export function ComposerSheet({ open, onOpenChange, projects, defaultProjectId }: Props) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);

  // Reopening should be a fresh ticket, not a half-typed one.
  const close = (next: boolean) => {
    if (!next) {
      setTitle("");
      setDescription("");
    }
    onOpenChange(next);
  };

  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>New ticket</SheetTitle>
          <SheetDescription>Describe the work. The agent reads the title and description.</SheetDescription>
        </SheetHeader>

        <div className="grid gap-4 px-4">
          <div className="grid gap-1.5">
            <label htmlFor="c-title" className="text-xs text-muted-foreground">
              Title
            </label>
            <Input id="c-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary" />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="c-desc" className="text-xs text-muted-foreground">
              Description
            </label>
            <textarea
              id="c-desc"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should the agent do?"
              className="min-h-24 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>

          <div className="grid gap-1.5">
            <label htmlFor="c-project" className="text-xs text-muted-foreground">
              Project
            </label>
            <NativeSelect id="c-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <NativeSelectOption key={p.id} value={p.id}>
                  {p.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2">
          <SheetClose asChild>
            <Button variant="outline">Cancel</Button>
          </SheetClose>
          <Button disabled={title.trim() === ""}>Add</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
