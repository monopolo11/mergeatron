import type { ComponentProps } from "react";
import ReactConfetti from "react-confetti";

const CONFETTI_COLORS = ["#60A5FA", "#34D399", "#FBBF24", "#F87171", "#A78BFA"];

/** react-confetti positions its canvas absolutely and under dialogs; pin it to the viewport, above them. */
const CANVAS_STYLE = { position: "fixed", zIndex: 100, pointerEvents: "none" } as const;

type Props = Pick<ComponentProps<typeof ReactConfetti>, "onConfettiComplete" | "numberOfPieces" | "tweenDuration" | "recycle" | "colors">;

/** Page-wide confetti that rains once and stops, above dialogs and without catching clicks. */
export function Confetti({ numberOfPieces = 500, tweenDuration = 10000, recycle = false, colors = CONFETTI_COLORS, ...props }: Props) {
  return <ReactConfetti numberOfPieces={numberOfPieces} tweenDuration={tweenDuration} recycle={recycle} colors={colors} style={CANVAS_STYLE} {...props} />;
}
