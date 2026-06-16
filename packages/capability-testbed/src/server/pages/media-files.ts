// `media-files` — file input, drop zone, a download trigger, a <video>, and a
// File System Access picker button. Exercises upload_file, drop_files,
// downloads_capture/download_get, fs_picker_respond, page_archive, dom_export,
// element_export, asset_export, pdf_save, get_video/stop_video, screenshot_*.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const mediaFiles: Surface = {
  id: "media-files",
  path: "/media-files",
  title: "Media & files surface",
  blurb: "file input, drop zone, download, video, File System Access picker",
  html: () =>
    doc(
      "Media & files surface",
      `
<section class="card">
  <input type="file" id="file" data-testid="file-input" multiple />
  <div id="drop" data-testid="drop-zone" style="border:2px dashed #888;padding:1rem">drop files here</div>
  <pre id="file-out" data-testid="file-out"></pre>
</section>

<section class="card">
  <a id="dl" data-testid="download-link" href="/api/download" download="report.txt">download report.txt</a>
  <button id="dl-blob" data-testid="download-blob">download generated blob</button>
</section>

<section class="card">
  <h2>File System Access</h2>
  <button id="open-picker" data-testid="open-picker">showOpenFilePicker()</button>
  <button id="save-picker" data-testid="save-picker">showSaveFilePicker()</button>
  <pre id="fsa-out" data-testid="fsa-out"></pre>
</section>

<section class="card">
  <h2>Media</h2>
  <video id="vid" data-testid="video" width="160" height="90" muted playsinline></video>
  <canvas id="paint" data-testid="paint-canvas" width="160" height="90"></canvas>
</section>
`,
      {
        surfaceId: "media-files",
        script: `
const fout = document.getElementById('file-out');
document.getElementById('file').addEventListener('change', (e) => {
  fout.textContent = [...e.target.files].map(f => f.name + ':' + f.size).join('\\n');
});
const drop = document.getElementById('drop');
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  fout.textContent = 'dropped:' + [...e.dataTransfer.files].map(f => f.name).join(',');
});
document.getElementById('dl-blob').addEventListener('click', () => {
  const blob = new Blob(['generated-content'], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'generated.txt'; a.click();
});
const fsaOut = document.getElementById('fsa-out');
document.getElementById('open-picker').addEventListener('click', async () => {
  try { const [h] = await window.showOpenFilePicker(); fsaOut.textContent = 'opened:' + h.name; }
  catch (e) { fsaOut.textContent = 'open-error:' + e; }
});
document.getElementById('save-picker').addEventListener('click', async () => {
  try { const h = await window.showSaveFilePicker(); const w = await h.createWritable(); await w.write('saved'); await w.close(); fsaOut.textContent = 'saved:' + h.name; }
  catch (e) { fsaOut.textContent = 'save-error:' + e; }
});
// A tiny animation so the canvas/video has motion to capture.
const ctx = document.getElementById('paint').getContext('2d');
let f = 0;
setInterval(() => { ctx.clearRect(0,0,160,90); ctx.fillStyle = '#0b6'; ctx.fillRect((f++ % 140), 30, 20, 20); }, 100);
`,
      },
    ),
  routes: [
    {
      method: "GET",
      path: "/api/download",
      handle: ({ res }) => {
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        res.end("download-file-contents");
      },
    },
  ],
};
