// `frames` — nested iframes for frames_list and cross-frame find. The parent
// embeds two same-origin children (served as extra routes); one child embeds a
// grandchild, so the frame tree has depth.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

function child(label: string, inner: string): string {
  return doc(`Frame ${label}`, `<p data-frame="${label}" data-testid="frame-${label}">frame ${label} content</p>${inner}`, {
    surfaceId: `frame-${label}`,
  });
}

export const frames: Surface = {
  id: "frames",
  path: "/frames",
  title: "Frames surface",
  blurb: "nested same-origin iframes (depth 2) for frames_list",
  html: () =>
    doc(
      "Frames surface",
      `
<section class="card">
  <p data-testid="frames-intro">Parent document. Two child frames below.</p>
  <iframe src="/frames/child-a" title="child-a" data-testid="iframe-a" width="400" height="160"></iframe>
  <iframe src="/frames/child-b" title="child-b" data-testid="iframe-b" width="400" height="160"></iframe>
</section>
`,
      { surfaceId: "frames" },
    ),
  routes: [
    {
      method: "GET",
      path: "/frames/child-a",
      handle: ({ res }) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(child("a", `<iframe src="/frames/grandchild" title="grandchild" data-testid="iframe-gc" width="300" height="80"></iframe>`));
      },
    },
    {
      method: "GET",
      path: "/frames/child-b",
      handle: ({ res }) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(child("b", ""));
      },
    },
    {
      method: "GET",
      path: "/frames/grandchild",
      handle: ({ res }) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(child("grandchild", ""));
      },
    },
  ],
};
