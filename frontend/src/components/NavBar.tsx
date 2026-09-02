import { IconMoonFilled, IconSunFilled } from "@tabler/icons-react";
import { BookOpen, Columns3, LayoutDashboard } from "lucide-react";

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ALL_PROJECTS } from "@/lib/board.ts";
import type { SteerMode } from "@/lib/steer-mode.ts";
import type { Theme } from "@/lib/theme.ts";
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

  return (
    <header className="shrink-0 border-b">
      <div className="mx-auto grid h-12 w-full max-w-[1600px] grid-cols-[1fr_auto_1fr] items-center gap-4 px-4">
        <div />

        <nav aria-label="Primary" className="inline-flex items-center gap-1 justify-self-center rounded-full border bg-muted/50 p-1">
          {DESTINATIONS.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              disabled={!active}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none ${
                active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon aria-hidden className="size-3.5" />
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
            className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors ${
              steerMode === "local"
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            <span
              aria-hidden
              className={`size-1.5 rounded-full ${steerMode === "local" ? "bg-emerald-500" : "bg-amber-500"}`}
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
            className="h-8 w-40"
          >
            <NativeSelectOption value={ALL_PROJECTS}>All projects</NativeSelectOption>
            {projects.map((p) => (
              <NativeSelectOption key={p.id} value={p.id}>
                {p.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>

          {/* Fixed size-8 square (not padding around an icon) gives the icon a box to centre in and matches the h-8 select beside it. */}
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-input bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none dark:bg-input/30 dark:hover:bg-input/50"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={onThemeToggle}
          >
            {theme === "dark" ? (
              <IconSunFilled aria-hidden className="size-4" />
            ) : (
              <IconMoonFilled aria-hidden className="size-4" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
