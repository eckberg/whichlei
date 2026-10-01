// What a key press means on the search page, as a pure function so it is tested without a
// browser. The page (main.ts) gathers the facts, acts on the answer, and calls
// preventDefault when there is one.
import type { View } from "./view.ts";

export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

export interface KeyContext {
  view: View;
  /** The search field has focus. */
  inInput: boolean;
  /** A button or link has focus: enter and space belong to it. */
  onControl: boolean;
  /** The caret is at the end of the field's text. */
  caretAtEnd: boolean;
  /** Some text is selected, so copy means copy that. */
  textSelected: boolean;
  queryEmpty: boolean;
  hasResults: boolean;
}

export type KeyAction =
  /** Move focus to the field and select its text. */
  | { type: "focus" }
  /** Send this key to the field, which gets the focus first. */
  | { type: "type" }
  | { type: "about" }
  | { type: "back" }
  | { type: "move"; by: number }
  | { type: "copy" }
  | { type: "open" }
  | { type: "clear" };

/** The action for a key, or null to leave the key alone. */
export function keyAction(press: KeyPress, ctx: KeyContext): KeyAction | null {
  const { key } = press;
  const plain = key.length === 1 && !press.ctrlKey && !press.metaKey && !press.altKey;
  const copyCombo = (press.metaKey || press.ctrlKey) && (key === "c" || key === "C");

  if (ctx.view === "about") {
    if (key === "Escape" || (plain && !ctx.inInput && key === "q")) return { type: "back" };
    if (plain && !ctx.inInput) return { type: "type" };
    return null;
  }

  if (!ctx.inInput) {
    if (key === "/" && plain) return { type: "focus" };
    if (key === "?" && ctx.queryEmpty) return { type: "about" };
    if (plain) return { type: "type" };
  }
  if (key === "?" && ctx.queryEmpty) return { type: "about" };
  if (key === "ArrowDown" || (press.ctrlKey && (key === "n" || key === "j"))) {
    return { type: "move", by: 1 };
  }
  if (key === "ArrowUp" || (press.ctrlKey && (key === "p" || key === "k"))) {
    return { type: "move", by: -1 };
  }
  if (key === "PageDown") return { type: "move", by: 10 };
  if (key === "PageUp") return { type: "move", by: -10 };
  if (key === "Enter") return ctx.onControl || !ctx.hasResults ? null : { type: "copy" };
  if (key === "ArrowRight") {
    return (!ctx.inInput || ctx.caretAtEnd) && ctx.hasResults ? { type: "open" } : null;
  }
  if (key === "Escape") return ctx.queryEmpty ? null : { type: "clear" };
  if (copyCombo && !ctx.textSelected && ctx.hasResults) return { type: "copy" };
  return null;
}
