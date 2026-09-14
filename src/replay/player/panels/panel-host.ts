/// <reference lib="dom" />
// The panel contract and the host that mounts them (RFC 0007 P3).
//
// This is the INTERNAL shape of the `registerPanel({id, title, eventTypes,
// mount(container, api)})` surface the RFC makes public in P4. The four panels
// browxai ships are written against it now so that P4 exposes this contract
// rather than inventing a second one, and so the constraint it exists to
// enforce is already load-bearing: a panel is a pure function of the event log
// and the playhead. It reads `api.events`, it renders into its own container,
// and it asks the host to move the playhead. It never touches the rrweb stage,
// the step list or the timeline strip, which is what keeps the host free to
// change them.
//
// Three host-side rules follow from the forward-compatibility rule in
// `../../schema.ts`:
//   - a panel over an event type the log does not contain still mounts, and
//     renders its own empty state. It is never dropped from the tab bar, because
//     "this artifact has no WebSockets" is information.
//   - a panel that throws, at mount or on a seek, is contained to its own tab.
//     "must never fail to open a log" outranks any one panel's output, and in P4
//     the code that throws will not even be ours.
//   - a seek reaches only the ACTIVE panel. A hidden panel catches up when it is
//     selected, so playback does not pay for four re-renders a frame.
//
// The one piece of coupling between a panel and the timeline: ANY element a
// panel renders carrying `data-t` seeks the playhead to that millisecond when
// clicked. The host listens once, delegated, for the whole panel body — a panel
// never holds a reference to the player.

import type { EventIndex, EventRange, EventSource } from "./event-index.js";
import { el, emptyState } from "./panel-ui.js";

export interface PanelApi extends EventSource {
  /** Playhead in ms on the artifact clock. */
  playhead(): number;
  /** Move the timeline. What a row click calls. */
  seekTo(t: number): void;
  onSeek(handler: (t: number) => void): void;
}

export interface PanelDef {
  id: string;
  title: string;
  /** The types this panel consumes, and the whole of what `api.events` will
   *  hand it. Declaring them is what keeps a panel from reading the parts of
   *  the log that are none of its business. */
  eventTypes: readonly string[];
  /** The type whose count the tab badge shows. Defaults to every declared type
   *  summed, which is wrong for a panel whose rows are one type and whose other
   *  types are context (coverage reads results to fill a span). */
  countType?: string;
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

function countFor(index: EventIndex, def: PanelDef): number {
  if (def.countType !== undefined) return index.count(def.countType);
  let total = 0;
  for (const type of def.eventTypes) total += index.count(type);
  return total;
}

/** A panel reads the log only through the types it declared. An undeclared type
 *  reads as absent rather than as an error: the panel renders its empty state,
 *  which is the same thing that happens when the log genuinely lacks it. */
function readerFor(index: EventIndex, types: readonly string[]): EventSource["events"] {
  const declared = new Set(types);
  return (type: string, range?: EventRange) =>
    declared.has(type) ? index.events(type, range) : [];
}

/** A panel that throws is contained to its own tab. */
function guard(entry: Mounted, what: string, run: () => void): void {
  try {
    run();
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    entry.section.dataset.failed = what;
    entry.section.replaceChildren(emptyState(`This panel could not ${what}.`, detail));
  }
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
    guard(entry, "render", () => {
      for (const fn of entry.listeners) fn(playhead);
    });
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
    const count = countFor(opts.index, def);
    const tab = makeTab(def, count);
    const section = el("section", `panel panel-${def.id}`);
    section.dataset.panelId = def.id;
    section.setAttribute("role", "tabpanel");
    section.hidden = true;
    const entry: Mounted = { def, tab, section, listeners: [], renderedAt: undefined };
    mounted.push(entry);
    opts.tabs.append(tab);
    opts.body.append(section);
    guard(entry, "open", () =>
      def.mount(section, {
        duration: opts.index.duration,
        events: readerFor(opts.index, def.eventTypes),
        playhead: () => playhead,
        seekTo: opts.seekTo,
        onSeek: (handler) => entry.listeners.push(handler),
      }),
    );
  }

  opts.tabs.addEventListener("click", (ev) => {
    const tab = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".panel-tab");
    const id = tab?.dataset.panelId;
    if (id !== undefined) select(id);
  });

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
