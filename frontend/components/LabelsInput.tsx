import { useRef, useState } from "react";
import type { TokenOption } from "@/components/TokenInput";
import { cn } from "@/lib/utils";
import { parseLabels, quoteLabel } from "../../src/labelQuery.ts";

/** What ends the label being typed: a parenthesis, comma, quote, negation or an `and`/`or` word. */
const BOUNDARY = /[(),!"]|not:|\b(?:and|or)\s/gi;

/**
 * A label expression (`(bug or p0) and !wontfix`, see `labelQuery.ts`) typed
 * as text. The label at the caret is completed from `options` (labels seen in
 * the inbox or synced, with counts); arrows pick, enter or tab inserts.
 * Parse errors show under the input.
 */
export function LabelsInput({ value, onChange, options, placeholder }: { value: string; onChange: (value: string) => void; options: TokenOption[]; placeholder?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const before = value.slice(0, caret);
  const start = Math.max(0, ...Array.from(before.matchAll(BOUNDARY), (m) => m.index + m[0].length));
  const fragment = before.slice(start).trimStart();
  const from = caret - fragment.length;
  const query = fragment.trim().toLowerCase();
  const suggestions = options.filter((option) => option.value.toLowerCase().includes(query) && option.value.toLowerCase() !== query).slice(0, 12);
  const parsed = parseLabels(value);

  const sync = () => setCaret(inputRef.current?.selectionStart ?? value.length);
  const insert = (label: string) => {
    const text = `${quoteLabel(label)} `;
    const next = value.slice(0, from) + text + value.slice(caret).trimStart();
    const at = from + text.length;
    onChange(next);
    setCaret(at);
    setActive(0);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
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
    } else if ((e.key === "Enter" || e.key === "Tab") && pick && query) {
      e.preventDefault();
      insert(pick.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative grid gap-1">
      <input
        ref={inputRef}
        className={cn(
          "h-8 w-full min-w-0 rounded-md border border-input bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-[3px] focus:ring-ring/50 dark:bg-input/30",
          !parsed.ok && "border-destructive/60",
        )}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
          setActive(0);
        }}
        onSelect={sync}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && suggestions.length > 0 && (
        <div className="absolute top-9 right-0 left-0 z-20 overflow-hidden rounded-md border bg-popover text-xs shadow-md">
          {suggestions.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className={cn("flex w-full items-center justify-between px-2 py-1 text-left hover:bg-muted/60", index === active && "bg-muted/60")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(option.value)}
            >
              <span>{option.value}</span>
              {option.count !== undefined && <span className="font-mono text-muted-foreground">{option.count}</span>}
            </button>
          ))}
        </div>
      )}
      {!parsed.ok && <span className="text-xs text-destructive">{parsed.error}</span>}
    </div>
  );
}
