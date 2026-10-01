// The search page: wires the search state machine (../search) to the DOM and the keys. The
// markup is built in view.ts, the key meanings are in keys.ts; this file holds only what needs
// a browser: focus, history, the clipboard and the live region.
import { IndexClient } from "../search/client.ts";
import type { Hit } from "../search/entry.ts";
import { initialState, Search, type SearchPort, type SearchState } from "../search/search.ts";
import { type KeyContext, keyAction } from "./keys.ts";
import { RemoteSearch } from "./remote.ts";
import {
  aboutHtml,
  announcement,
  infoLine,
  keysHtml,
  metaText,
  previewHtml,
  recordHref,
  rowsHtml,
  usageHtml,
  type View,
} from "./view.ts";

const FLASH_MS = 2400;
const RELOADED = "whichlei:reloaded";
/** How long the results must hold still before a screen reader is told about them. */
const ANNOUNCE_MS = 600;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`#${id} is missing from the page`);
  return found as T;
}

/**
 * The search runs in a Web Worker, so typing never waits on scoring (DESIGN.md decision 20).
 * Where there is none, or no index is set up, the same `Search` runs on this thread.
 */
function createSearch(origin: string): SearchPort {
  if (origin !== "" && typeof Worker !== "undefined") {
    try {
      const worker = new Worker("/search-worker.js", { type: "module", name: "whichlei-search" });
      return new RemoteSearch(worker, origin, initialState(true));
    } catch {
      // Falls through to the same code on this thread.
    }
  }
  return new Search(origin === "" ? null : new IndexClient(origin));
}

