// ICU-lite message formatting (pure, no DOM / React / store imports; unit-tested in node).
//
// Syntax (a small subset of ICU MessageFormat):
//   {name}                         the value as text (numbers are NOT grouped: ports, PIDs and years stay "5173")
//   {n, number}                    locale number format (1,234.5 / 1.234,5 …)
//   {d, date} / {d, time}          locale date / time (short), from a Date or epoch milliseconds
//   {n, plural, =0 {…} one {# x} other {# xs}}
//                                  plural by Intl.PluralRules; "#" is the formatted count; "=N" matches exactly
//   {k, select, a {…} b {…} other {…}}
//                                  pick a branch by a string value
//   <tag>…</tag>                   rich-text marker: rendered by a function param of the same name (React side,
//                                  see `rich` in ./index), stripped to its content by plain `t()`
//
// No escaping: braces are always syntax and an apostrophe is just an apostrophe ("can't" works). A "<" that does
// not open a matched <tag>…</tag> pair is literal text ("<0.1%", "<repo>-worktrees").

export type ParamValue = string | number | boolean | Date | null | undefined;
export type Params = Record<string, ParamValue>;

export type MsgNode =
  | { k: "text"; v: string }
  | { k: "arg"; name: string; style?: "number" | "date" | "time" }
  | { k: "plural"; name: string; cases: Record<string, MsgNode[]> }
  | { k: "select"; name: string; cases: Record<string, MsgNode[]> }
  | { k: "pound" }
  | { k: "tag"; name: string; children: MsgNode[] };

export class MessageSyntaxError extends Error {}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  parse(): MsgNode[] {
    const out = this.nodes(false);
    if (this.i < this.s.length) this.fail(`unexpected "${this.s[this.i]}"`);
    return out;
  }

  private fail(why: string): never {
    throw new MessageSyntaxError(`${why} at ${this.i} in "${this.s}"`);
  }

  private ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  private word(re: RegExp): string {
    const m = re.exec(this.s.slice(this.i));
    if (!m) this.fail("expected a name");
    this.i += m[0].length;
    return m[0];
  }

  private expect(lit: string) {
    if (!this.s.startsWith(lit, this.i)) this.fail(`expected "${lit}"`);
    this.i += lit.length;
  }

  private nodes(inPlural: boolean, closeTag?: string): MsgNode[] {
    const out: MsgNode[] = [];
    let text = "";
    const flush = () => {
      if (text) out.push({ k: "text", v: text });
      text = "";
    };
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === "}") break;
      if (c === "{") {
        flush();
        out.push(this.argument(inPlural));
        continue;
      }
      if (c === "#" && inPlural) {
        flush();
        out.push({ k: "pound" });
        this.i++;
        continue;
      }
      if (c === "<") {
        if (closeTag && this.s.startsWith(`</${closeTag}>`, this.i)) break;
        const m = /^<([A-Za-z][\w-]*)>/.exec(this.s.slice(this.i));
        if (m && this.s.indexOf(`</${m[1]}>`, this.i + m[0].length) >= 0) {
          flush();
          this.i += m[0].length;
          const children = this.nodes(inPlural, m[1]);
          this.expect(`</${m[1]}>`);
          out.push({ k: "tag", name: m[1], children });
          continue;
        }
      }
      text += c;
      this.i++;
    }
    flush();
    return out;
  }

  private argument(inPlural: boolean): MsgNode {
    this.expect("{");
    this.ws();
    const name = this.word(/^[A-Za-z_][\w.]*/);
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return { k: "arg", name };
    }
    this.expect(",");
    this.ws();
    const type = this.word(/^[a-z]+/);
    this.ws();
    if (type === "number" || type === "date" || type === "time") {
      this.expect("}");
      return { k: "arg", name, style: type };
    }
    if (type !== "plural" && type !== "select") this.fail(`unknown type "${type}"`);
    this.expect(",");
    const cases: Record<string, MsgNode[]> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        break;
      }
      const sel = this.word(/^=?[\w-]+/);
      this.ws();
      this.expect("{");
      cases[sel] = this.nodes(type === "plural" || inPlural);
      this.expect("}");
    }
    if (!cases.other) this.fail(`${type} without "other"`);
    return { k: type, name, cases };
  }
}

const parseCache = new Map<string, MsgNode[]>();

/** Parse a message (cached). Throws MessageSyntaxError on malformed input. */
export function parseMessage(msg: string): MsgNode[] {
  let nodes = parseCache.get(msg);
  if (!nodes) {
    nodes = msg.includes("{") || msg.includes("<") ? new Parser(msg).parse() : [{ k: "text", v: msg }];
    parseCache.set(msg, nodes);
  }
  return nodes;
}

// ---- Intl caches ------------------------------------------------------------------

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

export function numberFormat(intlLocale: string, opts?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${intlLocale}|${opts ? JSON.stringify(opts) : ""}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(intlLocale, opts);
    numberFormats.set(key, f);
  }
  return f;
}

