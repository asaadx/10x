import { ArrowDownWideNarrow, ArrowUpNarrowWide, ListFilter, Search } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import type { SortOrder } from "@/types.ts";

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  order: SortOrder;
  onOrderChange: (o: SortOrder) => void;
};

export function BoardToolbar({ query, onQueryChange, order, onOrderChange }: Props) {
  const newestFirst = order === "newest";

  return (
    <div role="toolbar" aria-label="Board controls" className="h-14 shrink-0 border-b">
      {/*
        Capped to the same max width as the board, mx-auto centred like <main>: controls that
        overhang the content they act on read as belonging to something else.
      */}
      <div className="mx-auto flex h-full w-full max-w-[1600px] items-center gap-3 px-4">
        <div className="relative min-w-40 max-w-sm flex-1">
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
            <ListFilter aria-hidden className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
