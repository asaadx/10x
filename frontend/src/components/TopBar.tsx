import { Moon, Search, Sun } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
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
  const repoPath = projects.find((p) => p.id === projectId)?.repoPath ?? "";

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

      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Sort
        <NativeSelect
          aria-label="Sort"
          value={order}
          onChange={(e) => onOrderChange(e.target.value as SortOrder)}
          className="h-8 w-32"
        >
          <NativeSelectOption value="newest">Newest first</NativeSelectOption>
          <NativeSelectOption value="oldest">Oldest first</NativeSelectOption>
        </NativeSelect>
      </label>

      <Button
        size="icon"
        variant="ghost"
        className="size-8"
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={onThemeToggle}
      >
        {theme === "dark" ? <Sun aria-hidden className="size-4" /> : <Moon aria-hidden className="size-4" />}
      </Button>

      <span className="hidden truncate font-mono text-[11px] text-muted-foreground lg:inline">{repoPath}</span>
    </header>
  );
}