export function dateFormat(intlLocale: string, opts?: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${intlLocale}|${opts ? JSON.stringify(opts) : ""}`;
  let f = dateFormats.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocale, opts);
    dateFormats.set(key, f);
  }
  return f;
}

export function pluralCategory(intlLocale: string, n: number): string {
  let r = pluralRules.get(intlLocale);
  if (!r) {
    r = new Intl.PluralRules(intlLocale);
    pluralRules.set(intlLocale, r);
  }
  return r.select(n);
}

// ---- formatting ---------------------------------------------------------------------

/** A param that renders a rich-text tag: receives the formatted children, returns a part. */
export type TagRenderer = (children: unknown[]) => unknown;
/** Params for `formatParts`: plain values, opaque parts (e.g. React elements) and tag renderers. */
export type PartParams = Record<string, unknown>;

function toNumber(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function toDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(typeof v === "number" ? v : String(v));
}

function plain(v: unknown): unknown {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  return v; // opaque part (React element …) passes through
}

function pushText(out: unknown[], s: string) {
  if (!s) return;
  const last = out.length - 1;
  if (last >= 0 && typeof out[last] === "string") out[last] = (out[last] as string) + s;
  else out.push(s);
}

function push(out: unknown[], v: unknown) {
  if (typeof v === "string") pushText(out, v);
  else if (Array.isArray(v)) for (const x of v) push(out, x);
  else if (v !== null && v !== undefined && v !== false && v !== "") out.push(v);
}

function render(nodes: MsgNode[], params: PartParams | undefined, intlLocale: string, pound: number | undefined, out: unknown[]) {
  for (const n of nodes) {
    switch (n.k) {
      case "text":
        pushText(out, n.v);
        break;
      case "pound":
        pushText(out, pound === undefined ? "#" : numberFormat(intlLocale).format(pound));
        break;
      case "arg": {
        const v = params?.[n.name];
        if (n.style === "number") pushText(out, numberFormat(intlLocale).format(toNumber(v)));
        else if (n.style === "date") pushText(out, dateFormat(intlLocale, { dateStyle: "medium" }).format(toDate(v)));
        else if (n.style === "time") pushText(out, dateFormat(intlLocale, { timeStyle: "short" }).format(toDate(v)));
        else push(out, plain(v));
        break;
      }
      case "plural": {
        const count = toNumber(params?.[n.name]);
        const exact = n.cases[`=${count}`];
        const branch = exact ?? n.cases[Number.isFinite(count) ? pluralCategory(intlLocale, count) : "other"] ?? n.cases.other;
        render(branch, params, intlLocale, count, out);
        break;
      }
      case "select": {
        const v = params?.[n.name];
        render(n.cases[String(v)] ?? n.cases.other, params, intlLocale, pound, out);
        break;
      }
      case "tag": {
        const children: unknown[] = [];
        render(n.children, params, intlLocale, pound, children);
        const fn = params?.[n.name];
        if (typeof fn === "function") push(out, (fn as TagRenderer)(children));
        else for (const c of children) push(out, c);
        break;
      }
    }
  }
}

/** Format to parts: adjacent text is merged into strings; opaque params and tag results stay separate parts. */
export function formatParts(msg: string, params: PartParams | undefined, intlLocale: string): unknown[] {
  const out: unknown[] = [];
  render(parseMessage(msg), params, intlLocale, undefined, out);
  return out;
}

/** Format to a string. Tags are stripped to their content; a malformed message comes back as written. */
export function formatMessage(msg: string, params: Params | undefined, intlLocale: string): string {
  let parts: unknown[];
  try {
    parts = formatParts(msg, params, intlLocale);
  } catch {
    return msg;
  }
  return parts.map((p) => (typeof p === "string" ? p : String(p))).join("");
}

// ---- structure (catalog checks) -----------------------------------------------------

export interface MessageShape {
  /** Every referenced param name. */
  names: Set<string>;
  /** Names used as plural selectors. */
  plurals: Set<string>;
  /** Select selector name -> its case keys. */
  selects: Map<string, Set<string>>;
  /** Rich-text tag names. */
  tags: Set<string>;
  /** Plural case keys used (one, few, other, =0 …), for validating against a locale's categories. */
  pluralKeys: Set<string>;
}

/** What a message references, for comparing a translation with its English source. Throws on bad syntax. */
export function messageShape(msg: string): MessageShape {
  const shape: MessageShape = { names: new Set(), plurals: new Set(), selects: new Map(), tags: new Set(), pluralKeys: new Set() };
  const walk = (nodes: MsgNode[]) => {
    for (const n of nodes) {
      if (n.k === "arg") shape.names.add(n.name);
      else if (n.k === "plural") {
        shape.names.add(n.name);
        shape.plurals.add(n.name);
        for (const [key, c] of Object.entries(n.cases)) {
          shape.pluralKeys.add(key);
          walk(c);
        }
      } else if (n.k === "select") {
        shape.names.add(n.name);
        const keys = shape.selects.get(n.name) ?? new Set<string>();
        for (const [key, c] of Object.entries(n.cases)) {
          keys.add(key);
          walk(c);
        }
        shape.selects.set(n.name, keys);
      } else if (n.k === "tag") {
        shape.tags.add(n.name);
        walk(n.children);
      }
    }
  };
  walk(new Parser(msg).parse());
  return shape;
}
