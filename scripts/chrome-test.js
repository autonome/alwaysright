#!/usr/bin/env node
// Launch a headed Chrome instance with the extension loaded in a temp profile.
// Usage: node scripts/chrome-test.js

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const extPath = path.resolve(__dirname, '..');

// Ensure Chrome manifest is active
fs.copyFileSync(
  path.join(extPath, 'manifest-chrome.json'),
  path.join(extPath, 'manifest.json')
);

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alwaysright-manual-'));

(async () => {
  console.log('Launching Chrome with Always Right extension...');
  console.log(`Temp profile: ${userDataDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  // Keep alive until the user closes the browser
  context.on('close', () => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    console.log('Browser closed.');
    process.exit(0);
  });
})();
