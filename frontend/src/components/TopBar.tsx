import { ArrowDownWideNarrow, ArrowUpNarrowWide, Funnel, Moon, Search, Sun } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import { ALL_PROJECTS } from "@/lib/board.ts";
import type { Theme } from "@/lib/theme.ts";
import type { Project, SortOrder } from "@/types.ts";

type Props = {
  projects: Project[];
  projectId: string;
  onProjectChange: (id: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  order: SortOrder;
  onOrderChange: (o: SortOrder) => void;
  theme: Theme;
  onThemeToggle: () => void;
};

export function TopBar({
  projects,
  projectId,
  onProjectChange,
  query,
  onQueryChange,
  order,
  onOrderChange,
  theme,
  onThemeToggle,
}: Props) {
  const newestFirst = order === "newest";

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2">
      <span className="font-semibold tracking-tight">10x</span>

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Project
        {/*
          A real <select>, not the Radix listbox: the e2e suite asserts
          getByRole("option", { name }) without opening anything, and Radix only renders its
          options into a portal while open.
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
      </label>

      <div className="relative min-w-48 flex-1">
        <Search aria-hidden className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          aria-label="Search tickets"
          placeholder="Search title, description or id"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          className="h-8 pl-7"
        />
      </div>

      {/*
        Sort and Filters sit together at the right edge. Sort is one button rather than a
        select because there is exactly one key to sort by; the arrow carries the direction and
        the accessible name spells out what the next click does, since "ascending" on a date is
        ambiguous in a way "oldest first" is not.
      */}
      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          aria-label={newestFirst ? "Sorted newest first. Sort oldest first" : "Sorted oldest first. Sort newest first"}
          title={newestFirst ? "Newest first" : "Oldest first"}
          onClick={() => onOrderChange(newestFirst ? "oldest" : "newest")}
        >
          Sort by
          {newestFirst ? (
            <ArrowDownWideNarrow aria-hidden className="size-3.5" />
          ) : (
            <ArrowUpNarrowWide aria-hidden className="size-3.5" />
          )}
        </Button>
        <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs">
          Filters
          <Funnel aria-hidden className="size-3.5" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onThemeToggle}
        >
          {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
        </Button>
      </div>
    </header>
  );
}
