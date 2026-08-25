/**
 * Regenerates the README screenshots from the mock server.
 *
 * Run the mock stack first (`npm run dev:mock`), then:
 *   node docs/screenshots.mjs docs/screenshots
 *
 * Restart the mock before a run: the filters shot creates rules, and a second
 * run against the same mock would show them twice.
 *
 * The mobile shot is not taken here. Run at the tail of this sequence it would
 * not render the message list at 500px within the wait, and chasing that down
 * was not worth it for a screenshot -- take it with a short run of its own.
 *
 * Drives headless Chrome over CDP rather than the extension, so the viewport is
 * exactly the size the existing images use (1420x703, mobile 500x703) instead of
 * whatever the window happens to be.
 *
 * Usage: node shots.mjs <out-dir>   (mock stack must be up on :5173)
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = process.argv[2];
if (!OUT) { console.error("usage: node shots.mjs <out-dir>"); process.exit(2); }
await mkdir(OUT, { recursive: true });

const PORT = 9333;
const chrome = spawn("google-chrome-stable", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars",
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  `--user-data-dir=/tmp/claude-shots-profile`, "about:blank",
], { stdio: "ignore" });

const json = async (path) => {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}${path}`)).json(); }
    catch { await sleep(250); }
  }
  throw new Error("Chrome did not come up");
};
const version = await json("/json/version");

let nextId = 1;
const pending = new Map();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);
await cmd("Page.enable");
await cmd("Runtime.enable");

const metrics = (width, height, mobile = false) =>
  cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });

const go = async (url) => { await cmd("Page.navigate", { url }); await sleep(1200); };
const evaluate = async (expression) => {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
/** Polls a predicate inside the page until it is true, or gives up loudly. */
const waitFor = async (jsExpr, what, ms = 15000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await evaluate(`!!(${jsExpr})`)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const shot = async (name) => {
  const { data } = await cmd("Page.captureScreenshot", { format: "jpeg", quality: 82 });
  await writeFile(`${OUT}/${name}`, Buffer.from(data, "base64"));
  console.log("  wrote", name);
};

// Helpers injected into the page: React-controlled inputs need the native setter.
const HELPERS = `
  window.__set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
  window.__btn = (txt, root=document) => [...root.querySelectorAll('button')].find(b => b.textContent.trim() === txt);
  window.__click = (sel) => { const el = document.querySelector(sel); if (el) el.click(); return !!el; };
  window.__sel = (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
`;

try {
  console.log("chrome:", version.Browser);

  // --- login (taller, as the existing shot is) ---
  await metrics(1420, 759);
  await go("http://localhost:5173/");
  await evaluate(HELPERS);
  await sleep(600);
  await shot("login.jpg");

  // --- sign in (a fresh profile prefills nothing, so both fields) ---
  await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const user = inputs.find(i => i.type === 'text' || i.type === 'email');
    const pw = document.querySelector('input[type=password]');
    window.__set(user, 'demo@example.com');
    window.__set(pw, 'demo');
    window.__btn('Sign in').click();
  })()`);
  await waitFor("document.querySelector('.msg-row') || document.querySelector('.nav-item')", "the app after sign-in");
  await sleep(1500);

  // --- inbox, dark, with a conversation open ---
  await metrics(1420, 703);
  await go("http://localhost:5173/mail");
  await evaluate(HELPERS);
  await waitFor("document.querySelectorAll('.msg-row').length > 2", "the message list");
  await evaluate(`(() => { const r = document.querySelectorAll('.msg-row'); if (r[1]) r[1].click(); })()`);
  await sleep(1800);
  await shot("inbox-dark.jpg");

  // --- the reply composer, still on the dark theme ---
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^reply$/i.test(x.getAttribute('aria-label')||'') || /^reply$/i.test(x.textContent.trim()));
    if (b) b.click();
  })()`);
  await sleep(1800);
  await shot("compose.jpg");
  await evaluate(`(() => { const c = [...document.querySelectorAll('button')].find(b => /close|discard/i.test(b.getAttribute('aria-label')||'')); if (c) c.click(); })()`);
  await sleep(800);

  // --- same inbox in the light theme ---
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /light mode/i.test(x.getAttribute('aria-label')||x.title||'')); if (b) b.click(); })()`);
  await sleep(1200);
  await shot("inbox-light.jpg");
  // back to dark for the rest
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => /dark mode/i.test(x.getAttribute('aria-label')||x.title||'')); if (b) b.click(); })()`);
  await sleep(900);

  // --- calendar ---
  await go("http://localhost:5173/calendar");
  await waitFor("document.querySelector('.cal-grid, .calendar, [class*=cal]')", "the calendar");
  await evaluate(HELPERS);
  // The README caption promises the month view.
  await evaluate(`(() => { const b = window.__btn('Month'); if (b) b.click(); })()`);
  await sleep(1800);
  await shot("calendar.jpg");

  // --- contacts ---
  await go("http://localhost:5173/contacts");
  await waitFor("document.querySelector('[class*=contact]')", "the contact list");
  // Open someone, so the detail pane is not an empty "Select a contact".
  await evaluate(`(() => {
    const row = [...document.querySelectorAll('[class*=contact-row], [class*=contact-item], li, div')]
      .find(e => /ada@example\.org/.test(e.textContent || '') && e.querySelector('*') === null || /Ada Lovelace/.test((e.textContent||'').slice(0,40)));
    if (row) row.click();
  })()`);
  await sleep(1800);
  await shot("contacts.jpg");

  // --- filters, with rules that actually say something ---
  await go("http://localhost:5173/settings/filters");
  await evaluate(HELPERS);
  await waitFor("[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New rule')", "the filters editor");
  await evaluate(`(async () => {
    const wait = (ms=350) => new Promise(r => setTimeout(r, ms));
    const rules = [
      { name: 'Newsletters',   field: 'list-id', op: 'exists',   value: '',                folder: 'Newsletters' },
      { name: 'From the boss', field: 'from',    op: 'contains', value: 'ada@example.org', folder: 'Work' },
      { name: 'Receipts',      field: 'subject', op: 'contains', value: 'invoice',         folder: 'Archive' },
      { name: 'Build failures',field: 'subject', op: 'matches',  value: '*FAILED*',        folder: 'Work' },
    ];
    for (const r of rules) {
      window.__btn('New rule').click(); await wait();
      const d = document.querySelector('.dialog');
      window.__set(d.querySelector('input.input'), r.name); await wait(120);
      const row = d.querySelector('.rule-row');
      const sels = row.querySelectorAll('select');
      window.__sel(sels[0], r.field); await wait(120);
      const sels2 = d.querySelector('.rule-row').querySelectorAll('select');
      if (sels2[1]) { window.__sel(sels2[1], r.op); await wait(120); }
      const val = [...d.querySelector('.rule-row').querySelectorAll('input.input')].pop();
      if (val && r.value) { window.__set(val, r.value); await wait(120); }
      const arow = d.querySelector('.rule-row.actions');
      const asels = arow.querySelectorAll('select');
      if (asels[1]) { window.__sel(asels[1], r.folder); await wait(120); }
      window.__btn('Done', d).click(); await wait();
    }
    const save = window.__btn('Save filters'); if (save && !save.disabled) save.click();
    await wait(1500);
    // Clear the "Filters saved" toast so it does not sit over a rule.
    document.querySelectorAll('.toast, [class*=toast]').forEach(t => t.remove());
  })()`);
  await sleep(1200);
  await shot("filters.jpg");

  // (mobile is captured separately by shots-mobile.mjs)

  console.log("done");
} finally {
  ws.close();
  chrome.kill();
}
