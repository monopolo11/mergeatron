import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dot } from "@/components/Field";
import type { Tone } from "@/lib/status";
import { cn } from "@/lib/utils";

/*
 * Small SVG charts for Analytics, one series kind per chart (no dual axes).
 * Each measures its container, keeps marks thin with recessive grid lines,
 * and shows a tooltip for the day under the pointer.
 */

/** Tone colours as CSS values, for SVG fills. */
const FILL: Record<Tone, string> = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--destructive)", active: "var(--active)", idle: "var(--muted-foreground)" };
const AXIS = 40;
const LABEL = 16;
/** Room above the top grid line for its label. */
const TOP = 6;

export type Series = { key: string; label: string; tone: Tone };
/** One x position: its label, and a value per series key. */
export type Point = { label: string; values: Record<string, number | null> };

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A round upper bound for the axis and its midpoint. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(value));
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * step).find((candidate) => candidate >= value)!;
}

/** Shared frame: grid, axis labels, x labels and the hover layer. Children draw the marks given the scale. */
function Frame({
  points,
  height,
  max,
  format,
  tooltip,
  children,
}: {
  points: Point[];
  height: number;
  max: number;
  format: (value: number) => string;
  tooltip: (point: Point) => ReactNode;
  children: (scale: { x: (index: number) => number; band: number; y: (value: number) => number }) => ReactNode;
}) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plot = Math.max(width - AXIS, 0);
  const band = points.length > 0 ? plot / points.length : 0;
  const y = (value: number) => TOP + height - (value / max) * height;
  const x = (index: number) => AXIS + index * band;
  // Label every nth day so labels never collide.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plot / 56))));

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg
          width={width}
          height={TOP + height + LABEL}
          className="block"
          onMouseMove={(e) => {
            // Measured against the svg: offsetX is relative to whichever mark is under the pointer.
            const index = Math.floor((e.clientX - e.currentTarget.getBoundingClientRect().left - AXIS) / band);
            setHover(index >= 0 && index < points.length ? index : null);
          }}
        >
          {[0, max / 2, max].map((tick) => (
            <g key={tick}>
              <line x1={AXIS} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--border)" />
              <text x={AXIS - 6} y={y(tick)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--muted-foreground)">
                {format(tick)}
              </text>
            </g>
          ))}
          {hover !== null && <rect x={x(hover)} y={TOP} width={band} height={height} fill="var(--foreground)" opacity={0.05} />}
          {children({ x, band, y })}
          {points.map((point, index) =>
            index % every === 0 ? (
              <text key={index} x={x(index) + band / 2} y={TOP + height + 12} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                {point.label}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {hover !== null && points[hover] && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2 py-1.5 text-xs shadow-md"
          style={x(hover) + band / 2 > width / 2 ? { right: width - x(hover) + 4 } : { left: x(hover) + band + 4 }}
        >
          <div className="mb-1 font-medium">{points[hover].label}</div>
          {tooltip(points[hover])}
        </div>
      )}
    </div>
  );
}

/** A legend row: dot and label per series. */
export function Legend({ series }: { series: Series[] }) {
  return (
    <span className="flex gap-3 text-[11px] font-normal text-muted-foreground">
      {series.map((item) => (
        <span key={item.key}>
          <Dot tone={item.tone} />
          {item.label}
        </span>
      ))}
    </span>
  );
}

/** Bars per x position, stacked by series in order, with a 2px gap between segments. */
export function StackedBars({ points, series, height = 120 }: { points: Point[]; series: Series[]; height?: number }) {
  const total = (point: Point) => series.reduce((sum, item) => sum + (point.values[item.key] ?? 0), 0);
  const max = niceMax(Math.max(0, ...points.map(total)));
  return (
    <Frame
      points={points}
      height={height}
      max={max}
      format={(value) => String(Math.round(value))}
      tooltip={(point) => (
        <div className="grid grid-cols-[auto_auto] gap-x-4 font-mono">
          {series.map((item) => (
            <Row key={item.key} tone={item.tone} label={item.label} value={String(point.values[item.key] ?? 0)} />
          ))}
          <span className="text-muted-foreground">total</span>
          <span className="text-right">{total(point)}</span>
        </div>
      )}
    >
      {({ x, band, y }) =>
        points.map((point, index) => {
          let top = y(0);
          const width = Math.max(1, Math.min(band - 2, 24));
          return series.map((item) => {
            const value = point.values[item.key] ?? 0;
            if (value === 0) return null;
            const h = y(0) - y(value);
            top -= h;
            return <rect key={`${index}-${item.key}`} x={x(index) + (band - width) / 2} y={top} width={width} height={Math.max(h - 2, 1)} fill={FILL[item.tone]} />;
          });
        })
      }
    </Frame>
  );
}

/** One series as a 2px line; days without a value break the line. */
export function LineChart({ points, series, format, height = 80 }: { points: Point[]; series: Series; format: (value: number) => string; height?: number }) {
  const values = points.map((point) => point.values[series.key] ?? null);
  const max = niceMax(Math.max(0, ...values.filter((value) => value !== null)));
  return (
    <Frame
      points={points}
      height={height}
      max={max}
      format={format}
      tooltip={(point) => (
        <div className="grid grid-cols-[auto_auto] gap-x-4 font-mono">
          <Row tone={series.tone} label={series.label} value={point.values[series.key] === null ? "-" : format(point.values[series.key] ?? 0)} />
        </div>
      )}
    >
      {({ x, band, y }) => {
        const segments: string[][] = [[]];
        values.forEach((value, index) => {
          if (value === null) segments.push([]);
          else segments.at(-1)!.push(`${x(index) + band / 2},${y(value)}`);
        });
        return segments.map((segment, index) =>
          segment.length === 1 ? (
            <circle key={index} cx={segment[0]!.split(",")[0]} cy={segment[0]!.split(",")[1]} r={2} fill={FILL[series.tone]} />
          ) : (
            <polyline key={index} points={segment.join(" ")} fill="none" stroke={FILL[series.tone]} strokeWidth={2} strokeLinejoin="round" />
          ),
        );
      }}
    </Frame>
  );
}

function Row({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">
        <Dot tone={tone} />
        {label}
      </span>
      <span className="text-right">{value}</span>
    </>
  );
}

/** A tiny trend line for a stat tile; nulls are skipped. */
export function Sparkline({ values, className }: { values: (number | null)[]; className?: string }) {
  const known = values.filter((value) => value !== null);
  if (known.length < 2) return null;
  const max = Math.max(...known);
  const min = Math.min(...known);
  const points = values.flatMap((value, index) => (value === null ? [] : [`${(index / (values.length - 1)) * 64},${17 - ((value - min) / (max - min || 1)) * 16}`]));
  return (
    <svg width={64} height={18} className={cn("shrink-0", className)} aria-hidden>
      <polyline points={points.join(" ")} fill="none" stroke="var(--muted-foreground)" strokeWidth={1.25} opacity={0.7} />
    </svg>
  );
}
