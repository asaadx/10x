import { IconMoonFilled, IconSunFilled } from "@tabler/icons-react";
import { BookOpen, Columns3, LayoutDashboard, List, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { DeleteProjectDialog, ProjectDialog } from "@/components/ProjectDialog.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ALL_PROJECTS } from "@/lib/board.ts";
import type { Theme } from "@/lib/theme.ts";
import type { Project } from "@/types.ts";

type Props = {
  projects: Project[];
  projectId: string;
  onProjectChange: (id: string) => void;
  theme: Theme;
  onThemeToggle: () => void;
};

// The app's destinations, so they live in the nav bar. `to` is matched against the current
// route by `useLocation` below to drive `aria-current`, rather than each destination carrying
// its own "am I active" flag — that flag would need updating by hand every time a route
// changes, and the two would eventually drift.
const DESTINATIONS = [
  { label: "Dashboard", icon: LayoutDashboard, to: "/dashboard" },
  { label: "Board", icon: Columns3, to: "/board" },
  { label: "Playbooks", icon: BookOpen, to: "/playbooks" },
  { label: "List", icon: List, to: "/list" },
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
  theme,
  onThemeToggle,
}: Props) {
  // All of it stays here: the dialogs belong to the controls that open them, so adding a
  // project needs nothing threaded down from `App.tsx`.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState<Project | null>(null);

  // `ALL_PROJECTS` is the picker's sentinel and never a project id, so "no selection" and
  // "every project" are the same state here — which is exactly when editing and deleting have
  // no subject.
  const selected = projects.find((project) => project.id === projectId) ?? null;
  const { pathname } = useLocation();

  return (
    <header className="shrink-0 border-b">
      <div className="mx-auto grid h-14 w-full max-w-[1600px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-4">
        <div />

        <nav aria-label="Primary" className="inline-flex items-center gap-1.5 justify-self-center rounded-full border bg-muted/50 p-1.5">
          {DESTINATIONS.map(({ label, icon: Icon, to }) => {
            const active = pathname === to;
            return (
              <Link
                key={label}
                to={to}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-full px-3.5 py-1.5 text-sm focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                  active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon aria-hidden className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3 justify-self-end">
          {/*
            A real <select>, not the Radix listbox: the e2e suite asserts
            getByRole("option", { name }) without opening anything, and Radix only renders its
            options into a portal while open. `aria-label="Project"` is the only thing naming this
            control now that the "Project" text beside it is gone — the e2e suite locates it that way.
          */}
          <NativeSelect
            aria-label="Project"
            size="lg"
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
            className="w-44"
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
            Edit is here; DELETE IS NOT. Delete lives inside the edit dialog, because a
            one-click destructive control sitting between the project picker and the theme
            toggle is a control you hit by accident — and this one removes every ticket and
            the downloaded clone. Reaching it should take a
            deliberate second step. Edit stays rendered-but-disabled on "All projects": hiding
            it is what review rejected, since a first-time user then never learns it exists.
          */}
          <button
            type="button"
            disabled={selected === null}
            aria-label={selected === null ? "Edit project" : `Edit ${selected.name}`}
            title={
              selected === null
                ? "Pick a project in the picker to edit it"
                : `Edit ${selected.name}, or delete it from there`
            }
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
        // The editor hands the destructive step back rather than owning it: closing the editor
        // first keeps exactly one dialog on screen, and the confirmation is the only place the
        // full list of what gets destroyed belongs.
        onRequestDelete={() => {
          setEditorOpen(false);
          setDeleting(editing);
        }}
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
