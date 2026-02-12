// browser (Firefox) vs chrome (Chromium)
const isChrome = typeof chrome != 'undefined';
const api = isChrome ? chrome : browser;

// attempt working around poor chrome behavior due to
// https://issues.chromium.org/issues/40805401
if (isChrome) {
  // https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
  const keepAlive = () => {
    setInterval(api.runtime.getPlatformInfo, 20000);
  };
  api.runtime.onStartup.addListener(keepAlive);
  keepAlive();
}

// new firefoxen have a setting for this
const tryBrowserPref = async () =>{
  // Test for the settings API and the setting itself
  if (!api.hasOwnProperty('browserSettings')
      || !api.browserSettings.hasOwnProperty('newTabPosition')) {
    return false;
  }

  // Update the setting value to always add to the right
  // even if already set.
  await api.browserSettings.newTabPosition.set({ value: 'afterCurrent' });

  return true;
};

// Cache the active tab. Populated only via onActivated, so it stays null
// until Chrome activates a tab — which naturally gates makeRight() during
// session restore (onCreated fires before onActivated).
let activeTabCache = null;
api.tabs.onActivated.addListener(async (activeInfo) => {
  activeTabCache = await api.tabs.get(activeInfo.tabId);
});

// Move the referenced tab to the immediate right of the active tab,
// or to the immediate right of the last pinned tab.
const makeRight = async newTab => {
  // No active tab yet — still in session restore or pre-interaction.
  if (!activeTabCache) return;

  const activeTab = activeTabCache;

  // The new tab either dragged to new window or something went wrong.
  if (newTab.windowId != activeTab.windowId) {
    return;
  }

  // To the right
  let targetIndex = activeTab.index + 1;

  // Only bother moving if it wouldn't organically be placed immediately to the
  // right of the active tab.
  if (newTab.index == targetIndex) {
    return;
  }

  // We need current window for a few things required for correct tab placement.
  // And apparently tab references go STALE. Dammit.
  const win = await api.windows.getCurrent({ populate: true });

  // Maybe is a restored tab, or another add-on, or something else is wonky.
  if (newTab.index < win.tabs.length - 1 || newTab.index > win.tabs.length - 1) {
    return;
  }

  // If the active tab is pinned, we have to set the target index
  // to that of the first non-pinned tab.
  if (activeTab.pinned) {
    targetIndex = getFirstNonPinnedTab(win).index;
  }

  // YOU GOT TO MOVE IT MOVE IT
  try {
    await api.tabs.move(newTab.id, { index: targetIndex });
  } catch (e) {
    console.error('AlwaysRight: tab move fail', e);
  }
}

// Return a tab object for the first non-pinned tab in the tab strip
// for the given window.
const getFirstNonPinnedTab = win => {
  for (const tab of win.tabs) {
    if (!tab.pinned) {
      return tab;
    }
  }
}

// Try native Firefox setting (fire-and-forget for Firefox, no-op on Chrome)
tryBrowserPref();

// Always register manual tab management as fallback.
// On Firefox with browserSettings support, the tab is already placed correctly
// and makeRight() returns early via the targetIndex check.
api.tabs.onCreated.addListener(makeRight);
