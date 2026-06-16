// `forms` — the action/input surface. Exercises click, fill, press, shortcut,
// hover, select, choose_option, fill_form, wait_for, clipboard copy/paste, and a
// contenteditable. A submit reflects values into a result region for verify_*.
import type { Surface } from "../types.js";
import { doc } from "../html.js";

export const forms: Surface = {
  id: "forms",
  path: "/forms",
  title: "Forms & input surface",
  blurb: "text/select/checkbox/radio/range inputs, clipboard field, contenteditable",
  html: () =>
    doc(
      "Forms & input surface",
      `
<form id="signup" class="card" data-testid="signup">
  <label>Name <input name="name" data-testid="name" autocomplete="off" /></label><br/>
  <label>Email <input name="email" type="email" data-testid="email" /></label><br/>
  <label>Password <input name="password" type="password" data-testid="password" /></label><br/>
  <label>Bio <textarea name="bio" data-testid="bio"></textarea></label><br/>
  <label>Role
    <select name="role" data-testid="role">
      <option value="">--</option>
      <option value="admin">Admin</option>
      <option value="editor">Editor</option>
      <option value="viewer">Viewer</option>
    </select>
  </label><br/>
  <fieldset>
    <legend>Notify</legend>
    <label><input type="checkbox" name="email_notify" data-testid="email-notify" /> Email</label>
    <label><input type="checkbox" name="sms_notify" data-testid="sms-notify" /> SMS</label>
  </fieldset>
  <fieldset>
    <legend>Plan</legend>
    <label><input type="radio" name="plan" value="free" data-testid="plan-free" /> Free</label>
    <label><input type="radio" name="plan" value="pro" data-testid="plan-pro" /> Pro</label>
  </fieldset>
  <label>Volume <input type="range" name="volume" min="0" max="100" value="50" data-testid="volume" /></label><br/>
  <button type="button" id="hover-btn" data-testid="hover-btn">Hover me</button>
  <span id="hover-out" data-status data-testid="hover-out">not hovered</span><br/>
  <button type="submit" data-testid="submit">Submit</button>
</form>

<pre id="result" class="card" data-testid="result"></pre>

<section class="card">
  <h2>Clipboard</h2>
  <input id="clip-src" data-testid="clip-src" value="copy-this-payload" />
  <input id="clip-dst" data-testid="clip-dst" placeholder="paste here" />
</section>

<section class="card">
  <h2>Contenteditable</h2>
  <div id="rich" contenteditable="true" data-testid="rich">editable text</div>
</section>
`,
      {
        surfaceId: "forms",
        script: `
const form = document.getElementById('signup');
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  document.getElementById('result').textContent = JSON.stringify(data, null, 2);
  document.getElementById('result').setAttribute('data-submitted', '1');
});
const hb = document.getElementById('hover-btn');
hb.addEventListener('mouseenter', () => { document.getElementById('hover-out').textContent = 'hovered'; });
hb.addEventListener('mouseleave', () => { document.getElementById('hover-out').textContent = 'not hovered'; });
`,
      },
    ),
};
