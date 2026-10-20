// Gridkeeper agent browser: helpers evaluated in an ISOLATED WORLD of the agent's tab (they share the
// DOM with the page but not its globals, so page scripts can neither see nor tamper with them).
// Defines globalThis.__gk once per document; `refs` maps snapshot refs (e1, e2, ...) to elements and
// is replaced by every snapshot.
(() => {
  if (globalThis.__gk) return;
  const MAX_TEXT = 200;
  const MAX_ELEMENTS = 20000;
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "gridcell",
  ]);
  const STRUCT_ROLES = new Set([
    "navigation", "main", "banner", "contentinfo", "form", "dialog", "alertdialog", "list", "table", "region",
    "complementary", "search", "menu", "menubar", "tablist", "tree", "grid", "toolbar", "group", "radiogroup",
    "listbox", "alert", "status", "tabpanel", "article",
  ]);
  const TEXT_ROLES = new Set(["listitem", "row", "cell", "columnheader", "rowheader", "paragraph"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE"]);
  const ROLE_BY_TAG = {
    BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button",
    H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
    IMG: "img", NAV: "navigation", MAIN: "main", HEADER: "banner", FOOTER: "contentinfo", FORM: "form",
    TABLE: "table", TR: "row", TD: "cell", TH: "columnheader", UL: "list", OL: "list", LI: "listitem",
    DIALOG: "dialog", P: "paragraph", ASIDE: "complementary", ARTICLE: "article", SECTION: null,
  };
  const INTERACTIVE_SEL = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],[tabindex]";

  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const q = (s) => JSON.stringify(s);

  function inputRole(el) {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    const map = {
      checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button",
      range: "slider", number: "spinbutton", search: "searchbox", file: "button", hidden: null,
    };
    return t in map ? map[t] : "textbox";
  }

  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute("role");
    if (r && r.trim()) return r.trim().split(/\s+/)[0].toLowerCase();
    if (el.tagName === "INPUT") return inputRole(el);
    if (el.tagName === "A") return el.hasAttribute("href") ? "link" : null;
    if (el.tagName && el.tagName.toLowerCase() === "svg") return el.getAttribute("aria-label") ? "img" : null;
    return ROLE_BY_TAG[el.tagName] ?? null;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    const st = getComputedStyle(el);
    if (st.display === "none") return false;
    if (st.display === "contents") return true;
    if (st.visibility === "hidden" || st.visibility === "collapse") return false;
    return el.getClientRects().length > 0;
  }

  function labelText(el) {
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = norm(by.split(/\s+/).map((id) => {
        const n = el.ownerDocument.getElementById(id);
        return n ? n.innerText || n.textContent : "";
      }).join(" "));
      if (t) return t;
    }
    const al = norm(el.getAttribute("aria-label"));
    if (al) return al;
    if (el.labels && el.labels.length) {
      const t = norm(Array.from(el.labels).map((l) => l.innerText || l.textContent).join(" "));
      if (t) return t;
    }
    if (el.tagName === "IMG" || el.tagName === "AREA" || (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "image")) {
      const alt = norm(el.getAttribute("alt"));
      if (alt) return alt;
    }
    return "";
  }

  function nameOf(el, role) {
    let n = labelText(el);
    if (!n) {
      const type = (el.type || "").toLowerCase();
      if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(type)) {
        n = el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      } else if (["textbox", "searchbox", "combobox", "spinbutton"].includes(role)) {
        n = el.getAttribute("placeholder") || "";
      } else if (!["listbox", "slider"].includes(role)) {
        n = el.innerText || el.textContent || "";
      }
    }
    n = norm(n);
    if (!n) n = norm(el.getAttribute("title"));
    return cut(n, 100);
  }

  function isInteractive(el, role) {
    const t = el.tagName;
    if (t === "A") return el.hasAttribute("href");
    if (t === "BUTTON" || t === "SELECT" || t === "TEXTAREA" || t === "SUMMARY") return true;
    if (t === "INPUT") return (el.type || "").toLowerCase() !== "hidden";
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick")) return true;
    return el.hasAttribute("tabindex") && el.tabIndex >= 0;
  }

  function attrs(el, role) {
    const out = [];
    if (role === "heading") {
      const m = /^H([1-6])$/.exec(el.tagName);
      const lvl = m ? m[1] : el.getAttribute("aria-level");
      if (lvl) out.push(`[level=${lvl}]`);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("[disabled]");
    if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
      const c = el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true";
      if (c) out.push("[checked]");
    }
    const ex = el.getAttribute("aria-expanded");
    if (ex) out.push(`[expanded=${ex}]`);
    if (el.getAttribute("aria-selected") === "true") out.push("[selected]");
    if (el.required) out.push("[required]");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const type = (el.type || "text").toLowerCase();
      if (type === "password") {
        out.push("[password]");
        if (el.value) out.push("value=<hidden>");
      } else if (!["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"].includes(type) && el.value) {
        out.push("value=" + q(cut(el.value, 100)));
      }
      if (type === "file") out.push(`[file input${el.files && el.files.length ? `: ${el.files.length} file(s) set` : ""}]`);
      else if (el.tagName === "INPUT" && !["text", "checkbox", "radio", "button", "submit", "reset", "password", "search", "number", "range", "image"].includes(type)) out.push(`[type=${type}]`);
    }
    if (el.tagName === "SELECT") {
      const sel = Array.from(el.selectedOptions || []).map((o) => norm(o.label || o.text));
      if (sel.length) out.push("selected=" + q(cut(sel.join(", "), 100)));
      const opts = Array.from(el.options).slice(0, 25).map((o) => norm(o.label || o.text));
      out.push("options=" + q(cut(opts.join(" | "), 300)));
    }
    if (el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      const v = norm(el.innerText);
      if (v) out.push("value=" + q(cut(v, 100)));
    }
    if (el.tagName === "A" && el.hasAttribute("href")) {
      const h = el.getAttribute("href") || "";
      if (h && !/^javascript:/i.test(h)) out.push("-> " + cut(h, 120));
    }
    return out.join(" ");
  }

  function directText(el) {
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue;
    return norm(s);
  }

  function snapshot(maxChars) {
    const refs = new Map();
    let seq = 0;
    let visited = 0;
    const lines = [];
    let size = 0;
    let cutLines = 0;
    const push = (depth, text) => {
      const line = "  ".repeat(Math.min(depth, 12)) + "- " + text;
      if (size + line.length + 1 > maxChars) {
        cutLines++;
        return;
      }
      lines.push(line);
      size += line.length + 1;
    };
    const walk = (node, depth) => {
      const kids = node.shadowRoot ? [...node.shadowRoot.children, ...node.children] : [...node.children];
      for (const el of kids) visit(el, depth);
    };
    const visit = (el, depth) => {
      if (++visited > MAX_ELEMENTS || SKIP_TAGS.has(el.tagName) || !isVisible(el)) return;
      const role = roleOf(el);
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        push(depth, `iframe ${q(cut(el.getAttribute("title") || el.src || "", 120))} (contents not included)`);
        return;
      }
      if (el.tagName && el.tagName.toLowerCase() === "svg") {
        if (role === "img") push(depth, `img ${q(cut(norm(el.getAttribute("aria-label")), 100))}`);
        return;
      }
      if (isInteractive(el, role)) {
        const ref = "e" + ++seq;
        refs.set(ref, el);
        const r = role || el.tagName.toLowerCase();
        const name = nameOf(el, r);
        const a = attrs(el, r);
        push(depth, `${r}${name ? " " + q(name) : ""}${a ? " " + a : ""} [ref=${ref}]`);
        if (!["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(el.tagName) && el.querySelector(INTERACTIVE_SEL)) walk(el, depth + 1);
        return;
      }
      if (role === "heading") {
        const t = cut(norm(el.innerText || el.textContent), MAX_TEXT);
        if (t) push(depth, `heading ${q(t)} ${attrs(el, role)}`.trim());
        return;
      }
      if (role === "img") {
        const n = norm(labelText(el) || el.getAttribute("title"));
        if (n) push(depth, `img ${q(cut(n, 100))}`);
        return;
      }
      if (role && STRUCT_ROLES.has(role)) {
        const n = labelText(el);
        push(depth, `${role}${n ? " " + q(cut(n, 80)) : ""}`);
        const t = directText(el);
        if (t) push(depth + 1, `text: ${q(cut(t, MAX_TEXT))}`);
        walk(el, depth + 1);
        return;
      }
      if (role && TEXT_ROLES.has(role) && !el.querySelector(INTERACTIVE_SEL)) {
        const t = cut(norm(el.innerText || el.textContent), MAX_TEXT * 2);
        if (t) push(depth, `${role}: ${q(t)}`);
        return;
      }
      const t = directText(el);
      if (t) push(depth, `text: ${q(cut(t, MAX_TEXT))}`);
      walk(el, depth);
    };
    const root = document.body || document.documentElement;
    if (root) walk(root, 0);
    globalThis.__gk.refs = refs;
    let text = lines.join("\n");
    if (cutLines) text += `\n- … (${cutLines} more lines not shown: the snapshot is limited to ${maxChars} characters)`;
    if (visited > MAX_ELEMENTS) text += `\n- … (page has more than ${MAX_ELEMENTS} elements; the rest was skipped)`;
    return { url: location.href, title: document.title, text, refs: seq };
  }

  function resolve(ref) {
    const el = globalThis.__gk.refs.get(String(ref));
    if (!el) throw new Error(`Unknown ref ${ref}: take a new browser_snapshot (refs are only valid for the latest snapshot).`);
    if (!el.isConnected) throw new Error(`Ref ${ref} is no longer on the page: take a new browser_snapshot.`);
    return el;
  }

  function describe(el) {
    if (!el || !el.tagName) return "";
    const r = roleOf(el) || el.tagName.toLowerCase();
    const n = nameOf(el, r);
    let s = r + (n ? " " + q(n) : "");
    if (!n) {
      if (el.id) s += "#" + el.id;
      else if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
    }
    return cut(s, 120);
  }

  function formInfo(el) {
    const form = el.form || (el.closest && el.closest("form"));
    if (!form) return null;
    let action = form.getAttribute("action") || location.href;
    try {
      action = new URL(action, location.href).href;
    } catch (_) {}
    return { action, method: (form.getAttribute("method") || "get").toLowerCase() };
  }

  function submitter(el) {
    const b = el.closest && el.closest("button, input[type=submit], input[type=image]");
    if (!b || !b.form) return null;
    if (b.tagName === "BUTTON" && (b.getAttribute("type") || "submit").toLowerCase() !== "submit") return null;
    return b;
  }

  function point(ref) {
    const el = resolve(ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rects = el.getClientRects();
    const r = el.getBoundingClientRect();
    if (!rects.length || (r.width === 0 && r.height === 0)) throw new Error(`${describe(el)} is not visible.`);
    const box = rects[0].width > 0 && rects[0].height > 0 ? rects[0] : r;
    const x = Math.min(Math.max(box.left + box.width / 2, 1), innerWidth - 1);
    const y = Math.min(Math.max(box.top + box.height / 2, 1), innerHeight - 1);
    const root = el.getRootNode();
    const hit = (root && typeof root.elementFromPoint === "function" ? root : document).elementFromPoint(x, y);
    const ok = !hit || hit === el || el.contains(hit) || (hit.tagName === "LABEL" && hit.control === el) || (el.tagName === "LABEL" && el.control === hit);
    const sub = submitter(el);
    return { x, y, desc: describe(el), covered: ok ? null : describe(hit), submit: !!sub, form: sub ? formInfo(sub) : null, page: location.href };
  }

  function focusForType(ref) {
    const el = resolve(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const type = (el.type || "").toLowerCase();
    const textInput = el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden", "range", "color"].includes(type));
    if (!textInput && !el.isContentEditable) throw new Error(`${describe(el)} is not editable; use browser_click or browser_select_option.`);
    if (el.disabled || el.readOnly) throw new Error(`${describe(el)} is disabled or read-only.`);
    el.focus();
    if (!textInput) {
      const sel = getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } else if (typeof el.select === "function") {
      el.select();
    }
    return { desc: describe(el), password: type === "password", form: formInfo(el), hadValue: textInput ? !!el.value : !!norm(el.innerText), page: location.href };
  }

  function active() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (!a || a === document.body || a === document.documentElement) return { desc: null, form: null, password: false, multiline: false, page: location.href };
    return {
      desc: describe(a),
      form: formInfo(a),
      password: (a.type || "").toLowerCase() === "password",
      multiline: a.tagName === "TEXTAREA" || !!a.isContentEditable,
      page: location.href,
    };
  }

  function select(ref, values) {
    const el = resolve(ref);
    if (el.tagName !== "SELECT") throw new Error(`${describe(el)} is not a <select>; click it and pick the option instead.`);
    const wanted = (values || []).map((v) => String(v));
    const picked = [];
    for (const o of el.options) {
      const hit = wanted.includes(o.value) || wanted.includes(norm(o.label)) || wanted.includes(norm(o.text));
      if (hit && (el.multiple || picked.length === 0)) picked.push(o);
    }
    if (!picked.length) {
      const opts = Array.from(el.options).slice(0, 30).map((o) => q(norm(o.label || o.text))).join(", ");
      throw new Error(`No option matches ${q(wanted)}. Options: ${opts}`);
    }
    for (const o of el.options) o.selected = picked.includes(o);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { desc: describe(el), selected: picked.map((o) => norm(o.label || o.text)) };
  }

  function hasText(text) {
    return !!document.body && document.body.innerText.includes(String(text));
  }

  function fileInput(ref) {
    const el = resolve(ref);
    if (el.tagName !== "INPUT" || (el.type || "").toLowerCase() !== "file") throw new Error(`${describe(el)} is not a file input (<input type=file>).`);
    return el;
  }

  globalThis.__gk = {
    refs: new Map(),
    fileInput,
    run(op, a) {
      switch (op) {
        case "snapshot": return snapshot(a.maxChars);
        case "point": return point(a.ref);
        case "focus": return focusForType(a.ref);
        case "active": return active();
        case "select": return select(a.ref, a.values);
        case "hasText": return hasText(a.text);
        case "describe": return describe(resolve(a.ref));
        default: throw new Error("unknown op " + op);
      }
    },
  };
})();
