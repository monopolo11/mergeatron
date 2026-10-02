import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type TokenOption = { value: string; label?: string; count?: number };

/**
 * A list of values as removable tokens with a text input to add more. Typing
 * filters `options` (values seen in the inbox, with counts); enter or comma
 * adds the highlighted option or, unless `optionsOnly`, the text as typed.
 * Backspace on an empty input removes the last token. Values compare
 * case-insensitively, like the rule matcher.
 */
export function TokenInput({
  value,
  onChange,
  options = [],
  optionsOnly = false,
  placeholder,
  className,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  options?: TokenOption[];
  optionsOnly?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const has = (candidate: string) => value.some((v) => v.toLowerCase() === candidate.toLowerCase());
  const query = text.trim().toLowerCase();
  const suggestions = options.filter((option) => !has(option.value) && (option.label ?? option.value).toLowerCase().includes(query)).slice(0, 12);
  const labelOf = (v: string) => options.find((option) => option.value.toLowerCase() === v.toLowerCase())?.label ?? v;

  const add = (candidate: string) => {
    const next = candidate.trim();
    if (!next || has(next)) return;
    onChange([...value, next]);
    setText("");
    setActive(0);
  };
  const remove = (candidate: string) => onChange(value.filter((v) => v !== candidate));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(suggestions.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const pick = suggestions[active];
      if (pick) add(pick.value);
      else if (!optionsOnly) add(text);
    } else if (e.key === "Backspace" && text === "" && value.length > 0) {
      remove(value[value.length - 1]!);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={cn("relative", className)}>
      <div
        className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-1.5 py-1 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded border bg-background px-1.5 text-xs leading-5">
            {labelOf(v)}
            <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`remove ${v}`} onClick={(e) => { e.stopPropagation(); remove(v); }}>×</button>
          </span>
        ))}
        <input
          ref={inputRef}
          className="min-w-24 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          value={text}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(e) => { setText(e.target.value); setOpen(true); setActive(0); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
        />
      </div>
      {open && (suggestions.length > 0 || (!optionsOnly && query)) && (
        <div className="absolute top-full right-0 left-0 z-20 mt-1 overflow-hidden rounded-md border bg-popover text-xs shadow-md">
          {suggestions.map((option, index) => (
            <button
              key={option.value}
              type="button"
              className={cn("flex w-full items-center justify-between px-2 py-1 text-left hover:bg-muted/60", index === active && "bg-muted/60")}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => add(option.value)}
            >
              <span>{option.label ?? option.value}</span>
              {option.count !== undefined && <span className="font-mono text-muted-foreground">{option.count}</span>}
            </button>
          ))}
          {!optionsOnly && query && !suggestions.some((option) => option.value.toLowerCase() === query) && (
            <div className="border-t px-2 py-1 text-muted-foreground">enter adds "{text.trim()}" as typed</div>
          )}
        </div>
      )}
    </div>
  );
}
