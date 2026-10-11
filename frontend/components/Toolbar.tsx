import type { ReactNode } from "react";
import { TONE_TEXT, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

/**
 * The bar at the top of every pane: page, side panel or editor. Sticky, one
 * row high, wraps when filters and actions outgrow the width. `title` is the
 * pane's name; counts, search and actions go in children. Use `ml-auto` on
 * the first right-aligned child.
 */
export function Toolbar({ title, children, className }: { title?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("sticky top-0 z-10 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background px-3 py-1 text-xs", className)}>
      {title !== undefined && <span className="truncate font-medium text-foreground">{title}</span>}
      {children}
    </div>
  );
}

/**
 * A count with its label: a filter toggle when given `onClick`, a plain
 * figure otherwise. The number takes the tone's colour above zero, so a row
 * of counts reads as a status line.
 */
export function Count({
  value,
  label,
  tone,
  active = false,
  onClick,
  title,
}: {
  value: number;
  label: string;
  tone?: Tone;
  active?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  const className = cn(
    "rounded px-1.5 py-0.5 font-mono whitespace-nowrap text-muted-foreground",
    onClick && "hover:bg-muted/60 hover:text-foreground",
    active && "bg-muted text-foreground",
  );
  const body = (
    <>
      <span className={cn("text-[13px] text-foreground", tone && value > 0 && TONE_TEXT[tone])}>{value}</span> {label}
    </>
  );
  if (!onClick) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" className={className} onClick={onClick} title={title} aria-pressed={active}>
      {body}
    </button>
  );
}

/** Thin vertical rule between groups of counts in a toolbar. */
export function ToolbarDivider() {
  return <span aria-hidden className="h-4 w-px bg-border" />;
}

/** A number inside a toolbar summary line, set a size up and in the foreground colour. */
export function Figure({ children }: { children: ReactNode }) {
  return <span className="text-[13px] text-foreground">{children}</span>;
}
