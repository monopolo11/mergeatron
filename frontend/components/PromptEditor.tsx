import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { Extension, Node, type Editor, type JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { api } from "@/lib/api";
import { detectTrigger, providerSkills, searchSkills, skillLabel, skillSource, splitSkills, type ComposerTrigger } from "@/lib/composer";
import { cn } from "@/lib/utils";
import type { T3Provider, T3Skill } from "../../src/t3.ts";

/** Lets a parent insert at the caret: variable chips, preset bodies. */
export type PromptEditorHandle = { insert: (text: string) => void };

/** An open trigger with its range in the document: from the `/` or `$` to the caret. */
type ActiveTrigger = ComposerTrigger & { from: number; to: number };

const SVG = "http://www.w3.org/2000/svg";

/**
 * A skill as one inline atom: a chip in the editor, `$name` in the text. Its
 * look is T3 Code's skill `ContextChip`.
 */
const SkillChip = Node.create({
  name: "skill",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes: () => ({ name: { default: "" }, label: { default: "" }, description: { default: null } }),
  parseHTML: () => [{ tag: "span[data-skill]", getAttrs: (element) => ({ name: element.dataset.skill, label: element.textContent }) }],
  renderText: ({ node }) => `$${node.attrs.name}`,
  renderHTML: ({ node }) => [
    "span",
    {
      "data-skill": node.attrs.name,
      title: node.attrs.description ?? `$${node.attrs.name}`,
      contenteditable: "false",
      class:
        "mx-px inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border border-[color-mix(in_oklab,var(--skill)_34%,var(--border))] bg-[color-mix(in_oklab,var(--skill)_11%,transparent)] px-[0.5em] align-middle font-sans text-[0.86em] leading-none font-medium text-[color-mix(in_oklab,var(--skill)_22%,var(--foreground))] [--skill:oklch(0.62_0.16_322)]",
    },
    [
      `${SVG} svg`,
      { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.85", "stroke-linecap": "round", "stroke-linejoin": "round", class: "size-[1.17em] shrink-0", "aria-hidden": "true" },
      [`${SVG} path`, { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }],
      [`${SVG} path`, { d: "m3.3 7 8.7 5 8.7-5" }],
      [`${SVG} path`, { d: "M12 22V12" }],
    ],
    ["span", { class: "truncate" }, node.attrs.label],
  ],
});

/** Shift+Enter is a plain newline too: a prompt has no soft breaks. */
const ShiftEnter = Extension.create({
  name: "shiftEnter",
  addKeyboardShortcuts() {
    return { "Shift-Enter": () => this.editor.commands.splitBlock() };
  },
});

const skillNode = (skill: T3Skill): JSONContent => ({ type: "skill", attrs: { name: skill.name, label: skillLabel(skill), description: skill.description } });

/** One paragraph per line, known `$name` tokens as chips. */
function toParagraphs(text: string, skills: readonly T3Skill[]): JSONContent[] {
  return text.split(/\r\n?|\n/).map((line) => ({
    type: "paragraph",
    content: splitSkills(line, skills).map((part) => (typeof part === "string" ? { type: "text", text: part } : skillNode(part))),
  }));
}

/** The prompt as text: lines joined by newlines, chips as `$name`. */
const serialize = (editor: Editor) => editor.getText({ blockSeparator: "\n" });

/** Inserts text at the caret: inline when it is one line, else as paragraphs that split the current one. */
function insertText(editor: Editor, text: string, skills: readonly T3Skill[]) {
  const paragraphs = toParagraphs(text, skills);
  editor.chain().focus().insertContent(paragraphs.length === 1 ? (paragraphs[0]!.content ?? []) : paragraphs).run();
}

/**
 * Turns known `$name` text into chips in place, for skills that loaded after
 * the text: the caret stays where it was and undo skips the change. A token
 * touching a chip is left alone, as `splitSkills` would leave it in the text.
 */
function chipSkills(editor: Editor, skills: readonly T3Skill[]) {
  const { state } = editor;
  const chips: Array<{ from: number; to: number; skill: T3Skill }> = [];
  state.doc.descendants((node, pos, parent, index) => {
    if (!node.isText || !parent) return;
    const text = node.text ?? "";
    let offset = 0;
    for (const part of splitSkills(text, skills)) {
      // The token is the currency sign plus the name.
      const length = typeof part === "string" ? part.length : part.name.length + 1;
      const touchesChip = (offset === 0 && index > 0) || (offset + length === text.length && index < parent.childCount - 1);
      if (typeof part !== "string" && !touchesChip) chips.push({ from: pos + offset, to: pos + offset + length, skill: part });
      offset += length;
    }
  });
  if (chips.length === 0) return;
  const tr = state.tr;
  // Last first, so earlier positions stay valid.
  for (const { from, to, skill } of chips.reverse()) tr.replaceWith(from, to, state.schema.nodeFromJSON(skillNode(skill)));
  editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
}

/** The `/` or `$` trigger ending at the caret, if any. Chips read as one non-space character. */
function readTrigger(editor: Editor): ActiveTrigger | null {
  const { selection, doc } = editor.state;
  if (!selection.empty) return null;
  const lineStart = selection.$from.start();
  const trigger = detectTrigger(doc.textBetween(lineStart, selection.from, "\n", "￼"));
  return trigger && { ...trigger, from: lineStart + trigger.start, to: selection.from };
}

/**
 * The prompt editor, after T3 Code's composer: plain text where a skill is
 * a chip. `/` at the start of a line or `$` anywhere opens a skill menu
 * (arrows move, Enter or Tab picks, Escape closes); a pick inserts `$name`.
 * With `skills` off it is a plain editor, for messages no agent reads.
 */
export function PromptEditor({
  value,
  onChange,
  placeholder,
  className,
  readOnly = false,
  skills: skillsEnabled = true,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Extra classes for the box, typically a min height and font. */
  className?: string;
  readOnly?: boolean;
  skills?: boolean;
  ref?: Ref<PromptEditorHandle>;
}) {
  // Same key as the model pickers, so the providers load once.
  const providers = useQuery({ queryKey: ["providers"], queryFn: () => api<T3Provider[]>("/api/t3/providers"), enabled: skillsEnabled });
  const skills = useMemo(() => (skillsEnabled ? providerSkills(providers.data ?? []) : []), [skillsEnabled, providers.data]);

  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null);
  const [focused, setFocused] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const items = useMemo(() => (trigger ? searchSkills(skills, trigger) : []), [skills, trigger]);
  const open = skillsEnabled && focused && !readOnly && trigger !== null && trigger.from !== dismissedAt;

  // The editor's handlers are bound once; they read the latest render through this.
  const latest = useRef({ onChange, skills, items, active, open, trigger, editor: null as Editor | null });

  const pick = (skill: T3Skill) => {
    const { trigger: current, editor } = latest.current;
    if (!editor || !current) return;
    // Swallow a space already after the token so the pick leaves exactly one.
    const to = editor.state.doc.textBetween(current.to, Math.min(current.to + 1, editor.state.doc.content.size - 1)) === " " ? current.to + 1 : current.to;
    editor.chain().focus().insertContentAt({ from: current.from, to }, [skillNode(skill), { type: "text", text: " " }]).run();
  };

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, ShiftEnter, SkillChip, Placeholder.configure({ placeholder: placeholder ?? "" })],
    content: { type: "doc", content: toParagraphs(value, skills) },
    editable: !readOnly,
    coreExtensionOptions: { clipboardTextSerializer: { blockSeparator: "\n" } },
    editorProps: {
      handleKeyDown: (_view, event) => {
        const { open, items, active } = latest.current;
        if (!open || items.length === 0 || event.isComposing) return false;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          setActive((active + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
          return true;
        }
        if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
          pick(items[active] ?? items[0]!);
          return true;
        }
        return false;
      },
      // Plain text only, kept line for line (ProseMirror would drop blank lines), with known skills as chips.
      handlePaste: (_view, event) => {
        const text = event.clipboardData?.getData("text/plain");
        const { editor, skills } = latest.current;
        if (!text || !editor) return false;
        insertText(editor, text, skills);
        return true;
      },
    },
    onUpdate: ({ editor }) => latest.current.onChange(serialize(editor)),
    onTransaction: ({ editor }) => setTrigger(readTrigger(editor)),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  });

  latest.current = { onChange, skills, items, active, open, trigger, editor };

  useImperativeHandle(ref, () => ({ insert: (text) => editor && insertText(editor, text, latest.current.skills) }), [editor]);

  // Follow outside changes (reset, version switch), and chip `$name`s in place once the skills load.
  const renderedSkills = useRef(skills);
  useEffect(() => {
    if (!editor) return;
    if (serialize(editor) !== value) editor.commands.setContent({ type: "doc", content: toParagraphs(value, skills) }, { emitUpdate: false });
    else if (renderedSkills.current !== skills) chipSkills(editor, skills);
    renderedSkills.current = skills;
  }, [editor, value, skills]);

  useEffect(() => editor?.setEditable(!readOnly, false), [editor, readOnly]);

  // A new trigger starts at its first item and forgets an Escape on an older one.
  useEffect(() => {
    setActive(0);
    if (trigger?.from !== dismissedAt) setDismissedAt(null);
  }, [trigger?.from, trigger?.query]);

  // Escape closes the menu, not the dialog around the editor: Radix listens on the document in the capture phase, so catch it first.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setDismissedAt(latest.current.trigger?.from ?? null);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open]);

  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="relative">
      <EditorContent
        editor={editor}
        className={cn(
          "prompt-editor flex min-h-16 w-full cursor-text flex-col rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30",
          className,
        )}
      />
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Skills"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border bg-popover p-1 font-sans text-popover-foreground shadow-md"
        >
          {items.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              {providers.isPending ? "Loading skills…" : trigger.kind === "skill" ? "No skills found." : "No matching command."}
            </p>
          ) : (
            items.map((skill, index) => (
              <div
                key={skill.name}
                role="option"
                aria-selected={index === active}
                data-index={index}
                className={cn("flex h-7 cursor-default items-center gap-2 rounded px-2 text-xs", index === active && "bg-accent")}
                onMouseMove={() => index !== active && setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(skill)}
              >
                <span className="max-w-[45%] shrink-0 truncate font-medium">
                  {trigger.kind === "slash" && <span className="text-muted-foreground">/skill:</span>}
                  {skillLabel(skill)}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{skill.description ?? (skill.scope ? `${skill.scope} skill` : "")}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{skillSource(skill)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
