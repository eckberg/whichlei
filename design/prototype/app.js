(function () {
  "use strict";
  var D = window.WL_DATA, R = window.WL_RANK, recs = D.records;
  var byLei = new Map(recs.map(function (r, i) { return [r.l, i]; }));
  var $ = function (s) { return document.querySelector(s); };
  var q = $("#q"), info = $("#info"), list = $("#list"), preview = $("#preview"),
      main = $("#main"), keys = $("#keys"), meta = $("#meta");
  var touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  var state = { query: "", results: [], cls: { kind: "empty" }, sel: 0, view: "search", rec: -1, flash: null };

  var ISO2 = new Set(("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XS YE YT ZA ZM ZW").split(" "));

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) { return Number(n).toLocaleString("en-US"); }

  // ISO 17442 check digits: ISO 7064 mod 97-10 over the 20 characters.
  function leiOk(s) { var acc = 0; for (var k = 0; k < s.length; k++) { var c = s.charCodeAt(k), v = c < 58 ? c - 48 : c - 55; acc = v < 10 ? (acc * 10 + v) % 97 : (acc * 100 + v) % 97; } return acc === 1; }
  // ISO 6166 check digit: letters to numbers, then Luhn.
  function isinOk(s) { var d = ""; for (var k = 0; k < s.length; k++) { var c = s.charCodeAt(k); d += c < 58 ? s[k] : String(c - 55); } var sum = 0; for (var i = d.length - 1, n = 0; i >= 0; i--, n++) { var x = +d[i]; if (n % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; } return sum % 10 === 0; }

  function classify(raw) {
    var s = raw.trim(); if (!s) return { kind: "empty" };
    var up = s.toUpperCase().replace(/\s+/g, "");
    if (/^[A-Z0-9]{18}[0-9]{2}$/.test(up)) return { kind: "lei", code: up, ok: leiOk(up) };
    if (/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(up) && ISO2.has(up.slice(0, 2))) return { kind: "isin", code: up, ok: isinOk(up) };
    if ((up.length === 8 || up.length === 11) && /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(up) && ISO2.has(up.slice(4, 6))) return { kind: "bic", code: up };
    if (/^[0-9][0-9 .\/-]{4,}$/.test(s)) { var dg = up.replace(/[^0-9]/g, ""); if (dg.length >= 6) return { kind: "regno", code: dg }; }
    if (/^[A-Z0-9]{6,19}$/.test(up) && (up.match(/[0-9]/g) || []).length >= 3) return { kind: "partial", n: up.length };
    return { kind: "name" };
  }

  function codeHits(c) {
    var out = [];
    recs.forEach(function (r, i) {
      if (c.kind === "lei" && c.ok && r.l === c.code) out.push(i);
      else if (c.kind === "isin" && c.ok && r.ix && r.ix.indexOf(c.code) >= 0) out.push(i);
      else if (c.kind === "bic" && r.b && r.b.some(function (b) { return b === c.code || (b.slice(0, 8) === c.code.slice(0, 8) && (c.code.length === 8 || b.length === 8)); })) out.push(i);
      else if (c.kind === "regno" && r.r && r.r.replace(/[^0-9]/g, "") === c.code) out.push(i);
    });
    return out;
  }

  function search(raw) {
    var c = classify(raw);
    if (c.kind === "empty") return { cls: c, results: [] };
    var hits = codeHits(c).map(function (i) { return { i: i, code: true }; });
    var runNames = !((c.kind === "lei") || (c.kind === "isin" && c.ok));
    if (runNames) {
      var seen = new Set(hits.map(function (h) { return h.i; }));
      R.rank(raw, recs, 60).forEach(function (h) { if (!seen.has(h.i)) hits.push({ i: h.i, matched: h.matched }); });
    }
    c.codeCount = hits.filter(function (h) { return h.code; }).length;
    return { cls: c, results: hits };
  }

  function statusOf(r) {
    if (r.s && r.s !== "ACTIVE") return ["inactive", "retired"];
    if (r.g === "LAPSED") return ["lapsed", "lapsed"];
    if (!r.g || r.g === "ISSUED" || r.g === "PENDING_TRANSFER" || r.g === "PENDING_ARCHIVAL") return ["active", "active"];
    return [r.g.toLowerCase().replace(/_/g, " "), "retired"];
  }

  function names(r) { return [r.n].concat(r.o || []); }
  function mark(str, ranges) {
    if (!ranges || !ranges.length) return esc(str);
    var out = "", at = 0;
    ranges.slice().sort(function (a, b) { return a[0] - b[0]; }).forEach(function (g) {
      if (g[0] < at) return; out += esc(str.slice(at, g[0])) + "<mark>" + esc(str.slice(g[0], g[1])) + "</mark>"; at = g[1];
    });
    return out + esc(str.slice(at));
  }
  function nameHTML(r, matched) {
    var legal = null, alt = null;
    (matched || []).forEach(function (m) { if (m[0] === 0) legal = m[1]; else if (!alt) alt = m; });
    var h = mark(r.n, legal);
    if (!legal && alt) h += ' <span class="aka">(' + mark(names(r)[alt[0]], alt[1]) + ")</span>";
    return h;
  }

  // ---------- rendering ----------
  function setKeys(items) {
    keys.innerHTML = items.map(function (k) { return "<li><kbd>" + esc(k[0]) + "</kbd>" + esc(k[1]) + "</li>"; }).join("");
  }
  function renderInfo() {
    var c = state.cls, n = state.results.length, h = "";
    if (state.flash) { info.innerHTML = '<span class="' + state.flash[1] + '">' + esc(state.flash[0]) + "</span>"; return; }
    var count = n === 1 ? "1 match" : fmt(n) + " matches";
    if (c.kind === "empty") h = "";
    else if (c.kind === "lei" && !c.ok) h = '<span class="bad">not a valid lei: the check digits don’t match (iso 7064 mod 97-10)</span>';
    else if (c.kind === "lei") h = n ? count + " · lei · <span class=\"ok\">check digits ok</span>" : 'lei · <span class="ok">check digits ok</span> · <span class="warn">not in the sample data</span>';
    else if (c.kind === "isin" && !c.ok) h = '<span class="bad">not a valid isin: the check digit doesn’t match</span>';
    else if (c.kind === "isin") h = n ? count + " · isin · issuer" : 'isin · <span class="ok">check digit ok</span> · <span class="warn">issuer not in the sample data</span>';
    else if (c.kind === "bic") h = c.codeCount ? count + " · bic" : (n ? count : "no matches");
    else if (c.kind === "regno") h = c.codeCount ? count + " · register number" : (n ? count : "no register number match in the sample data");
    else if (c.kind === "partial" && !n) h = "looks like an lei · " + c.n + "/20 characters";
    else h = n ? count : "no matches";
    info.innerHTML = h;
  }
  function renderList() {
    var rs = state.results;
    list.innerHTML = rs.map(function (h, k) {
      var r = recs[h.i], st = statusOf(r), selected = k === state.sel;
      return '<div class="row" role="option" id="opt-' + k + '" data-k="' + k + '" aria-selected="' + selected + '">' +
        '<span class="ptr" aria-hidden="true">' + (selected ? "&gt;" : "") + "</span>" +
        '<span class="lei">' + r.l + "</span>" +
        '<span class="nm">' + nameHTML(r, h.matched) + "</span>" +
        '<span class="cc">' + esc(r.c || "") + "</span>" +
        '<span class="st st-' + st[1] + '">' + st[0] + "</span></div>";
    }).join("");
    q.setAttribute("aria-activedescendant", rs.length ? "opt-" + state.sel : "");
    var el = document.getElementById("opt-" + state.sel);
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function kv(pairs) {
    return '<dl class="kv">' + pairs.filter(Boolean).map(function (p) { return "<dt>" + p[0] + "</dt><dd>" + p[1] + "</dd>"; }).join("") + "</dl>";
  }
  function recLink(pair) {
    if (!pair) return '<span class="none">none reported</span>';
    return byLei.has(pair[0]) ? '<a href="#' + pair[0] + '">' + esc(pair[1] || pair[0]) + "</a>" : esc(pair[1] || pair[0]);
  }
  function fields(r, full) {
    var st = statusOf(r), raName = r.ra && D.ra ? D.ra[r.ra] : "";
    var addr = [r.a, [r.z, r.t].filter(Boolean).join(" "), r.c].filter(Boolean).map(esc).join(", ");
    var isin = r.is ? r.is + (r.ix && r.ix.length ? " · " + r.ix.join(" ") + (r.is > r.ix.length ? " …" : "") : "") : "";
    return [
      ["name", esc(r.n)],
      r.o && r.o.length ? ["also", esc(r.o.join(" · "))] : null,
      ["status", '<span class="st-' + st[1] + '">' + st[0] + "</span>" + (r.u ? " · renews " + r.u : "")],
      addr ? ["address", addr] : null,
      r.r ? ["register", esc(r.r)] : null,
      full && r.ra ? ["registry", esc(raName || r.ra) + (raName ? ' <span class="none">' + esc(r.ra) + "</span>" : "")] : null,
      r.f ? ["legal form", esc(r.f)] : null,
      r.b && r.b.length ? ["bic", r.b.join(" ")] : null,
      isin ? ["isin", isin] : null,
      ["parent", recLink(r.pa)],
      r.up ? ["ultimate", recLink(r.up)] : null,
      ["children", r.ch ? fmt(r.ch) : '<span class="none">none reported</span>'],
      full && r.k ? ["category", esc(r.k.toLowerCase())] : null,
      r.i ? ["since", r.i] : null,
      full && r.lu ? ["updated", r.lu] : null,
      full && r.m ? ["managed by", r.m] : null
    ];
  }
  function renderPreview() {
    var h = state.results[state.sel];
    if (!h) { preview.innerHTML = ""; return; }
    var r = recs[h.i];
    preview.innerHTML = '<div class="pane"><span class="label">' + r.l + "</span>" + kv(fields(r, false)) +
      '<div class="actions"><button class="btn" type="button" data-act="copy">copy lei</button>' +
      '<button class="btn" type="button" data-act="open">full record</button></div></div>';
  }
  function usageHTML() {
    var ex = [["ericsson", "name"], ["h&m", "brand name"], ["HWUPKR0MPOU8FGXBT394", "lei"], ["US0378331005", "isin"],
              ["TEERSESSXXX", "bic"], ["556016-0680", "swedish register number"], ["HWUPKR0MPOU8FGXBT395", "lei with a typo"]];
    return '<div class="doc"><p style="margin-left:0">type a name, an lei, an isin, a bic or a national register number.</p>' +
      "<h2>examples</h2><div class=\"examples\">" + ex.map(function (e) {
        return '<button type="button" data-q="' + esc(e[0]) + '">' + esc(e[0]) + "</button><span>" + e[1] + "</span>";
      }).join("") + "</div></div>";
  }
  function aboutHTML() {
    return '<div class="doc" id="man">' +
      '<div class="man-head"><span>WHICHLEI(1)</span><span>User Commands</span><span>WHICHLEI(1)</span></div>' +
      "<h2>NAME</h2><p>whichlei – find the Legal Entity Identifier of a company, fund or public body</p>" +
      "<h2>SYNOPSIS</h2><p>type a name, an LEI, an ISIN, a BIC or a national register number</p>" +
      "<h2>DESCRIPTION</h2><p>Results appear as you type, best match first. Press enter to copy its LEI.</p>" +
      "<p>An LEI is a 20-character code defined by ISO 17442. Its last two characters are check digits (ISO 7064 mod 97-10), so a mistyped LEI is caught in your browser before anything is looked up.</p>" +
      '<h2>KEYS</h2><dl class="keys">' +
      [["↑ ↓", "move the selection"], ["enter", "copy the selected LEI"], ["→", "open the full record"],
       ["esc", "clear the search, or go back"], ["/", "jump to the search field"], ["?", "this page, when the search is empty"], ["q", "leave this page"]]
        .map(function (k) { return "<dt>" + k[0] + "</dt><dd>" + k[1] + "</dd>"; }).join("") + "</dl>" +
      "<h2>DATA</h2><p>Every record comes from GLEIF, the Global Legal Entity Identifier Foundation. The search index is rebuilt daily from GLEIF’s golden copy, published under CC0. An opened record is fetched live from the GLEIF API.</p>" +
      "<p>This prototype runs on a fixed sample of " + fmt(recs.length) + " real records from the " + D.asof + " golden copy.</p>" +
      "<h2>PRIVACY</h2><p>No account and no cookies. Search runs in your browser. Analytics are cookieless and aggregate, and never see what you type.</p>" +
      '<h2>SEE ALSO</h2><p><a href="https://www.gleif.org" target="_blank" rel="noopener">gleif.org</a>, <a href="https://search.gleif.org" target="_blank" rel="noopener">search.gleif.org</a></p>' +
      '<div class="man-head" style="margin-top:18px"><span>whichlei</span><span>' + D.asof + "</span><span>WHICHLEI(1)</span></div></div>";
  }
  function recordHTML(r) {
    var tree = "";
    if (r.cx && r.cx.length) {
      var more = (r.ch || 0) - r.cx.length;
      tree = '<dl class="kv"><dt></dt><dd><ul class="tree">' + r.cx.map(function (c, k) {
        var last = k === r.cx.length - 1 && more <= 0;
        return '<li><span class="g">' + (last ? "└─" : "├─") + "</span>" +
          (byLei.has(c[0]) ? '<a href="#' + c[0] + '">' + esc(c[1]) + "</a>" : "<span>" + esc(c[1]) + "</span>") +
          '<span class="c">' + esc(c[2] || "") + "</span></li>";
      }).join("") + (more > 0 ? '<li><span class="g">└─</span><span class="c">' + fmt(more) + " more at gleif.org</span><span></span></li>" : "") + "</ul></dd></dl>";
    }
    return '<div class="record"><div class="inner">' +
      "<div><h1>" + r.l + '</h1><div class="name">' + esc(r.n) + "</div></div>" +
      '<div class="actions" style="display:flex;flex-wrap:wrap;gap:1ch 2ch">' +
        '<button class="btn" type="button" data-act="back">back</button>' +
        '<button class="btn" type="button" data-act="copy">copy lei</button>' +
        '<button class="btn" type="button" data-act="json">copy json</button>' +
        '<a class="btn" href="https://search.gleif.org/#/record/' + r.l + '" target="_blank" rel="noopener">gleif.org</a></div>' +
      kv(fields(r, true)) + tree +
      '<p class="src">source: gleif golden copy ' + D.asof + " · permalink: whichlei.com/lei/" + r.l + "</p></div></div>";
  }

  var KEYS = {
    search: [["↑↓", "select"], ["⏎", "copy lei"], ["→", "full record"], ["esc", "clear"]],
    empty: [["/", "search"], ["?", "about"]],
    record: [["c", "copy lei"], ["j", "copy json"], ["←", "back"]],
    about: [["q", "quit"], ["esc", "back"]]
  };
  function render() {
    renderInfo();
    if (state.view === "about") {
      main.className = "single"; main.innerHTML = aboutHTML(); setKeys(KEYS.about); return;
    }
    if (state.view === "record") {
      main.className = "single"; main.innerHTML = recordHTML(recs[state.rec]); setKeys(KEYS.record); return;
    }
    if (!main.contains(list)) { main.innerHTML = ""; main.appendChild(list); main.appendChild(preview); }
    if (state.cls.kind === "empty") {
      main.className = "single"; list.innerHTML = usageHTML(); preview.innerHTML = ""; setKeys(KEYS.empty);
      q.setAttribute("aria-activedescendant", ""); return;
    }
    main.className = state.results.length ? "" : "single";
    renderList(); renderPreview(); setKeys(KEYS.search);
  }

  // ---------- actions ----------
  var flashTimer = null;
  function flash(msg, cls) {
    state.flash = [msg, cls]; renderInfo(); clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { state.flash = null; renderInfo(); }, 2400);
  }
  function copy(text, label) {
    function fallback() {
      var t = document.createElement("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
      document.body.removeChild(t); flash(ok ? "copied " + label : "copying is blocked here – select the text and copy it", ok ? "copied" : "warn");
    }
    try { navigator.clipboard.writeText(text).then(function () { flash("copied " + label, "copied"); }, fallback); } catch (e) { fallback(); }
  }
  function current() { return state.view === "record" ? recs[state.rec] : (state.results[state.sel] ? recs[state.results[state.sel].i] : null); }
  function copyLei() { var r = current(); if (r) copy(r.l, r.l); }
  function copyJson() {
    var r = current(); if (!r) return;
    copy(JSON.stringify({ lei: r.l, legalName: r.n, country: r.c, status: statusOf(r)[0], registeredAs: r.r || null, nextRenewal: r.u || null }, null, 2), "json for " + r.l);
  }
  function move(d) {
    if (!state.results.length) return;
    state.sel = Math.max(0, Math.min(state.results.length - 1, state.sel + d)); renderList(); renderPreview();
  }
  function setQuery(v) {
    state.query = v; var s = search(v); state.results = s.results; state.cls = s.cls; state.sel = 0; state.flash = null;
    if (state.view !== "search") { state.view = "search"; if (location.hash) history.replaceState(null, "", location.pathname + location.search); }
    render();
  }
  var pushed = 0; // entries this page added, so "back" never leaves the page
  function openRecord(i) { pushed++; location.hash = recs[i].l; }
  function back() { if (pushed > 0) { pushed--; history.back(); } else if (location.hash) { location.hash = ""; } }
  function route() {
    var h = location.hash.slice(1);
    if (h === "about") { state.view = "about"; }
    else if (byLei.has(h)) { state.view = "record"; state.rec = byLei.get(h); }
    else { state.view = "search"; }
    render();
    if (state.view === "search" && !touch) q.focus();
    else if (state.view !== "search") { q.blur(); main.scrollTop = 0; }
  }

  // ---------- events ----------
  q.addEventListener("input", function () { setQuery(q.value); });
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-act],[data-q],.row,#about-btn,#home");
    if (!t) return;
    if (t.id === "about-btn") { if (state.view === "about") back(); else { pushed++; location.hash = "about"; } return; }
    if (t.id === "home") { e.preventDefault(); if (location.hash) location.hash = ""; q.value = ""; setQuery(""); q.focus(); return; }
    if (t.dataset.q != null) { q.value = t.dataset.q; setQuery(t.dataset.q); q.focus(); return; }
    if (t.classList.contains("row")) {
      var k = +t.dataset.k;
      if (touch || e.detail > 1 || state.sel === k) { openRecord(state.results[k].i); return; }
      state.sel = k; renderList(); renderPreview(); q.focus(); return;
    }
    var a = t.dataset.act;
    if (a === "copy") copyLei(); else if (a === "json") copyJson(); else if (a === "back") back();
    else if (a === "open" && state.results[state.sel]) openRecord(state.results[state.sel].i);
  });
  document.addEventListener("keydown", function (e) {
    var inInput = document.activeElement === q, plain = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    var copyCombo = (e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C");
    var textSelected = inInput ? q.selectionStart !== q.selectionEnd : String(window.getSelection() || "").length > 0;
    if (state.view === "record") {
      if (e.key === "Escape" || e.key === "ArrowLeft" || (e.key === "Backspace" && !inInput)) { e.preventDefault(); back(); return; }
      if (plain && !inInput && e.key === "c") { e.preventDefault(); copyLei(); return; }
      if (plain && !inInput && e.key === "j") { e.preventDefault(); copyJson(); return; }
      if (copyCombo && !textSelected) { e.preventDefault(); copyLei(); return; }
      if (plain && !inInput) { q.focus(); }
      return;
    }
    if (state.view === "about") {
      if (e.key === "Escape" || (plain && !inInput && e.key === "q")) { e.preventDefault(); back(); return; }
      if (plain && !inInput) { q.focus(); }
      return;
    }
    if (!inInput) {
      if (e.key === "/") { e.preventDefault(); q.focus(); q.select(); return; }
      if (e.key === "?" && !q.value.trim()) { e.preventDefault(); pushed++; location.hash = "about"; return; }
      if (plain) { q.focus(); return; }
    }
    if (e.key === "?" && !q.value.trim()) { e.preventDefault(); pushed++; location.hash = "about"; return; }
    if (e.key === "ArrowDown" || (e.ctrlKey && (e.key === "n" || e.key === "j"))) { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && (e.key === "p" || e.key === "k"))) { e.preventDefault(); move(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(10); }
    else if (e.key === "PageUp") { e.preventDefault(); move(-10); }
    else if (e.key === "Enter") { e.preventDefault(); copyLei(); }
    else if (e.key === "ArrowRight" && (!inInput || q.selectionStart === q.value.length)) {
      if (state.results.length) { e.preventDefault(); openRecord(state.results[state.sel].i); }
    }
    else if (e.key === "Escape") { e.preventDefault(); if (q.value) { q.value = ""; setQuery(""); } }
    else if (copyCombo && !textSelected && state.results.length) { e.preventDefault(); copyLei(); }
  });
  window.addEventListener("hashchange", route);

  meta.textContent = "sample: " + fmt(recs.length) + " of " + fmt(D.total) + " records · gleif " + D.asof;
  q.value = "ericsson"; setQuery(q.value);
  route();
  if (!touch && state.view === "search") q.select();
})();
