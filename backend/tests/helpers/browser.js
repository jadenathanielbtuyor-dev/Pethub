// Headless Chrome/Edge for the opt-in browser tests (PETHUB_BROWSER_TESTS=1), driven through the DevTools protocol
// with Node's built-in fetch and WebSocket (no extra dependency). Pages are opened from the frontend folder as files.
// MOCKED: each tab's fetch is replaced before any page script runs and answers API routes from the test's scenario;
// Railway, Vercel, Google Fonts and the icon CDN are blocked, so nothing leaves the machine.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const FRONTEND = path.join(__dirname, '..', '..', '..', 'frontend');

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

const browserPath = findBrowser();
const skip = process.env.PETHUB_BROWSER_TESTS !== '1'
  ? 'set PETHUB_BROWSER_TESTS=1 to run the headless browser checks'
  : (!browserPath ? 'Chrome or Edge not found (set CHROME_PATH)' : false);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageUrl = (file, query = '') => `${pathToFileURL(path.join(FRONTEND, file)).href}${query}`;

// Answers API calls from scenario.routes: { '/auth/login': { status, body, delay } }; anything else gets a 404
const FETCH_STUB = `(() => {
  window.__requests = [];
  const scenario = JSON.parse(localStorage.getItem('__scenario') || '{}');
  window.fetch = (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    const route = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    const method = (init.method || 'GET').toUpperCase();
    window.__requests.push({ method, route, body: init.body || null });
    const answer = (scenario.routes || {})[route] || { status: 404, body: { error: 'not stubbed ' + route } };
    return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(answer.body), { status: answer.status || 200, headers: { 'Content-Type': 'application/json' } })), answer.delay || 30));
  };
})();`;

// WCAG contrast helpers evaluated in the page: the text colour against the first opaque background behind it
const CONTRAST = `
  const luminance = color => { const [r, g, b] = color.match(/[\\d.]+/g).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const opaque = color => color && !/transparent/.test(color) && !/rgba\\([^)]*, 0(\\.0+)?\\)$/.test(color) && !/rgba/.test(color);
  const background = element => { for (let e = element; e; e = e.parentElement) { const color = getComputedStyle(e).backgroundColor; if (opaque(color)) return color; } return getComputedStyle(document.body).backgroundColor; };
  const ratioOf = (a, b) => { const x = luminance(a); const y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };`;

let browser = null;
let profileDir = '';
let debuggerOrigin = '';

async function startBrowser() {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pethub-browser-'));
  browser = spawn(browserPath, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-gpu', '--disable-extensions', 'about:blank'
  ], { stdio: 'ignore' });
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i += 1) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  debuggerOrigin = `http://127.0.0.1:${port}`;
}

// Waits for Chrome to exit before removing its profile: with several browser test files running at once, Windows can
// keep the profile's files locked for a moment after the kill
async function stopBrowser() {
  if (browser) {
    const exited = browser.exitCode !== null ? Promise.resolve() : new Promise(resolve => browser.once('exit', resolve));
    browser.kill();
    await Promise.race([exited, sleep(5000)]);
  }
  await sleep(300);
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

// session: a user object to sign in as (sessionStorage user + a placeholder token)
async function openTab({ url, scenario = {}, dark = false, width = 1280, height = 900, reducedMotion = false, session = null }) {
  const target = await (await fetch(`${debuggerOrigin}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve));
  let counter = 0;
  const pending = new Map();
  const errors = [];
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++counter;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); return; }
    if (message.method === 'Runtime.exceptionThrown') errors.push(String(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text).split('\n')[0]);
  });
  const evaluate = async expression => {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs = 5000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return true;
      } catch (error) {
        // The page may be navigating; try again
      }
      await sleep(50);
    }
    return false;
  };

  for (const domain of ['Page', 'Runtime', 'Network']) await send(`${domain}.enable`);
  await send('Network.setBlockedURLs', { urls: ['*railway.app*', '*vercel.app*', '*jsdelivr.net*', '*googleapis.com*', '*gstatic.com*'] });
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  if (reducedMotion) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const signIn = session
    ? `sessionStorage.setItem('authToken', 'test-token'); sessionStorage.setItem('user', ${JSON.stringify(JSON.stringify(session))});`
    : '';
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('darkMode', ${JSON.stringify(String(dark))}); localStorage.setItem('__scenario', ${JSON.stringify(JSON.stringify(scenario))}); ${signIn} } catch (e) {}\n${FETCH_STUB}`
  });
  await send('Page.navigate', { url });
  await waitFor('document.readyState === "complete"');

  const click = async selector => {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  };
  // A real key press: keyDown carries the typed character (Enter is "\r"), which is what activates a focused button
  const press = async (key, code = key, keyCode = 0, text = '') => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text, unmodifiedText: text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  };
  const type = async (selector, text) => {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select && el.select(); return true; })()`);
    if (text) await send('Input.insertText', { text });
  };
  const close = async () => {
    socket.close();
    await fetch(`${debuggerOrigin}/json/close/${target.id}`).catch(() => {});
  };
  return { evaluate, waitFor, click, press, type, errors, close, send };
}

module.exports = {
  FRONTEND,
  skip,
  sleep,
  pageUrl,
  CONTRAST,
  startBrowser,
  stopBrowser,
  openTab
};
