// Thin Playwright wrapper used by both surfaces. Lazy-launches a single managed
// Chromium with a dedicated profile dir (NOT the user's daily-driver), keeps a
// single page, tracks recent console messages + network requests + a stable
// ref→key registry for the curated surface. Reads the accessibility tree via
// CDP (Accessibility.getFullAXTree) since playwright-core dropped page.accessibility.

import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { resolve } from "node:path";

const PROFILE_DIR = process.env.BROWX_SPIKE_PROFILE_DIR ?? resolve(".browx-spike-profile");
const HEADLESS = process.env.BROWX_SPIKE_HEADLESS === "1";
const RECENT_LIMIT = 200;

export interface ConsoleEntry { ts: string; type: string; text: string; }
export interface NetworkEntry { ts: string; method: string; url: string; status?: number; type?: string; }

export interface A11yNode {
  role: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  selected?: boolean;
  expanded?: boolean;
  focused?: boolean;
  children: A11yNode[];
}

// Raw shapes returned by CDP Accessibility.getFullAXTree (subset we care about).
interface RawProp { name: string; value: { value?: unknown; type?: string }; }
interface RawAXNode {
  nodeId: string;
  parentId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: RawProp[];
  childIds?: string[];
}

export class BrowxSpikeBrowser {
  private ctx?: BrowserContext;
  private browser?: Browser;
  private _page?: Page;
  private cdp?: CDPSession;
  private consoleBuf: ConsoleEntry[] = [];
  private networkBuf: NetworkEntry[] = [];
  // Curated-surface refs: stable key → "eN". Persists across snapshots.
  private refByKey = new Map<string, string>();
  private keyByRef = new Map<string, string>();
  private refCounter = 0;

  async ensure(): Promise<Page> {
    if (this._page) return this._page;
    this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
    });
    this._page = this.ctx.pages()[0] ?? await this.ctx.newPage();
    this._page.on("console", (msg) => {
      this.consoleBuf.push({ ts: new Date().toISOString(), type: msg.type(), text: msg.text() });
      if (this.consoleBuf.length > RECENT_LIMIT) this.consoleBuf.shift();
    });
    this._page.on("requestfinished", async (req) => {
      const resp = await req.response().catch(() => null);
      this.networkBuf.push({
        ts: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        status: resp?.status(),
        type: req.resourceType(),
      });
      if (this.networkBuf.length > RECENT_LIMIT) this.networkBuf.shift();
    });
    this._page.on("requestfailed", (req) => {
      this.networkBuf.push({
        ts: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        type: req.resourceType(),
      });
      if (this.networkBuf.length > RECENT_LIMIT) this.networkBuf.shift();
    });
    this.cdp = await this.ctx.newCDPSession(this._page);
    await this.cdp.send("Accessibility.enable");
    return this._page;
  }

  async close(): Promise<void> {
    await this.cdp?.detach().catch(() => undefined);
    await this.ctx?.close();
    await this.browser?.close();
  }

  page(): Page {
    if (!this._page) throw new Error("browser not started");
    return this._page;
  }

  recentConsole(limit = 50): ConsoleEntry[] { return this.consoleBuf.slice(-limit); }
  recentNetwork(limit = 50): NetworkEntry[] { return this.networkBuf.slice(-limit); }
  recentConsoleErrors(sinceMs: number): string[] {
    const cutoff = Date.now() - sinceMs;
    return this.consoleBuf
      .filter((e) => e.type === "error" && Date.parse(e.ts) >= cutoff)
      .map((e) => e.text);
  }

  // --- ref scheme (curated surface) ---
  refFor(node: A11yNode, path: string): string {
    const key = `${node.role}|${node.name ?? ""}|${path}`;
    let ref = this.refByKey.get(key);
    if (!ref) {
      ref = `e${++this.refCounter}`;
      this.refByKey.set(key, ref);
      this.keyByRef.set(ref, key);
    }
    return ref;
  }
  hasRef(ref: string): boolean { return this.keyByRef.has(ref); }
  refKey(ref: string): string {
    const k = this.keyByRef.get(ref);
    if (!k) throw new Error(`unknown ref "${ref}"`);
    return k;
  }

  async getA11yRoot(): Promise<A11yNode | null> {
    if (!this.cdp) await this.ensure();
    const { nodes } = await this.cdp!.send("Accessibility.getFullAXTree") as { nodes: RawAXNode[] };
    if (!nodes.length) return null;
    const byId = new Map<string, RawAXNode>(nodes.map((n) => [n.nodeId, n]));
    // Root = the only node without a parentId (or whose parent isn't in the set).
    const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId)) ?? nodes[0]!;
    const convert = (raw: RawAXNode): A11yNode | null => {
      if (raw.ignored) return null;
      const role = raw.role?.value ?? "generic";
      const node: A11yNode = {
        role,
        name: raw.name?.value,
        value: raw.value?.value !== undefined ? String(raw.value.value) : undefined,
        children: [],
      };
      for (const p of raw.properties ?? []) {
        const v = p.value?.value;
        switch (p.name) {
          case "disabled": node.disabled = !!v; break;
          case "checked": node.checked = v as boolean | "mixed"; break;
          case "pressed": node.pressed = v as boolean | "mixed"; break;
          case "selected": node.selected = !!v; break;
          case "expanded": node.expanded = !!v; break;
          case "focused": node.focused = !!v; break;
          default: break;
        }
      }
      for (const cid of raw.childIds ?? []) {
        const c = byId.get(cid);
        if (!c) continue;
        const cv = convert(c);
        if (cv) node.children.push(cv);
      }
      return node;
    };
    return convert(root);
  }

  async walkA11y(): Promise<Array<{ node: A11yNode; path: string; ref: string; depth: number }>> {
    const root = await this.getA11yRoot();
    const out: Array<{ node: A11yNode; path: string; ref: string; depth: number }> = [];
    if (!root) return out;
    const walk = (n: A11yNode, path: string, depth: number): void => {
      const ref = this.refFor(n, path);
      out.push({ node: n, path, ref, depth });
      n.children.forEach((c, i) => walk(c, `${path}/${c.role}[${i}]`, depth + 1));
    };
    walk(root, root.role, 0);
    return out;
  }
}

export function fmtState(n: A11yNode): string {
  const bits: string[] = [];
  if (n.disabled) bits.push("disabled");
  if (n.checked !== undefined) bits.push(`checked=${n.checked}`);
  if (n.pressed !== undefined) bits.push(`pressed=${n.pressed}`);
  if (n.selected) bits.push("selected");
  if (n.expanded !== undefined) bits.push(`expanded=${n.expanded}`);
  if (n.focused) bits.push("focused");
  if (n.value !== undefined && n.value !== "") bits.push(`value="${String(n.value).slice(0, 40)}"`);
  return bits.length ? ` [${bits.join(", ")}]` : "";
}

export function countNodes(n: A11yNode | null): number {
  if (!n) return 0;
  return 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
}
