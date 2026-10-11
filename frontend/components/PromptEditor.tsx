import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { useQuery } from "@tanstack/react-query";
import { Extension, InputRule, Node, type Editor, type JSONContent } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { api } from "@/lib/api";
import { detectTrigger, providerSkills, searchSkills, skillLabel, skillSource, splitSkills, splitVariables, variableService, type ComposerTrigger, type VariableService } from "@/lib/composer";
import { cn } from "@/lib/utils";
import type { T3Provider, T3Skill } from "../../src/t3.ts";

/** Lets a parent insert at the caret: variables, preset bodies. */
export type PromptEditorHandle = { insert: (text: string) => void };

/** An open trigger with its range in the document: from the `/` or `$` to the caret. */
type ActiveTrigger = ComposerTrigger & { from: number; to: number };

const SVG = "http://www.w3.org/2000/svg";

/** An inline chip tinted by `--chip`; T3 Code's skill `ContextChip`. */
const CHIP =
  "mx-px inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-[0.5em] border border-[color-mix(in_oklab,var(--chip)_34%,var(--border))] bg-[color-mix(in_oklab,var(--chip)_11%,transparent)] px-[0.5em] align-middle font-sans text-[0.86em] leading-none font-medium text-[color-mix(in_oklab,var(--chip)_22%,var(--foreground))]";
const ICON = { viewBox: "0 0 24 24", class: "size-[1.17em] shrink-0", "aria-hidden": "true" };
const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.85", "stroke-linecap": "round", "stroke-linejoin": "round" };

/** Chip icons: a variable shows its service's logo (Simple Icons; Slack's from before its removal), else braces (Lucide). */
const icons = {
  skill: [
    `${SVG} svg`,
    { ...ICON, ...STROKE },
    [`${SVG} path`, { d: "M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" }],
    [`${SVG} path`, { d: "m3.3 7 8.7 5 8.7-5" }],
    [`${SVG} path`, { d: "M12 22V12" }],
  ],
  variable: [
    `${SVG} svg`,
    { ...ICON, ...STROKE },
    [`${SVG} path`, { d: "M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1" }],
    [`${SVG} path`, { d: "M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1" }],
  ],
  github: [
    `${SVG} svg`,
    { ...ICON, fill: "currentColor", class: "size-[1em] shrink-0" },
    [
      `${SVG} path`,
      {
        d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
      },
    ],
  ],
  slack: [
    `${SVG} svg`,
    { ...ICON, fill: "currentColor", class: "size-[1em] shrink-0" },
    [
      `${SVG} path`,
      {
        d: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
      },
    ],
  ],
  linear: [
    `${SVG} svg`,
    { ...ICON, fill: "currentColor", class: "size-[1em] shrink-0" },
    [
      `${SVG} path`,
      {
        d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
      },
    ],
  ],
  sentry: [
    `${SVG} svg`,
    { ...ICON, fill: "currentColor", class: "size-[1em] shrink-0" },
    [
      `${SVG} path`,
      {
        d: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
      },
    ],
  ],
} as const;

/**
 * A skill as one inline atom: a chip in the editor, `$name` in the text.
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
    { "data-skill": node.attrs.name, title: node.attrs.description ?? `$${node.attrs.name}`, contenteditable: "false", class: `${CHIP} [--chip:oklch(0.62_0.16_322)]` },
    icons.skill,
    ["span", { class: "truncate" }, node.attrs.label],
  ],
});

/**
 * A template variable as one inline atom: a chip with its service's logo in
 * the editor, `{{name}}` in the text. Typing the closing `}}` makes one;
 * `source` is the service shared variables take (see `variableService`).
 */
const VariableChip = Node.create<{ source: () => VariableService | null }>({
  name: "variable",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addOptions: () => ({ source: () => null }),
  addAttributes: () => ({ name: { default: "" }, service: { default: null } }),
  parseHTML: () => [{ tag: "span[data-variable]", getAttrs: (element) => ({ name: element.dataset.variable, service: element.dataset.service ?? null }) }],
  renderText: ({ node }) => `{{${node.attrs.name}}}`,
  renderHTML: ({ node }) => [
    "span",
    { "data-variable": node.attrs.name, "data-service": node.attrs.service, title: `{{${node.attrs.name}}}`, contenteditable: "false", class: `${CHIP} [--chip:oklch(0.68_0.13_230)]` },
    icons[(node.attrs.service as VariableService | null) ?? "variable"],
    ["span", { class: "truncate" }, node.attrs.name],
  ],
  addInputRules() {
    return [
      new InputRule({
        find: /\{\{([a-zA-Z0-9_]+)\}\}$/,
        handler: ({ state, range, match }) => {
          state.tr.replaceWith(range.from, range.to, this.type.create({ name: match[1], service: variableService(match[1]!, this.options.source()) }));
        },
      }),
    ];
  },
});

