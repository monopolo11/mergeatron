import { useRef, useState } from "react";
import type { TokenOption } from "@/components/TokenInput";
import { cn } from "@/lib/utils";
import { highlightQuery, parseQuery, quoteLabel, quoteValue, type QueryKey, type QuerySpan } from "../../src/filterQuery.ts";

/** What ends the term being typed: a parenthesis, comma, quote, negation or an `and`/`or` word. */
const BOUNDARY = /[(),!"]|not:|\b(?:and|or)\s/gi;

/** Values offered per key; `label` holds the labels. A key without an entry is not offered. */
export type FilterOptions = Partial<Record<QueryKey, TokenOption[]>>;

type Suggestion = { group: "Fields" | "Labels" | "Values"; text: string; hint: string; insert: string };

const SPAN_CLASS: Record<QuerySpan["kind"], string> = { key: "text-active", op: "text-muted-foreground", not: "text-destructive", text: "" };

/**
 * A filter expression (`reason:assigned and state:Todo and !has:parent`, see
 * `filterQuery.ts`) typed as text, keys and operators highlighted. Focusing
 * it empty lists the keys and the common labels; after `key:` it offers that
 * key's values (seen in the inbox or synced, with counts). Arrows pick, enter
 * or tab inserts. Parse errors show under the input.
 */
export function FilterInput({ value, onChange, options, placeholder }: { value: string; onChange: (value: string) => void; options: FilterOptions; placeholder?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [scroll, setScroll] = useState(0);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const before = value.slice(0, caret);
  const start = Math.max(0, ...Array.from(before.matchAll(BOUNDARY), (m) => m.index + m[0].length));
  const fragment = before.slice(start).trimStart();
  const from = caret - fragment.length;
  const suggestions = suggest(fragment, options);
  const parsed = parseQuery(value);

  const sync = () => {
    setCaret(inputRef.current?.selectionStart ?? value.length);
    setScroll(inputRef.current?.scrollLeft ?? 0);
  };
  const insert = (text: string) => {
    const next = value.slice(0, from) + text + value.slice(caret).trimStart();
    const at = from + text.length;
    onChange(next);
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(at, at);
      sync();
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const pick = open ? suggestions[active] : undefined;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(suggestions.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if ((e.key === "Enter" || e.key === "Tab") && pick && (fragment || e.key === "Enter")) {
      e.preventDefault();
      insert(pick.insert);
    } else if (e.key === "Enter") {
      e.preventDefault();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative grid gap-1">
      <div className="relative">
        <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center overflow-hidden border border-transparent px-2 font-mono text-xs whitespace-pre">
          <span style={{ transform: `translateX(${-scroll}px)` }}>
            {highlightQuery(value).map((span, index) => (
              <span key={index} className={SPAN_CLASS[span.kind]}>
                {span.text}
              </span>
            ))}
          </span>
        </div>
        <input
          ref={inputRef}
          className={cn(
            "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 font-mono text-xs text-transparent caret-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50 dark:bg-input/30",
            !parsed.ok && "border-destructive/60",
          )}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setScroll(e.target.scrollLeft);
            setOpen(true);
            setActive(0);
          }}
          onSelect={sync}
          onScroll={sync}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && suggestions.length > 0 && (
        <div className="absolute top-9 right-0 left-0 z-20 overflow-hidden rounded-md border bg-popover py-1 text-xs shadow-md">
          {suggestions.map((option, index) => (
            <div key={`${option.group}:${option.text}`}>
              {option.group !== suggestions[index - 1]?.group && <div className="px-2 pt-1 pb-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">{option.group}</div>}
              <button
                type="button"
                className={cn("flex w-full items-center justify-between gap-3 px-2 py-1 text-left font-mono hover:bg-muted/60", index === active && "bg-muted/60")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => insert(option.insert)}
              >
                <span className="truncate">{option.text}</span>
                <span className="shrink-0 text-muted-foreground">{option.hint}</span>
              </button>
            </div>
          ))}
        </div>
      )}
      {!parsed.ok && <span className="text-xs text-destructive">{parsed.error}</span>}
    </div>
  );
}

/**
 * What to offer for the term being typed: after `key:`, that key's values;
 * otherwise the keys it could start and the labels containing it.
 */
function suggest(fragment: string, options: FilterOptions): Suggestion[] {
  const typed = /^([a-z-]+):(.*)$/i.exec(fragment);
  const key = typed?.[1]!.toLowerCase();
  const values = key && key !== "label" ? options[key as QueryKey] : undefined;
  if (typed && values) {
    const query = typed[2]!.trim().toLowerCase();
    return values
      .filter((option) => option.value.toLowerCase().includes(query) && option.value.toLowerCase() !== query)
      .slice(0, 12)
      .map((option) => ({ group: "Values", text: option.value, hint: option.label ?? option.count?.toString() ?? "", insert: `${quoteValue(key as Exclude<QueryKey, "label">, option.value)} ` }));
  }
  const query = fragment.trim().toLowerCase();
  const fields = Object.entries(options).flatMap(([name, offered]): Suggestion[] =>
    name !== "label" && `${name}:`.startsWith(query) ? [{ group: "Fields", text: `${name}:`, hint: name === "any" ? "text in any field" : hintFor(offered), insert: `${name}:` }] : [],
  );
  const labels = (options.label ?? [])
    .filter((option) => option.value.toLowerCase().includes(query) && option.value.toLowerCase() !== query)
    .slice(0, query ? 12 : 5)
    .map((option): Suggestion => ({ group: "Labels", text: option.value, hint: option.count?.toString() ?? "", insert: `${quoteLabel(option.value)} ` }));
  return [...fields, ...labels];
}

/** A key's hint: its values when there are few (`parent, sub-issues`), else how many. */
function hintFor(offered: TokenOption[]): string {
  return offered.length <= 3 ? offered.map((option) => option.value).join(", ") : `${offered.length} values`;
}
