import { useEffect, useRef, useState } from "react";

export type SaveState = "saved" | "pending" | "saving" | "error";

/**
 * Debounced autosave. Skips the initial value, saves `delay` ms after the
 * last change, and reports a state the UI can show next to the form.
 */
export function useAutosave<T>(value: T, save: (value: T) => Promise<void>, delay = 600) {
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const initial = useRef(true);

  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    setState("pending");
    const timer = setTimeout(() => {
      setState("saving");
      save(value)
        .then(() => { setState("saved"); setError(null); })
        .catch((e: unknown) => { setState("error"); setError(e instanceof Error ? e.message : String(e)); });
    }, delay);
    return () => clearTimeout(timer);
  }, [value]);

  return { state, error };
}

/** Compact status text for a save state. */
export function saveLabel(state: SaveState): string {
  return { saved: "Saved", pending: "Unsaved", saving: "Saving…", error: "Save failed" }[state];
}
