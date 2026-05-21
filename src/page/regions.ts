// Named visual regions — capability `human`.
//
// In virtualised timelines / canvas / unlabelled positioned divs the target
// is "the third row segment at x=…", not an element ref. `name_region` binds
// a box to a mnemonic so a sub-agent can re-select, copy, and re-check the
// same media segment without re-deriving coordinates each time (coordinate
// drift). `region` resolves the name back to its box + centre point, which
// the caller passes to `click({coords})` etc.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NamedRegion {
  name: string;
  box: Box;
  /** box centre — the point to hand to a coords-based action. */
  center: { x: number; y: number };
}

/** One per SessionEntry. In-memory; nothing persisted. */
export class RegionRegistry {
  private regions = new Map<string, Box>();

  set(name: string, box: Box): NamedRegion {
    this.regions.set(name, box);
    return this.view(name)!;
  }

  get(name: string): NamedRegion | undefined {
    return this.view(name);
  }

  list(): NamedRegion[] {
    return [...this.regions.keys()].map((n) => this.view(n)!);
  }

  private view(name: string): NamedRegion | undefined {
    const box = this.regions.get(name);
    if (!box) return undefined;
    return {
      name,
      box,
      center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    };
  }
}
