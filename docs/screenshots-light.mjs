/**
 * The light inbox shot, with no Emulation.setDeviceMetricsOverride at all --
 * the window is simply launched at the size we want. The emulation layer is the
 * prime suspect for the mixed-theme frames every other approach produced.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const OUT = process.argv[2] ?? ".";
const PORT = 9334;
const chrome = spawn("google-chrome-stable", [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--hide-scrollbars",
  "--no-first-run", "--no-default-browser-check",
  "--window-size=1420,790", "--force-device-scale-factor=1",
  "--user-data-dir=/tmp/claude-light-profile", "about:blank",
], { stdio: "ignore" });

const json = async (p) => { for (let i = 0; i < 60; i++) { try { return await (await fetch(`http://127.0.0.1:${PORT}${p}`)).json(); } catch { await sleep(250); } } throw new Error("no chrome"); };
const version = await json("/json/version");
let id = 1; const pending = new Map();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pending.has(x.id)) { const { resolve, reject } = pending.get(x.id); pending.delete(x.id); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result); } };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = id++; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);
await cmd("Page.enable"); await cmd("Runtime.enable");
const evaluate = async (expression) => {
  const r = await cmd("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const waitFor = async (expr, what, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await evaluate(`!!(${expr})`)) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
};

try {
  await cmd("Page.navigate", { url: "http://localhost:5173/" });
  await sleep(1500);
  console.log("viewport:", await evaluate(`window.innerWidth + 'x' + window.innerHeight`));
  await evaluate(`
    window.__set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})); };
    window.__btn = (t, r=document) => [...r.querySelectorAll('button')].find(b => b.textContent.trim() === t);
  `);
  await evaluate(`(() => {
    const i = [...document.querySelectorAll('input')];
    window.__set(i.find(x => x.type === 'text' || x.type === 'email'), 'demo@example.com');
    window.__set(document.querySelector('input[type=password]'), 'demo');
    window.__btn('Sign in').click();
  })()`);
  await waitFor("document.querySelectorAll('.msg-row').length > 2", "the message list");
  await sleep(1500);
  await evaluate(`(() => { const r = document.querySelectorAll('.msg-row'); if (r[1]) r[1].click(); })()`);
  await sleep(1500);

  // The app's own control, the way a user switches theme.
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /light mode/i.test(x.getAttribute('aria-label') || x.title || ''));
    if (b) b.click(); else document.documentElement.dataset.theme = 'light';
  })()`);
  await sleep(2000);
  const bg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  const topbar = await evaluate(`getComputedStyle(document.querySelector('.topbar')).backgroundColor`);
  console.log("body:", bg, "topbar:", topbar);
  if (parseInt(bg.match(/\d+/)[0], 10) < 200) throw new Error("page is not rendering light");

  const { data } = await cmd("Page.captureScreenshot", { format: "jpeg", quality: 82 });
  await writeFile(`${OUT}/inbox-light.jpg`, Buffer.from(data, "base64"));
  console.log("wrote inbox-light.jpg");
} finally { ws.close(); chrome.kill(); }
