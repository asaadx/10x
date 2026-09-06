import { ArrowDownWideNarrow, ArrowUpNarrowWide, ListFilter, Search } from "lucide-react";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";
import type { SortDirection, SortKey, SortOrder } from "@/types.ts";

type Props = {
  query: string;
  onQueryChange: (q: string) => void;
  order: SortOrder;
  onOrderChange: (o: SortOrder) => void;
};

/** What "desc"/"asc" mean in words, per key: newest/highest first vs oldest/lowest first. */
const DIRECTION_LABEL: Record<SortKey, Record<SortDirection, string>> = {
  date: { desc: "Newest first", asc: "Oldest first" },
  priority: { desc: "Highest first", asc: "Lowest first" },
};

const isSortKey = (value: string): value is SortKey => value === "date" || value === "priority";

export function BoardToolbar({ query, onQueryChange, order, onOrderChange }: Props) {
  const otherDirection: SortDirection = order.direction === "desc" ? "asc" : "desc";

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
          Sort and Filters sit together at the right edge. Sort is now two controls instead of
          one button: a select for which field orders the board, and an icon button whose
          accessible name spells out what the next click does. The arrow's meaning is generic
          across both keys — "desc" is always the highest value first — so one toggle serves
          Date and Priority alike; only the words in the accessible name change.
        */}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Sort by</span>
          <NativeSelect
            aria-label="Sort by"
            value={order.key}
            onChange={(e) => {
              const next = e.target.value;
              if (isSortKey(next)) onOrderChange({ ...order, key: next });
            }}
            className="h-8 w-28"
          >
            <NativeSelectOption value="date">Date</NativeSelectOption>
            <NativeSelectOption value="priority">Priority</NativeSelectOption>
          </NativeSelect>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8"
            aria-label={`Sorted ${DIRECTION_LABEL[order.key][order.direction].toLowerCase()}. Sort ${DIRECTION_LABEL[order.key][otherDirection].toLowerCase()}`}
            title={DIRECTION_LABEL[order.key][order.direction]}
            onClick={() => onOrderChange({ ...order, direction: otherDirection })}
          >
            {order.direction === "desc" ? (
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
