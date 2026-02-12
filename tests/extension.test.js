const { test, expect } = require('@playwright/test');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..');

let server;
let baseUrl;

test.beforeAll(async () => {
  // Create test service worker: original + hooks to access activeTabCache
  const swSource = fs.readFileSync(path.join(EXT_PATH, 'service_worker.js'), 'utf8');
  fs.writeFileSync(
    path.join(EXT_PATH, 'test_service_worker.js'),
    swSource + '\nself.__test = { getCache: () => activeTabCache, resetCache: () => { activeTabCache = null; } };\n'
  );

  // Test manifest: Chrome + tabs permission + test service worker
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXT_PATH, 'manifest-chrome.json'), 'utf8')
  );
  manifest.permissions = ['tabs'];
  manifest.background.service_worker = 'test_service_worker.js';
  fs.writeFileSync(
    path.join(EXT_PATH, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );

  // Local HTTP server for identifiable tab URLs
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<title>${req.url}</title>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => {
  server?.close();
  try { fs.unlinkSync(path.join(EXT_PATH, 'test_service_worker.js')); } catch {}
});

// --- Helpers ---

async function launch(userDataDir) {
  return chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
}

async function getServiceWorker(ctx) {
  return ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
}

async function getTabUrls(sw) {
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.sort((a, b) => a.index - b.index).map(t => t.url);
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'alwaysright-test-'));
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// --- Tests ---

test.describe('basic behavior', () => {
  test('new tab opens to the right of the active tab', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);

      // Build tab strip: [/a, /b, /c]
      await ctx.pages()[0].goto(`${baseUrl}/a`);
      const pageB = await ctx.newPage();
      await pageB.goto(`${baseUrl}/b`);
      const pageC = await ctx.newPage();
      await pageC.goto(`${baseUrl}/c`);

      // /c is active — switch to /a
      await ctx.pages()[0].bringToFront();
      await delay(500);

      // New tab should land at index 1 (right of /a)
      await ctx.newPage();
      await delay(500);

      const urls = await getTabUrls(sw);
      expect(urls).toHaveLength(4);
      expect(urls[0]).toContain('/a');
      expect(urls[1]).not.toContain(baseUrl); // new blank tab
      expect(urls[2]).toContain('/b');
      expect(urls[3]).toContain('/c');
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('new tab after switching to a different tab', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);

      // Build tab strip: [/a, /b, /c]
      await ctx.pages()[0].goto(`${baseUrl}/a`);
      const pageB = await ctx.newPage();
      await pageB.goto(`${baseUrl}/b`);
      const pageC = await ctx.newPage();
      await pageC.goto(`${baseUrl}/c`);

      // Switch to /b (middle tab)
      await pageB.bringToFront();
      await delay(500);

      // New tab should land at index 2 (right of /b)
      await ctx.newPage();
      await delay(500);

      const urls = await getTabUrls(sw);
      expect(urls).toHaveLength(4);
      expect(urls[0]).toContain('/a');
      expect(urls[1]).toContain('/b');
      expect(urls[2]).not.toContain(baseUrl); // new blank tab
      expect(urls[3]).toContain('/c');
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('startup guard (session restore simulation)', () => {
  test('tabs created before onActivated are not reordered', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);

      // Reset cache to null to simulate startup state (before any onActivated).
      // In headless mode the cache may already be null; this ensures it regardless.
      await sw.evaluate(() => self.__test.resetCache());

      // Create tabs with active:false — like session restore does.
      // With null cache, makeRight() should return early and NOT move them.
      await sw.evaluate(async (base) => {
        for (const id of ['s1', 's2', 's3', 's4', 's5']) {
          await chrome.tabs.create({ url: `${base}/${id}`, active: false });
        }
      }, baseUrl);
      await delay(500);

      const urls = await getTabUrls(sw);
      const restored = urls.filter(u => u.includes('/s'));

      // Tabs should be in creation order — none were moved
      expect(restored.map(u => u.split('/').pop())).toEqual(['s1', 's2', 's3', 's4', 's5']);
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('new tab works after activation following simulated restore', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);

      // Set up tabs: [/a, /b, /c]
      await ctx.pages()[0].goto(`${baseUrl}/a`);
      const p2 = await ctx.newPage();
      await p2.goto(`${baseUrl}/b`);
      const p3 = await ctx.newPage();
      await p3.goto(`${baseUrl}/c`);

      // Reset cache to simulate startup
      await sw.evaluate(() => self.__test.resetCache());

      // Create "restored" tabs — should NOT be moved (cache is null)
      await sw.evaluate(async (base) => {
        await chrome.tabs.create({ url: `${base}/s1`, active: false });
        await chrome.tabs.create({ url: `${base}/s2`, active: false });
      }, baseUrl);
      await delay(500);

      // Now switch to /a — this fires onActivated, populating the cache
      await ctx.pages()[0].bringToFront();
      await delay(500);

      // Create a new tab — extension should be active again
      await ctx.newPage();
      await delay(500);

      const urls = await getTabUrls(sw);
      const aIdx = urls.findIndex(u => u.includes('/a'));

      // New blank tab should be right after /a
      expect(urls[aIdx + 1]).not.toContain(baseUrl);
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
