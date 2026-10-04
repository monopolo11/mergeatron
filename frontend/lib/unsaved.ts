import { useBlocker } from "@tanstack/react-router";
import { useEffect } from "react";

const DISCARD = "Discard unsaved changes?";

/** Whether the open editor has unsaved changes. One editor is open at a time, so one flag covers the app. */
let unsaved = false;

/**
 * Marks the calling editor dirty while `dirty` holds: leaving the route or the
 * page asks first. Switching rules or presets keeps the same route, so those
 * callers ask through `confirmDiscard`.
 */
export function useUnsavedGuard(dirty: boolean) {
  useEffect(() => {
    unsaved = dirty;
    return () => {
      unsaved = false;
    };
  }, [dirty]);
  useBlocker({ shouldBlockFn: () => dirty && !window.confirm(DISCARD), enableBeforeUnload: dirty });
}

/** True when nothing is unsaved or the user agrees to drop it. */
export function confirmDiscard(): boolean {
  return !unsaved || window.confirm(DISCARD);
}
