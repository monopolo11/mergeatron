import { useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarIcon, CheckIcon, ChevronDownIcon, ChevronLeftIcon, PlusIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DEFAULT_RANGE, isoDay, RANGE_PRESETS, resolveWindow, type RangePreset, type ScopeSearch } from "@/lib/scope";
import { cn } from "@/lib/utils";

/** One value a facet offers: `text` is what the menu search matches and the token shows. */
export type FacetOption = { value: string; text: string; label?: ReactNode; count?: number };

/**
 * A filterable field: its values, which are picked (any of), and how to
 * change them. `toggle` is an on/off choice listed above the values, such as
 * "Live versions only"; while on it reads first in the facet's token.
 */
export type Facet = {
  key: string;
  label: string;
  options: FacetOption[];
  selected: readonly string[];
  onChange: (values: string[]) => void;
  /** Clears the values and the toggle at once; without it, clearing sets no values. */
  onClear?: () => void;
  toggle?: { label: string; token: string; on: boolean; count?: number; onChange: (on: boolean) => void };
  /** Turns the picked values into ones to leave out: the token reads "is not" / "is none of". */
  negate?: { on: boolean; onChange: (on: boolean) => void };
};

/** The scope search params and a setter that merges a patch into the URL, keeping the rest. */
export function useScope() {
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();
  const setScope = (patch: Partial<ScopeSearch>) => void navigate({ to: ".", search: (prev: ScopeSearch) => ({ ...prev, ...patch }), replace: true });
  return { search, setScope };
}

/**
 * The bar under every page title: date range, a token per active filter, and
 * `+ Filter` to add one. Right-aligned extras (search, actions) go in
 * `children`. Without `facets` it is just the range.
 */
