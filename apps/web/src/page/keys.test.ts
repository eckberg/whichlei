import { describe, expect, it } from "vitest";
import { type KeyContext, type KeyPress, keyAction } from "./keys.ts";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

const inField: KeyContext = {
  view: "search",
  inInput: true,
  onControl: false,
  caretAtEnd: true,
  textSelected: false,
  queryEmpty: false,
  hasResults: true,
};
const outside: KeyContext = { ...inField, inInput: false, caretAtEnd: false };

describe("keyAction, search", () => {
  it("moves the selection with the arrows, page keys and emacs keys", () => {
    expect(keyAction(press("ArrowDown"), inField)).toEqual({ type: "move", by: 1 });
    expect(keyAction(press("ArrowUp"), inField)).toEqual({ type: "move", by: -1 });
    expect(keyAction(press("PageDown"), inField)).toEqual({ type: "move", by: 10 });
    expect(keyAction(press("PageUp"), inField)).toEqual({ type: "move", by: -10 });
    expect(keyAction(press("n", { ctrlKey: true }), inField)).toEqual({ type: "move", by: 1 });
    expect(keyAction(press("p", { ctrlKey: true }), inField)).toEqual({ type: "move", by: -1 });
  });

  it("copies on enter, and leaves enter to a focused button", () => {
    expect(keyAction(press("Enter"), inField)).toEqual({ type: "copy" });
    expect(keyAction(press("Enter"), { ...outside, onControl: true })).toBeNull();
    expect(keyAction(press("Enter"), { ...inField, hasResults: false })).toBeNull();
  });

  it("copies on ctrl-c or cmd-c only when no text is selected", () => {
    expect(keyAction(press("c", { ctrlKey: true }), inField)).toEqual({ type: "copy" });
    expect(keyAction(press("c", { metaKey: true }), inField)).toEqual({ type: "copy" });
    expect(keyAction(press("c", { ctrlKey: true }), { ...inField, textSelected: true })).toBeNull();
  });

  it("opens the record on the right arrow, unless the caret still has text to pass", () => {
    expect(keyAction(press("ArrowRight"), inField)).toEqual({ type: "open" });
    expect(keyAction(press("ArrowRight"), { ...inField, caretAtEnd: false })).toBeNull();
    expect(keyAction(press("ArrowRight"), { ...inField, hasResults: false })).toBeNull();
  });

  it("clears on escape when there is text", () => {
    expect(keyAction(press("Escape"), inField)).toEqual({ type: "clear" });
    expect(keyAction(press("Escape"), { ...inField, queryEmpty: true })).toBeNull();
  });

  it("shows about on a question mark only when the box is empty", () => {
    expect(keyAction(press("?"), { ...inField, queryEmpty: true })).toEqual({ type: "about" });
    expect(keyAction(press("?"), { ...outside, queryEmpty: true })).toEqual({ type: "about" });
    expect(keyAction(press("?"), inField)).toBeNull();
    expect(keyAction(press("?"), outside)).toEqual({ type: "type" });
  });

  it("focuses the box on a slash, and sends other letters to it", () => {
    expect(keyAction(press("/"), outside)).toEqual({ type: "focus" });
    expect(keyAction(press("e"), outside)).toEqual({ type: "type" });
    expect(keyAction(press("/"), inField)).toBeNull();
    expect(keyAction(press("e"), inField)).toBeNull();
  });
});

describe("keyAction, about", () => {
  const about: KeyContext = { ...outside, view: "about" };

  it("goes back on escape or q", () => {
    expect(keyAction(press("Escape"), about)).toEqual({ type: "back" });
    expect(keyAction(press("q"), about)).toEqual({ type: "back" });
    expect(keyAction(press("Escape"), { ...about, inInput: true })).toEqual({ type: "back" });
  });

  it("sends other letters to the box", () => {
    expect(keyAction(press("x"), about)).toEqual({ type: "type" });
    expect(keyAction(press("q"), { ...about, inInput: true })).toBeNull();
    expect(keyAction(press("ArrowDown"), about)).toBeNull();
  });
});