export function start(): void {
  const q = element<HTMLInputElement>("q");
  const info = element("info");
  const status = element("status");
  const main = element("main");
  const list = element("list");
  const preview = element("preview");
  const doc = element("doc");
  const keys = element("keys");
  const meta = element("meta");
  const touch = matchMedia("(hover: none) and (pointer: coarse)").matches;

  const origin = __INDEX_ORIGIN__;
  const search = createSearch(origin);

  let view: View = "search";
  let selected = 0;
  let flash: { text: string; tone: "ok" | "warn" } | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let announceTimer: ReturnType<typeof setTimeout> | undefined;
  let spoken = "";
  /** What the list and preview were last built from. */
  let shown: { hits: SearchState["hits"]; tokens: SearchState["tokens"] } | null = null;
  let shownDoc = "";
  /** When the last change of the box happened, for the keystroke-to-results measure. */
  let inputAt = 0;
  /** Entries this page added to the history, so "back" never leaves the page. */
  let pushed = 0;

  const state = (): SearchState => search.state;
  const hit = (): Hit | undefined => state().hits[selected];
  const searching = () => state().phase !== "empty" && state().phase !== "unconfigured";

  // ---- Rendering ---------------------------------------------------------------------

  function say(text: string) {
    // Emptied first, or a screen reader ignores the same sentence said twice.
    status.textContent = "";
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      status.textContent = text;
    }, 50);
  }

  function renderInfo() {
    if (flash) {
      info.innerHTML = "";
      const span = document.createElement("span");
      span.className = flash.tone === "ok" ? "copied" : "warn";
      span.textContent = flash.text;
      info.append(span);
      return;
    }
    info.innerHTML = infoLine(state()).html.value;
  }

  function setSelected(next: number) {
    const rows = list.children;
    const before = rows[selected];
    const after = rows[next];
    selected = next;
    if (before && before !== after) {
      before.setAttribute("aria-selected", "false");
      (before.firstElementChild as HTMLElement).textContent = "";
    }
    if (after) {
      after.setAttribute("aria-selected", "true");
      (after.firstElementChild as HTMLElement).textContent = ">";
      after.scrollIntoView({ block: "nearest" });
    }
    q.setAttribute("aria-activedescendant", after ? `opt-${next}` : "");
    preview.innerHTML = previewHtml(hit());
  }

  function render() {
    const start = performance.now();
    const s = state();
    renderInfo();
    meta.textContent = metaText(s.index);
    document.body.dataset.phase = s.phase;
    if (view === "about") {
      list.hidden = true;
      preview.hidden = true;
      main.className = "single";
      // The page names the index, which may arrive after it is first shown.
      showDoc(`about ${s.index?.asOf ?? ""}`, aboutHtml(s.index));
      keys.innerHTML = keysHtml("about", false);
      q.setAttribute("aria-expanded", "false");
    } else {
      const has = s.hits.length > 0;
      if (shown?.hits !== s.hits || shown?.tokens !== s.tokens) {
        shown = { hits: s.hits, tokens: s.tokens };
        selected = 0;
        list.innerHTML = rowsHtml(s.hits, s.tokens, 0);
        list.scrollTop = 0;
        preview.innerHTML = previewHtml(hit());
      }
      list.hidden = !has;
      preview.hidden = !has;
      main.className = has ? "" : "single";
      const usage = s.phase === "empty" || s.phase === "unconfigured";
      showDoc(usage ? "usage" : "", usage ? usageHtml() : "");
      keys.innerHTML = keysHtml("search", searching());
      q.setAttribute("aria-expanded", String(has));
      q.setAttribute("aria-activedescendant", has ? `opt-${selected}` : "");
    }
    scheduleAnnounce();
    // Reading a layout property forces style and layout, so the timing includes them.
    void main.offsetHeight;
    const end = performance.now();
    performance.measure("whichlei:render", {
      start,
      end,
      detail: { phase: s.phase, hits: s.hits.length },
    });
    performance.clearMeasures("whichlei:render");
    if (view === "search" && s.phase !== "loading" && s.text !== "" && s.text === q.value) {
      measureResults(inputAt, s);
    }
  }

  /** From the key press to the next frame after its results were drawn (user timing). */
  function measureResults(from: number, s: SearchState) {
    requestAnimationFrame(() => {
      // After the frame: the work of the frame is done by the time this task runs.
      setTimeout(() => {
        performance.measure("whichlei:results", {
          start: from,
          end: performance.now(),
          detail: { text: s.text, phase: s.phase, hits: s.hits.length },
        });
        performance.clearMeasures("whichlei:results");
      }, 0);
    });
  }

  function showDoc(name: string, markup: string) {
    if (shownDoc === name) return;
    shownDoc = name;
    doc.innerHTML = markup;
    doc.hidden = markup === "";
    // The about page scrolls; a keyboard user can tab to it and scroll with the arrows.
    if (name.startsWith("about")) doc.tabIndex = 0;
    else doc.removeAttribute("tabindex");
  }

  function scheduleAnnounce() {
    if (flash) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      const text = view === "about" ? "about whichlei" : announcement(state());
      if (text === null || text === spoken) return;
      spoken = text;
      say(text);
    }, ANNOUNCE_MS);
  }

  // ---- Actions -----------------------------------------------------------------------

  function showFlash(text: string, tone: "ok" | "warn") {
    flash = { text, tone };
    renderInfo();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flash = null;
      renderInfo();
    }, FLASH_MS);
    spoken = "";
    say(text);
  }

  function copyFallback(text: string): boolean {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "sr-only";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  async function copy(text: string) {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = copyFallback(text);
    }
    if (ok) showFlash(`copied ${text}`, "ok");
    else showFlash("copying is blocked here – select the text and copy it", "warn");
    // The fallback steals the focus; the field gets it back.
    if (view === "search" && !touch) q.focus();
  }

  const copyLei = () => {
    const current = hit();
    if (current) void copy(current.entry.lei);
  };

  function openRecord() {
    const current = hit();
    if (current) location.assign(recordHref(current.entry.lei));
  }

  function move(by: number) {
    const n = state().hits.length;
    if (n === 0) return;
    setSelected(Math.max(0, Math.min(n - 1, selected + by)));
  }

  function setQuery(text: string, at: number = performance.now()) {
    inputAt = at;
    flash = null;
    if (view !== "search" && location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
      view = "search";
    }
    // The answer, now or when the files arrive, comes through the subscription.
    void search.input(text);
  }

  function showAbout() {
    pushed++;
    location.hash = "about";
  }

  function back() {
    if (pushed > 0) {
      pushed--;
      history.back();
    } else if (location.hash) {
      location.hash = "";
    }
  }

  function route() {
    view = location.hash === "#about" ? "about" : "search";
    render();
    if (view === "search" && !touch) q.focus();
    else if (view === "about") {
      q.blur();
      doc.scrollTop = 0;
    }
  }

  // ---- Events ------------------------------------------------------------------------

  search.subscribe(render);
  // A page that cannot read the index's format is out of date: reload it once by itself,
  // then leave the message and its button. The mark is cleared when the index loads.
  search.subscribe((s) => {
    try {
      if (s.index) sessionStorage.removeItem(RELOADED);
      else if (s.phase === "error" && s.reload && !sessionStorage.getItem(RELOADED)) {
        sessionStorage.setItem(RELOADED, "1");
        location.reload();
      }
    } catch {
      // No storage, no automatic reload: the button is still there.
    }
  });

  q.addEventListener("input", (event) => setQuery(q.value, event.timeStamp));

  document.addEventListener("click", (event) => {
    const target = (event.target as Element).closest<HTMLElement>(
      "[data-act],[data-q],.row,#about-btn,#home",
    );
    if (!target) return;
    if (target.id === "about-btn") {
      if (view === "about") back();
      else showAbout();
      return;
    }
    if (target.id === "home") {
      event.preventDefault();
      if (location.hash) location.hash = "";
      q.value = "";
      setQuery("");
      q.focus();
      return;
    }
    if (target.dataset.q !== undefined) {
      q.value = target.dataset.q;
      setQuery(q.value);
      q.focus();
      return;
    }
    if (target.classList.contains("row")) {
      const k = Number(target.dataset.k);
      // A tap opens the record where there is no preview; a second click opens it elsewhere.
      if (touch || event.detail > 1 || selected === k) {
        selected = k;
        openRecord();
        return;
      }
      setSelected(k);
      q.focus();
      return;
    }
    if (target.dataset.act === "copy") copyLei();
    else if (target.dataset.act === "reload") location.reload();
    else if (target.dataset.act === "retry") {
      void search.retry();
      q.focus();
    }
    // "open" is a link: the browser follows it.
  });

  document.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const inInput = document.activeElement === q;
    const active = document.activeElement;
    const context: KeyContext = {
      view,
      inInput,
      onControl: active instanceof HTMLButtonElement || active instanceof HTMLAnchorElement,
      caretAtEnd: q.selectionStart === q.value.length && q.selectionEnd === q.value.length,
      textSelected: inInput
        ? q.selectionStart !== q.selectionEnd
        : (getSelection()?.toString().length ?? 0) > 0,
      queryEmpty: q.value.trim() === "",
      hasResults: state().hits.length > 0,
    };
    const action = keyAction(event, context);
    if (!action) return;
    switch (action.type) {
      case "type":
        // No preventDefault: the key then lands in the field.
        q.focus();
        return;
      case "focus":
        event.preventDefault();
        q.focus();
        q.select();
        return;
      case "about":
        event.preventDefault();
        showAbout();
        return;
      case "back":
        event.preventDefault();
        back();
        return;
      case "move":
        event.preventDefault();
        move(action.by);
        return;
      case "copy":
        event.preventDefault();
        copyLei();
        return;
      case "open":
        event.preventDefault();
        openRecord();
        return;
      case "clear":
        event.preventDefault();
        q.value = "";
        setQuery("");
        return;
    }
  });

  addEventListener("hashchange", route);

  route();
  void search.load();
}
