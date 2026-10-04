import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState } from "react";

export type SaveState = "saved" | "pending" | "saving" | "error";

/**
 * A TanStack form that saves itself `delay` ms after the last change.
 * `save` gets the form values; its failure shows as the "error" state until
 * the next change. Returns the form plus a state the UI can show next to it.
 */
export function useAutosaveForm<T extends object>({ defaultValues, save, delay = 600 }: { defaultValues: T; save: (value: T) => Promise<void>; delay?: number }) {
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const form = useForm({
    defaultValues,
    listeners: {
      onChange: ({ formApi }) => {
        setState("pending");
        clearTimeout(timer.current);
        timer.current = setTimeout(() => void formApi.handleSubmit(), delay);
      },
    },
    onSubmit: async ({ value }) => {
      setState("saving");
      try {
        await save(value);
        setState("saved");
        setError(null);
      } catch (e) {
        setState("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    },
  });

  useEffect(() => () => clearTimeout(timer.current), []);
  return { form, state, error };
}

/** The form `useAutosaveForm<T>` returns, for passing to child components. */
export type AutosaveForm<T extends object> = ReturnType<typeof useAutosaveForm<T>>["form"];

/** Compact status text for a save state. */
export function saveLabel(state: SaveState): string {
  return { saved: "Saved", pending: "Unsaved", saving: "Saving…", error: "Save failed" }[state];
}
