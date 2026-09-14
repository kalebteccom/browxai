/// <reference lib="dom" />
// The panel contract and the host that mounts them (RFC 0007 P3).
//
// This is the INTERNAL shape of the `registerPanel({id, title, eventTypes,
// mount(container, api)})` surface the RFC makes public in P4. The four panels
// browxai ships are written against it now so that P4 exposes this contract
// rather than inventing a second one, and so the constraint it exists to
// enforce is already load-bearing: a panel is a pure function of the event log
// and the playhead. It reads `api.index`, it renders into its own container,
// and it asks the host to move the playhead. It never touches the rrweb stage,
// the step list or the timeline strip, which is what keeps the host free to
// change them.
//
// Two host-side rules follow from the forward-compatibility rule in
// `../../schema.ts`:
//   - a panel over an event type the log does not contain still mounts, and
//     renders its own empty state. It is never dropped from the tab bar, because
//     "this artifact has no WebSockets" is information.
//   - a seek reaches only the ACTIVE panel. A hidden panel catches up when it is
//     selected, so playback does not pay for four re-renders a frame.

import type { EventIndex } from "./event-index.js";
import { el } from "./panel-ui.js";

export interface PanelApi {
  readonly index: EventIndex;
  /** Playhead in ms on the artifact clock. */
  playhead(): number;
  /** Move the timeline. What a row click calls. */
  seekTo(t: number): void;
  onSeek(handler: (t: number) => void): void;
}

export interface PanelDef {
  id: string;
  title: string;
  /** The types this panel consumes. The host indexes by type and uses these for
   *  the tab's event count and its empty marking; the panel still reads the
   *  index itself. */
  eventTypes: readonly string[];
  mount(container: HTMLElement, api: PanelApi): void;
}

export interface PanelHost {
  seek(t: number): void;
  select(id: string): void;
  activeId(): string;
}

export interface PanelHostOptions {
  tabs: HTMLElement;
  body: HTMLElement;
  index: EventIndex;
  panels: readonly PanelDef[];
  seekTo: (t: number) => void;
}

interface Mounted {
  def: PanelDef;
  tab: HTMLElement;
  section: HTMLElement;
  listeners: ((t: number) => void)[];
  /** The playhead the panel last rendered, so selecting it is a no-op when it
   *  is already current. */
  renderedAt: number | undefined;
}

function countFor(index: EventIndex, types: readonly string[]): number {
  let total = 0;
  for (const type of types) total += index.count(type);
  return total;
}

function makeTab(def: PanelDef, count: number): HTMLElement {
  const tab = el("button", "panel-tab");
  (tab as HTMLButtonElement).type = "button";
  tab.dataset.panelId = def.id;
  tab.dataset.count = String(count);
  tab.dataset.empty = String(count === 0);
  tab.setAttribute("role", "tab");
  tab.setAttribute("aria-selected", "false");
  tab.append(el("span", "panel-tab-title", def.title));
  tab.append(el("span", "panel-tab-count", count === 0 ? "0" : String(count)));
  return tab;
}

export function mountPanels(opts: PanelHostOptions): PanelHost {
  const mounted: Mounted[] = [];
  let current = 0;
  let playhead = 0;

  const notify = (entry: Mounted): void => {
    if (entry.renderedAt === playhead) return;
    entry.renderedAt = playhead;
    for (const fn of entry.listeners) fn(playhead);
  };

  const select = (id: string): void => {
    const next = mounted.findIndex((m) => m.def.id === id);
    if (next < 0) return;
    current = next;
    for (const [i, entry] of mounted.entries()) {
      const active = i === current;
      entry.tab.setAttribute("aria-selected", String(active));
      entry.section.hidden = !active;
    }
    const entry = mounted[current];
    if (entry) notify(entry);
  };

  for (const def of opts.panels) {
    const count = countFor(opts.index, def.eventTypes);
    const tab = makeTab(def, count);
    const section = el("section", `panel panel-${def.id}`);
    section.dataset.panelId = def.id;
    section.setAttribute("role", "tabpanel");
    section.hidden = true;
    const entry: Mounted = { def, tab, section, listeners: [], renderedAt: undefined };
    mounted.push(entry);
    opts.tabs.append(tab);
    opts.body.append(section);
    def.mount(section, {
      index: opts.index,
      playhead: () => playhead,
      seekTo: opts.seekTo,
      onSeek: (handler) => entry.listeners.push(handler),
    });
  }

  opts.tabs.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".panel-tab");
    const id = tab?.dataset.panelId;
    if (id !== undefined) select(id);
  });

  // One delegated listener for every row in every panel: any element carrying
  // `data-t` seeks the timeline to it. That is the whole coupling between a
  // panel and the player.
  opts.body.addEventListener("click", (ev) => {
    const node = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-t]");
    const t = node?.dataset.t;
    if (t === undefined) return;
    const ms = Number(t);
    if (Number.isFinite(ms)) opts.seekTo(ms);
  });

  const first = mounted[0];
  if (first) select(first.def.id);

  return {
    seek: (t: number) => {
      playhead = t;
      const entry = mounted[current];
      if (entry) notify(entry);
    },
    select,
    activeId: () => mounted[current]?.def.id ?? "",
  };
}
