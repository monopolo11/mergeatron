import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { runStatus, TONE_BG, TONE_TEXT, type Tone } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { Verdict } from "../../src/completion.ts";
import type { Run } from "../../src/rules.ts";

/*
 * The small shared pieces every page is built from. Two text roles for
 * headings: `Heading` (13px, medium) names a section of a page body;
 * `GroupLabel` and field labels (11px, small caps, muted) name a control or a
 * group of rows.
 */

/** A labelled form control with an optional hint under it. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 content-start gap-1", className)}>
      <Label className="text-[11px] tracking-wide text-muted-foreground uppercase">{label}</Label>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** Heading of a section within a page body: a Settings section, an Analytics table. */
export function Heading({ children, className }: { children: ReactNode; className?: string }) {
  return <h2 className={cn("text-[13px] font-medium", className)}>{children}</h2>;
}

/** Small-caps label over a group of rows or options: inbox reasons, event groups. */
export function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("text-[11px] tracking-wide text-muted-foreground uppercase", className)}>{children}</div>;
}

/** Status dot in one of the five tones. */
export function Dot({ tone }: { tone: Tone }) {
  return <i className={cn("mr-1.5 inline-block size-[7px] rounded-full align-middle", TONE_BG[tone])} />;
}

/** A run's state in its colour, then muted detail (rule, time, thread) when given. */
export function RunStatus({ run, children }: { run: { status: Run["status"]; verdict?: Verdict | null }; children?: ReactNode }) {
  const { label, tone } = runStatus(run);
  return (
    <span>
      <span className={TONE_TEXT[tone]}>{label}</span>
      {children && <span className="text-muted-foreground"> · {children}</span>}
    </span>
  );
}

/** Muted one-liner for an empty or loading pane. */
export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("p-4 text-xs text-muted-foreground", className)}>{children}</p>;
}

/** Link that opens in a new tab: PRs, issues and T3 threads. */
export function ExternalLink({ href, title, className, children }: { href: string; title?: string; className?: string; children: ReactNode }) {
  return (
    <a href={href} title={title} target="_blank" rel="noreferrer" className={cn("link", className)}>
      {children}
    </a>
  );
}
