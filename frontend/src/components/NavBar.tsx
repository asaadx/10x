import { IconMoonFilled, IconSunFilled } from "@tabler/icons-react";
import { BookOpen, Columns3, LayoutDashboard, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { DeleteProjectDialog, ProjectDialog } from "@/components/ProjectDialog.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ALL_PROJECTS } from "@/lib/board.ts";
import type { SteerMode } from "@/lib/steer-mode.ts";
import type { Theme } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";
import type { Project } from "@/types.ts";

type Props = {
  projects: Project[];
  projectId: string;
  onProjectChange: (id: string) => void;
  steerMode: SteerMode;
  onSteerModeChange: (mode: SteerMode) => void;
  theme: Theme;
  onThemeToggle: () => void;
};

// The app's destinations, so they live in the nav bar. Board is the only view that exists
// yet, so the other two are inert and only Board carries aria-current.
const DESTINATIONS = [
  { label: "Dashboard", icon: LayoutDashboard, active: false },
  { label: "Board", icon: Columns3, active: true },
  { label: "Playbooks", icon: BookOpen, active: false },
];

/**
 * A project is usable at `ready` and only there, so the picker says where the others are: an
 * option's label is the one place a project is named while it is still downloading. Text only —
 * the picker is a native `<select>` and its options cannot hold markup.
 */
const STATE_SUFFIX: Record<Project["provisionState"], string> = {
  pending: " (queued)",
  cloning: " (downloading…)",
  ready: "",
  failed: " (needs attention)",
};

/**
 * Shared by the picker's three neighbours and the theme toggle: a fixed size-9 square, not
 * padding around an icon, so the icon has a box to centre in and the row matches the h-9 select.
 * `disabled:` deliberately does not include `pointer-events-none` — a disabled control still has
 * to be hoverable for its title to explain *why* it is disabled.
 */
const ICON_BUTTON =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-input bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50";

export function NavBar({
  projects,
  projectId,
  onProjectChange,
  steerMode,
  onSteerModeChange,
  theme,
  onThemeToggle,
}: Props) {
  // steerMode is the persisted lowercase SteerMode union member; capitalizing it for
  // display/aria text is purely presentational, so both derive from this one lowercase
  // value instead of a second hardcoded capitalized literal that can drift out of sync.
  const otherSteerMode: SteerMode = steerMode === "local" ? "remote" : "local";

  // All of it stays here: the dialogs belong to the controls that open them, so adding a
  // project needs nothing threaded down from `App.tsx`.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // `ALL_PROJECTS` is the picker's sentinel and never a project id, so "no selection" and
  // "every project" are the same state here — which is exactly when editing and deleting have
  // no subject.
  const selected = projects.find((project) => project.id === projectId) ?? null;

  return (
    <header className="shrink-0 border-b">
      <div className="mx-auto grid h-14 w-full max-w-[1600px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-4">
        <div />

        <nav aria-label="Primary" className="inline-flex items-center gap-1.5 justify-self-center rounded-full border bg-muted/50 p-1.5">
          {DESTINATIONS.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              disabled={!active}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon aria-hidden className="size-4" />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3 justify-self-end">
          {/*
            One button, not a segmented pair: the control only ever shows the mode that's
            active, so there is nothing for a second segment to add — the label already names
            the alternative it will switch to. Amber marks remote because amber already means
            "a human has to go do something in Herdr" on the card's `blocked` chip, and remote
            steering is exactly that meaning again, not a new colour code; local is the direct,
            nothing-else-needed state, so it gets emerald like a `done` column dot.
          */}
          <button
            type="button"
            onClick={() => onSteerModeChange(otherSteerMode)}
            aria-label={`Steer mode: ${steerMode.charAt(0).toUpperCase() + steerMode.slice(1)}. Switch to ${
              otherSteerMode.charAt(0).toUpperCase() + otherSteerMode.slice(1)
            }.`}
            title={
              steerMode === "local"
                ? "Local steering focuses the agent's pane on this machine."
                : "Remote steering also copies the herdr --remote attach command."
            }
            className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
              steerMode === "local"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            <span
              aria-hidden
              className={`size-2 rounded-full ${steerMode === "local" ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            <span className="capitalize">{steerMode}</span>
          </button>

          {/*
            A real <select>, not the Radix listbox: the e2e suite asserts
            getByRole("option", { name }) without opening anything, and Radix only renders its
            options into a portal while open. `aria-label="Project"` is the only thing naming this
            control now that the "Project" text beside it is gone — the e2e suite locates it that way.
          */}
          <NativeSelect
            aria-label="Project"
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
            className="h-9 w-44"
          >
            <NativeSelectOption value={ALL_PROJECTS}>All projects</NativeSelectOption>
            {projects.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.name}
                {STATE_SUFFIX[p.provisionState]}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          <button
            type="button"
            aria-label="Add project"
            title="Add a project from a GitHub link"
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
            className={ICON_BUTTON}
          >
            <Plus aria-hidden className="size-5" />
          </button>

          {/*
            Both always rendered, disabled while the picker is on "All projects". Hiding them
            behind a selection is what review rejected: a first-time user sees only `+`, never
            learns the controls exist, and concludes a project cannot be edited at all.
          */}
          <button
            type="button"
            disabled={selected === null}
            aria-label={selected === null ? "Edit project" : `Edit ${selected.name}`}
            title={selected === null ? "Pick a project in the picker to edit it" : `Edit ${selected.name}`}
            onClick={() => {
              setEditing(selected);
              setEditorOpen(true);
            }}
            className={ICON_BUTTON}
          >
            <Pencil aria-hidden className="size-4" />
          </button>

          <button
            type="button"
            disabled={selected === null}
            aria-label={selected === null ? "Delete project" : `Delete ${selected.name}`}
            title={selected === null ? "Pick a project in the picker to delete it" : `Delete ${selected.name}`}
            onClick={() => setDeleting(selected)}
            className={cn(ICON_BUTTON, "hover:bg-destructive/10 hover:text-destructive")}
          >
            <Trash2 aria-hidden className="size-4" />
          </button>

          <button
            type="button"
            className={ICON_BUTTON}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={onThemeToggle}
          >
            {theme === "dark" ? (
              <IconSunFilled aria-hidden className="size-5" />
            ) : (
              <IconMoonFilled aria-hidden className="size-5" />
            )}
          </button>
        </div>
      </div>

      <ProjectDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        projects={projects}
        editing={editing}
        // A new project is selected the moment it exists, because its whole point is that you
        // can start filling its backlog while the clone is still running.
        onSaved={(project) => onProjectChange(project.id)}
      />

      {deleting !== null && (
        <DeleteProjectDialog
          project={deleting}
          open
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onDeleted={() => {
            onProjectChange(ALL_PROJECTS);
            setDeleting(null);
          }}
        />
      )}
    </header>
  );
}
