// A tiny static page served from 127.0.0.1 with a form, for the first-snapshot and SDK checks. No network beyond loopback.
import { createServer } from "node:http";

export const PAGE_TITLE = "Newsletter";
export const EMAIL = "ada@example.com";
export const DONE_TEXT = `Subscribed: ${EMAIL}`;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${PAGE_TITLE}</title></head>
<body>
<h1>${PAGE_TITLE}</h1>
<p>A fixture page served from loopback.</p>
<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email">
  <button type="submit">Subscribe</button>
</form>
<p id="status" role="status"></p>
<script>
document.getElementById("f").addEventListener("submit", function (e) {
  e.preventDefault();
  document.getElementById("status").textContent = "Subscribed: " + document.getElementById("email").value;
});
</script>
</body></html>`;

// A 1x1 SVG, for the loopback side of the fence check.
const IMAGE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1"/></svg>';

/** startFixture({ fenceProbe }) -> { url, close }. fenceProbe: true serves the image probe page, the default serves the form. */
export async function startFixture({ fenceProbe = false } = {}) {
  const probe = `<!doctype html><p id="r">pending</p><script>
function t(u){return new Promise(function(r){var i=new Image();i.onload=function(){r("reached")};i.onerror=function(){r("blocked")};i.src=u;});}
Promise.all([t("http://203.0.113.9/p.png"),t("http://example.invalid/p.png"),t("https://1.1.1.1/p.png"),t("/ok.svg")])
.then(function(r){document.getElementById("r").textContent=r.join(",");});
</script>`;
  const server = createServer((req, res) => {
    if (req.url === "/ok.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" }).end(IMAGE);
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(fenceProbe ? probe : PAGE);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
