// `dialogs` — alert/confirm/prompt triggers for set_dialog_policy. Each button
// fires the dialog and reflects the outcome so an exercise can assert the policy
// (accept/dismiss/respond) took effect.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const dialogs: Surface = {
  id: "dialogs",
  path: "/dialogs",
  title: "Dialogs surface",
  blurb: "alert / confirm / prompt + beforeunload, with outcome readout",
  html: () =>
    doc(
      "Dialogs surface",
      `
<section class="card">
  <button id="do-alert" data-testid="do-alert">alert()</button>
  <button id="do-confirm" data-testid="do-confirm">confirm()</button>
  <button id="do-prompt" data-testid="do-prompt">prompt()</button>
  <output id="out" data-status data-testid="dialog-out">none</output>
</section>
`,
      {
        surfaceId: "dialogs",
        script: `
const out = document.getElementById('out');
document.getElementById('do-alert').addEventListener('click', () => {
  alert('alert-fired');
  out.textContent = 'alert-returned';
});
document.getElementById('do-confirm').addEventListener('click', () => {
  const ok = confirm('confirm-question');
  out.textContent = 'confirm:' + ok;
});
document.getElementById('do-prompt').addEventListener('click', () => {
  const v = prompt('prompt-question', 'default-answer');
  out.textContent = 'prompt:' + v;
});
`,
      },
    ),
};
