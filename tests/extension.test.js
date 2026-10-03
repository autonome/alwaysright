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
    swSource + `
self.__test = {
  // Simulate a fresh browser session: gate closed, no state persisted.
  resetGate: () => clearGate(),
  // Simulate MV3 service-worker termination: in-memory state is lost,
  // storage.session survives.
  simulateRestart: () => { gateOpen = false; activeTabsPromise = null; },
};
`
  );

  // Test manifest: Chrome + tabs permission + test service worker
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXT_PATH, 'manifest-chrome.json'), 'utf8')
  );
  manifest.permissions = [...new Set([...manifest.permissions, 'tabs'])];
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

      // Close the gate to simulate startup state (before any user activation).
      await sw.evaluate(() => self.__test.resetGate());

      // Create tabs with active:false — like session restore does.
      // With the gate closed, makeRight() should return early and NOT move them.
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

      // Close the gate to simulate startup
      await sw.evaluate(() => self.__test.resetGate());

      // Create "restored" tabs — should NOT be moved (gate is closed)
      await sw.evaluate(async (base) => {
        await chrome.tabs.create({ url: `${base}/s1`, active: false });
        await chrome.tabs.create({ url: `${base}/s2`, active: false });
      }, baseUrl);
      // Wait out the creation-burst window so the switch below reads as a
      // user action rather than part of the restore.
      await delay(1500);

      // Now switch to /a — this fires onActivated, opening the gate
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

// Build [/a, /b, /c] in the first window and let the gate open.
async function setupABC(ctx) {
  await ctx.pages()[0].goto(`${baseUrl}/a`);
  const pageB = await ctx.newPage();
  await pageB.goto(`${baseUrl}/b`);
  const pageC = await ctx.newPage();
  await pageC.goto(`${baseUrl}/c`);
  await delay(1500);
  await ctx.pages()[0].bringToFront();
  await delay(500);
  return { pageA: ctx.pages()[0], pageB, pageC };
}

test.describe('active tab tracking', () => {
  test('tab switch right after a burst of new tabs is not ignored', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);
      const { pageC } = await setupABC(ctx);

      // Quickly open several background tabs, then immediately switch tabs.
      await sw.evaluate(async (base) => {
        for (const id of ['x1', 'x2', 'x3']) {
          await chrome.tabs.create({ url: `${base}/${id}`, active: false });
        }
      }, baseUrl);
      await pageC.bringToFront();
      await delay(500);

      await ctx.newPage();
      await delay(500);

      const urls = await getTabUrls(sw);
      const cIdx = urls.findIndex(u => u.endsWith('/c'));
      expect(urls[cIdx + 1]).not.toContain(baseUrl);
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('new tab is placed relative to its own window after switching windows', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);
      await setupABC(ctx);

      // Open and use a second window, then create a tab back in the first.
      const placed = await sw.evaluate(async (base) => {
        const [first] = await chrome.tabs.query({ url: `${base}/a` });
        await chrome.windows.create({ url: `${base}/w2` });
        await new Promise(r => setTimeout(r, 500));
        const t = await chrome.tabs.create({ windowId: first.windowId, url: `${base}/new` });
        await new Promise(r => setTimeout(r, 500));
        const tabs = await chrome.tabs.query({ windowId: first.windowId });
        return tabs.sort((a, b) => a.index - b.index).map(t => t.url);
      }, baseUrl);

      expect(placed.map(u => u.split('/').pop())).toEqual(['a', 'new', 'b', 'c']);
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('first new tab after a service-worker restart is placed correctly', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);
      await setupABC(ctx);

      await sw.evaluate(() => self.__test.simulateRestart());

      await ctx.newPage();
      await delay(500);

      const urls = await getTabUrls(sw);
      expect(urls).toHaveLength(4);
      expect(urls[0]).toContain('/a');
      expect(urls[1]).not.toContain(baseUrl);
      expect(urls[2]).toContain('/b');
      expect(urls[3]).toContain('/c');
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('tab groups', () => {
  test('new tab is not moved into the middle of a group', async () => {
    const dir = makeTempDir();
    const ctx = await launch(dir);

    try {
      const sw = await getServiceWorker(ctx);
      const { pageB } = await setupABC(ctx);

      // Strip: [/a, (/b, /c grouped)] — activate /b, the first tab in the group.
      const groupId = await sw.evaluate(async (base) => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const ids = tabs.filter(t => /\/(b|c)$/.test(t.url)).map(t => t.id);
        return chrome.tabs.group({ tabIds: ids });
      }, baseUrl);
      await pageB.bringToFront();
      await delay(500);

      // Create an ungrouped tab at the end of the strip.
      const newId = await sw.evaluate(async (base) => {
        const t = await chrome.tabs.create({ url: `${base}/new` });
        return t.id;
      }, baseUrl);
      await delay(500);

      const result = await sw.evaluate(async (id) => {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        return {
          urls: tabs.sort((a, b) => a.index - b.index).map(t => t.url.split('/').pop()),
          newGroup: (await chrome.tabs.get(id)).groupId,
        };
      }, newId);

      expect(result.newGroup).toBe(-1);
      expect(result.urls).toEqual(['a', 'b', 'c', 'new']);
      expect(groupId).toBeGreaterThan(-1);
    } finally {
      await ctx.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