export function FilterBar({ facets = [], children }: { facets?: Facet[]; children?: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  const active = facets.filter((facet) => facet.selected.length > 0 || facet.toggle?.on);
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-t px-3 py-1.5 text-xs">
      <RangePicker />
      {facets.length > 0 && <span aria-hidden className="h-4 w-px bg-border" />}
      {active.map((facet) => (
        <span key={facet.key} className="inline-flex h-6 max-w-80 items-center rounded-md border whitespace-nowrap">
          <FacetMenu facets={facets} start={facet.key} open={open === facet.key} onOpenChange={(next) => setOpen(next ? facet.key : null)}>
            <button type="button" className="inline-flex h-full min-w-0 items-center gap-1.5 rounded-l-md pr-1 pl-2 hover:bg-muted/60">
              <TokenText facet={facet} />
            </button>
          </FacetMenu>
          <button
            type="button"
            aria-label={`Clear ${facet.label} filter`}
            className="h-full rounded-r-md pr-1.5 pl-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={() => (facet.onClear ? facet.onClear() : facet.onChange([]))}
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
      {facets.length > 0 && (
        <FacetMenu facets={facets} open={open === ""} onOpenChange={(next) => setOpen(next ? "" : null)}>
          <Button size="xs" variant="ghost" className="text-muted-foreground">
            <PlusIcon />
            Filter
          </Button>
        </FacetMenu>
      )}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}

/** A token's text: `Model is opus`, `Model is any of opus, sonnet`, `Status is not skipped`, `Prompt is live versions`. */
function TokenText({ facet }: { facet: Facet }) {
  const texts = facet.selected.map((value) => facet.options.find((option) => option.value === value)?.text ?? value);
  const parts = [facet.toggle?.on ? facet.toggle.token : null, texts.length > 2 ? `${texts.length} ${facet.label.toLowerCase()}s` : texts.join(", ")].filter(Boolean);
  const many = texts.length > 1 || (facet.toggle?.on && texts.length > 0);
  const relation = facet.negate?.on ? (many ? "is none of" : "is not") : many ? "is any of" : "is";
  return (
    <>
      {facet.label}
      <span className="text-muted-foreground">{relation}</span>
      <span className="truncate">{parts.join(", ")}</span>
    </>
  );
}

/**
 * The filter menu: facets first, then the picked facet's values with counts.
 * Picking a value toggles it and keeps the menu open; Backspace in an empty
 * search goes back to the facets. `start` opens straight on one facet.
 */
function FacetMenu({ facets, start, open, onOpenChange, children }: { facets: Facet[]; start?: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  const [key, setKey] = useState<string | null>(start ?? null);
  const [query, setQuery] = useState("");
  const facet = facets.find((candidate) => candidate.key === key);
  const pick = (next: string | null) => {
    setKey(next);
    setQuery("");
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next) pick(start ?? null);
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={facet ? `${facet.label}…` : "Filter by…"}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && query === "" && facet && !start) pick(null);
            }}
          />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {!facet ? (
              <CommandGroup>
                {facets.map((candidate) => (
                  <CommandItem key={candidate.key} value={candidate.label} onSelect={() => pick(candidate.key)}>
                    {candidate.label}
                    <span className="ml-auto font-mono text-muted-foreground">{candidate.selected.length || ""}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : (
              <>
                {!start && (
                  <CommandGroup>
                    <CommandItem value="__back" onSelect={() => pick(null)} className="text-muted-foreground">
                      <ChevronLeftIcon />
                      {facet.label}
                    </CommandItem>
                  </CommandGroup>
                )}
                {facet.negate && (
                  <>
                    <CommandGroup>
                      <CommandItem value="Exclude selected" onSelect={() => facet.negate!.onChange(!facet.negate!.on)}>
                        <Check on={facet.negate.on} />
                        Exclude selected
                      </CommandItem>
                    </CommandGroup>
                    <CommandSeparator />
                  </>
                )}
                {facet.toggle && (
                  <>
                    <CommandGroup>
                      <CommandItem value={facet.toggle.label} onSelect={() => facet.toggle!.onChange(!facet.toggle!.on)}>
                        <Check on={facet.toggle.on} />
                        {facet.toggle.label}
                        <Count value={facet.toggle.count} />
                      </CommandItem>
                    </CommandGroup>
                    <CommandSeparator />
                  </>
                )}
                <CommandGroup>
                  {facet.options.map((option) => {
                    const on = facet.selected.includes(option.value);
                    return (
                      <CommandItem
                        key={option.value}
                        value={`${option.text} ${option.value}`}
                        onSelect={() => facet.onChange(on ? facet.selected.filter((value) => value !== option.value) : [...facet.selected, option.value])}
                      >
                        <Check on={on} />
                        <span className="truncate">{option.label ?? option.text}</span>
                        <Count value={option.count} />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Check({ on }: { on: boolean }) {
  return (
    <span className={cn("grid size-3.5 shrink-0 place-items-center rounded-[3px] border border-input", on && "border-foreground bg-foreground text-background")}>
      {on && <CheckIcon className="size-2.5! text-background" />}
    </span>
  );
}

function Count({ value }: { value: number | undefined }) {
  return value === undefined ? null : <span className="ml-auto pl-2 font-mono text-xs text-muted-foreground">{value}</span>;
}

/**
 * The page's date range: presets on the left, a two-month calendar on the
 * right. Picking a preset clears a custom range; finishing a range in the
 * calendar sets `from` and `to`.
 */
export function RangePicker({ compact = false }: { compact?: boolean }) {
  const { search, setScope } = useScope();
  const [open, setOpen] = useState(false);
  const window = resolveWindow(search);
  const custom = Boolean(search.from && search.to);
  const [draft, setDraft] = useState<DateRange | undefined>();
  const selected: DateRange | undefined =
    draft ?? (window.from ? { from: new Date(window.from), to: window.to ? new Date(Date.parse(window.to) - 1) : new Date() } : undefined);

  const end = selected?.to ?? new Date();

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setDraft(undefined);
      }}
    >
      <PopoverTrigger asChild>
        <Button size="xs" variant="outline" className="font-normal" title={window.detail ?? undefined}>
          <CalendarIcon className="text-muted-foreground" />
          {window.label}
          {!compact && window.detail && <span className="text-muted-foreground">{window.detail}</span>}
          <ChevronDownIcon className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto p-0">
        <div className="grid content-start border-r p-1 text-xs">
          {Object.entries(RANGE_PRESETS).map(([key, { label }]) => {
            const on = !custom && (search.range ?? DEFAULT_RANGE) === key;
            return (
              <button
                key={key}
                type="button"
                className={cn("rounded-sm px-2 py-1.5 text-left whitespace-nowrap hover:bg-muted", on && "bg-muted text-foreground")}
                onClick={() => {
                  setScope({ range: key as RangePreset, from: undefined, to: undefined });
                  setOpen(false);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <Calendar
          mode="range"
          numberOfMonths={2}
          // The range's last month shows on the right, and nothing past this month.
          defaultMonth={new Date(end.getFullYear(), end.getMonth() - 1)}
          endMonth={new Date()}
          selected={selected}
          disabled={{ after: new Date() }}
          onSelect={(range, day) => {
            // A click after a complete range starts a new one rather than stretching it.
            const next = draft === undefined ? { from: day, to: undefined } : range;
            setDraft(next);
            if (next?.from && next.to) {
              setScope({ range: undefined, from: isoDay(next.from), to: isoDay(next.to) });
              setOpen(false);
            }
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
