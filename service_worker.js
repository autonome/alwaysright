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

// Cache the active tab. Populated via onActivated and rehydrated on demand
// in makeRight() after the service worker restarts — onActivated only fires
// on tab switches, not on SW wake.
let activeTabCache = null;
api.tabs.onActivated.addListener(async (activeInfo) => {
  activeTabCache = await api.tabs.get(activeInfo.tabId);
});

// Move the referenced tab to the immediate right of the active tab,
// or to the immediate right of the last pinned tab.
const makeRight = async newTab => {
  // No active tab cached — service worker was just woken up by this event.
  // Repopulate from the current window so we don't drop the first tab opened
  // after an SW restart.
  if (!activeTabCache) {
    const [t] = await api.tabs.query({ active: true, windowId: newTab.windowId });
    if (!t) return;
    activeTabCache = t;
  }

  // Refetch — tab references go STALE. Dammit.
  let activeTab;
  try {
    activeTab = await api.tabs.get(activeTabCache.id);
  } catch (e) { return; }

  // The new tab either dragged to new window or something went wrong.
  if (newTab.windowId != activeTab.windowId) {
    return;
  }

  // To the right
  let targetIndex = activeTab.index + 1;

  // We need current window for a few things required for correct tab placement.
  const win = await api.windows.get(newTab.windowId, { populate: true });

  // If the active tab is pinned, we have to set the target index
  // to that of the first non-pinned tab.
  if (activeTab.pinned) {
    targetIndex = getFirstNonPinnedTab(win).index;
  }

  // Refetch — the event-payload index is stale by now.
  let freshNewTab;
  try {
    freshNewTab = await api.tabs.get(newTab.id);
  } catch (e) { return; }

  // Only bother moving if it wouldn't organically be placed immediately to the
  // right of the active tab.
  if (freshNewTab.index == targetIndex) {
    return;
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