/** Shift+Enter is a plain newline too: a prompt has no soft breaks. */
const ShiftEnter = Extension.create({
  name: "shiftEnter",
  addKeyboardShortcuts() {
    return { "Shift-Enter": () => this.editor.commands.splitBlock() };
  },
});

const skillNode = (skill: T3Skill): JSONContent => ({ type: "skill", attrs: { name: skill.name, label: skillLabel(skill), description: skill.description } });

/** Plain text with its `{{name}}` variables as chips. */
const textNodes = (text: string, source: VariableService | null): JSONContent[] =>
  splitVariables(text).map((part) =>
    typeof part === "string" ? { type: "text", text: part } : { type: "variable", attrs: { name: part.variable, service: variableService(part.variable, source) } },
  );

/** One paragraph per line, known `$name` tokens and `{{name}}` variables as chips. */
function toParagraphs(text: string, skills: readonly T3Skill[], source: VariableService | null): JSONContent[] {
  return text.split(/\r\n?|\n/).map((line) => ({
    type: "paragraph",
    content: splitSkills(line, skills).flatMap((part) => (typeof part === "string" ? textNodes(part, source) : [skillNode(part)])),
  }));
}

/** The prompt as text: lines joined by newlines, chips as `$name` and `{{name}}`. */
const serialize = (editor: Editor) => editor.getText({ blockSeparator: "\n" });

/** Inserts text at the caret: inline when it is one line, else as paragraphs that split the current one. */
function insertText(editor: Editor, text: string, skills: readonly T3Skill[], source: VariableService | null) {
  const paragraphs = toParagraphs(text, skills, source);
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

/** Points the shared variables' chips at a new source, in place: the caret stays and undo skips the change. */
function retagVariables(editor: Editor, source: VariableService | null) {
  const { tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "variable") return;
    const service = variableService(node.attrs.name, source);
    if (service !== node.attrs.service) tr.setNodeMarkup(pos, undefined, { ...node.attrs, service });
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true));
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
 * The prompt editor, after T3 Code's composer: plain text where a skill or a
 * `{{name}}` template variable is a chip. `/` at the start of a line or `$`
 * anywhere opens a skill menu (arrows move, Enter or Tab picks, Escape
 * closes); a pick inserts `$name`. With `skills` off there is no skill menu,
 * for messages no agent reads.
 */
export function PromptEditor({
  value,
  onChange,
  placeholder,
  className,
  readOnly = false,
  skills: skillsEnabled = true,
  source = null,
  ref,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Extra classes for the box, typically a min height and font. */
  className?: string;
  readOnly?: boolean;
  skills?: boolean;
  /** The one service the prompt runs for, whose logo shared variables show (see `eventsService`). */
  source?: VariableService | null;
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
  const latest = useRef({ onChange, skills, source, items, active, open, trigger, editor: null as Editor | null });

  const pick = (skill: T3Skill) => {
    const { trigger: current, editor } = latest.current;
    if (!editor || !current) return;
    // Swallow a space already after the token so the pick leaves exactly one.
    const to = editor.state.doc.textBetween(current.to, Math.min(current.to + 1, editor.state.doc.content.size - 1)) === " " ? current.to + 1 : current.to;
    editor.chain().focus().insertContentAt({ from: current.from, to }, [skillNode(skill), { type: "text", text: " " }]).run();
  };

  const editor = useEditor({
    extensions: [Document, Paragraph, Text, UndoRedo, ShiftEnter, SkillChip, VariableChip.configure({ source: () => latest.current.source }), Placeholder.configure({ placeholder: placeholder ?? "" })],
    content: { type: "doc", content: toParagraphs(value, skills, source) },
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
        const { editor, skills, source } = latest.current;
        if (!text || !editor) return false;
        insertText(editor, text, skills, source);
        return true;
      },
    },
    onUpdate: ({ editor }) => latest.current.onChange(serialize(editor)),
    onTransaction: ({ editor }) => setTrigger(readTrigger(editor)),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  });

  latest.current = { onChange, skills, source, items, active, open, trigger, editor };

  useImperativeHandle(ref, () => ({ insert: (text) => editor && insertText(editor, text, latest.current.skills, latest.current.source) }), [editor]);

  // Follow outside changes (reset, version switch), and chip `$name`s in place once the skills load.
  const renderedSkills = useRef(skills);
  useEffect(() => {
    if (!editor) return;
    if (serialize(editor) !== value) editor.commands.setContent({ type: "doc", content: toParagraphs(value, skills, source) }, { emitUpdate: false });
    else if (renderedSkills.current !== skills) chipSkills(editor, skills);
    renderedSkills.current = skills;
  }, [editor, value, skills]);

  // A rule switching source re-logos its shared variables.
  useEffect(() => {
    if (editor) retagVariables(editor, source);
  }, [editor, source]);

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
