import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const mono = "font-mono text-xs";

/**
 * Textarea for a prompt or message template, with the variables it can use
 * as chips that insert at the cursor, and a reset when a default is given.
 * Used by dispatch presets, the handoff prompt and the Slack messages.
 */
export function TemplateEditor({
  value,
  onChange,
  vars,
  fallback,
  placeholder,
  className,
  readOnly = false,
}: {
  value: string;
  onChange: (value: string) => void;
  vars: readonly string[];
  /** Default body; shows "Reset to default" while the value differs from it. */
  fallback?: string;
  placeholder?: string;
  /** Extra classes for the textarea, typically a min height. */
  className?: string;
  /** Shows the text muted with no chips, e.g. an older prompt version. */
  readOnly?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const textarea = ref.current;
    if (!textarea) return onChange(value + token);
    const { selectionStart, selectionEnd } = textarea;
    onChange(value.slice(0, selectionStart) + token + value.slice(selectionEnd));
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(selectionStart + token.length, selectionStart + token.length);
    });
  };

  return (
    <>
      <Textarea
        ref={ref}
        className={cn("min-h-20 leading-relaxed", mono, readOnly && "text-muted-foreground", className)}
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {!readOnly && <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {vars.map((name) => (
          <Button key={name} type="button" variant="ghost" size="xs" className={cn("h-5 px-1 text-primary", mono)} onClick={() => insert(name)}>
            {`{{${name}}}`}
          </Button>
        ))}
        {fallback !== undefined && value !== fallback && (
          <Button type="button" size="xs" variant="ghost" className="ml-auto text-primary" onClick={() => onChange(fallback)}>
            Reset to default
          </Button>
        )}
      </div>}
    </>
  );
}
