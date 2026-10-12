import * as React from "react"
import { TONE_TEXT, type Tone } from "@/lib/status"
import { cn } from "@/lib/utils"

/*
 * Dense defaults for every table in the app: 12px text, 28px muted column
 * labels, 8px horizontal cell padding, rows that keep their bottom border.
 * Callers add alignment and width, nothing else.
 */

/**
 * Classes for a column that only shows when the table has room (56rem wide).
 * Needs an `@container` ancestor, usually the page, sized like the table.
 */
const WIDE = "hidden @4xl:table-cell"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-xs", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("[&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={className}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b hover:bg-muted/40 data-[state=selected]:bg-muted/60",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-7 px-2 text-left align-middle font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-2 py-1.5 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Right-aligned mono count in a tone; zeros are dimmed so the non-zero figures stand out. */
function TableFigure({ value, tone, className }: { value: number; tone?: Tone; className?: string }) {
  return (
    <TableCell className={cn("text-right font-mono", value > 0 ? tone && TONE_TEXT[tone] : "text-muted-foreground/60", className)}>
      {value}
    </TableCell>
  )
}

export {
  WIDE,
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
  TableFigure,
}
