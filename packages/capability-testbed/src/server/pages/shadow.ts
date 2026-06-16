// `shadow` — open and closed shadow roots for shadow_trees. The open host's tree
// is walkable; the closed host's is platform-inaccessible (the exercise asserts
// the open-only view + warning).
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const shadow: Surface = {
  id: "shadow",
  path: "/shadow",
  title: "Shadow DOM surface",
  blurb: "open + closed shadow roots, custom elements",
  html: () =>
    doc(
      "Shadow DOM surface",
      `
<section class="card">
  <open-card data-testid="open-host"></open-card>
  <closed-card data-testid="closed-host"></closed-card>
</section>
`,
      {
        surfaceId: "shadow",
        script: `
class OpenCard extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<p data-shadow="open" data-testid="open-shadow-text">open shadow content</p><button data-testid="open-shadow-btn">shadow button</button>';
  }
}
class ClosedCard extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<p data-shadow="closed">closed shadow content</p>';
  }
}
customElements.define('open-card', OpenCard);
customElements.define('closed-card', ClosedCard);
`,
      },
    ),
};
