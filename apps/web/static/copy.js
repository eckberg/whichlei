// Progressive enhancement for record pages. Without this file the LEI is still selectable
// text. With it, the hidden "copy lei" button appears and works.
(() => {
  const status = document.querySelector("[data-copy-status]");
  let timer;

  const say = (text) => {
    if (!status) return;
    status.textContent = text;
    clearTimeout(timer);
    timer = setTimeout(() => {
      status.textContent = "";
    }, 2400);
  };

  // Clipboard API first. The fallback covers pages where it is blocked.
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(area);
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
  };

  // The record as JSON: the page carries it in a data block, and the button copies it with
  // line breaks and indentation. Null when the block is missing or is not JSON.
  const recordJson = (id) => {
    try {
      return JSON.stringify(JSON.parse(document.getElementById(id).textContent), null, 2);
    } catch {
      return null;
    }
  };

  for (const button of document.querySelectorAll("[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const text = button.getAttribute("data-copy");
      const ok = await copy(text);
      say(ok ? `copied ${text}` : "copying is blocked here: select the text and copy it");
    });
  }

  for (const button of document.querySelectorAll("[data-copy-json]")) {
    const text = recordJson(button.getAttribute("data-copy-json"));
    // No data to copy: the button stays hidden.
    if (text === null) continue;
    button.hidden = false;
    button.addEventListener("click", async () => {
      const ok = await copy(text);
      say(ok ? "copied json" : "copying is blocked here: select the text and copy it");
    });
  }
})();
