// browser (Firefox) vs chrome (Chromium)
const isChrome = typeof chrome != 'undefined';
const api = isChrome ? chrome : browser;

// attempt working around poor chrome behavior due to
// https://issues.chromium.org/issues/40805401
if (isChrome) {
  // https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
  setInterval(api.runtime.getPlatformInfo, 20000);
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

// "User has activated a tab since the last browser cold start" flag.
// Used to gate makeRight() during session restore — Chrome auto-activates
// the active restored tab during session restore, so we can't trust a bare
// onActivated as a "user has interacted" signal. Stored in storage.session
// so the gate survives MV3 service-worker termination but is cleared on
// browser restart (or when the last window closes, for the case where
// Chrome's background process keeps the session alive).
const ACTIVATED_KEY = 'userHasActivated';
const clearGate = async () => {
  try { await api.storage.session.remove(ACTIVATED_KEY); } catch (e) {}
};
api.runtime.onStartup.addListener(clearGate);
api.windows.onRemoved.addListener(async () => {
  try {
    const wins = await api.windows.getAll();
    if (wins.length === 0) await clearGate();
  } catch (e) {}
});

const isInGroup = tab => tab.groupId !== undefined && tab.groupId !== -1;
const safeGetTab = id => api.tabs.get(id).catch(() => null);

// Track recent onCreated events so we can distinguish a session-restore
// burst (many creations in quick succession) from a single user-initiated
// new tab (Ctrl+T, middle-click, etc).
let recentCreations = [];
const isInCreationBurst = () => {
  const now = Date.now();
  recentCreations = recentCreations.filter(ts => now - ts < 1000);
  return recentCreations.length >= 3;
};

// Inter-event quiescence threshold: if no new onCreated event arrives within
// this window, the event stream has settled and we can decide whether the
// preceding activity was a session-restore burst or a single user action.
// This is a small upper bound on the gap between consecutive Chrome-
// dispatched onCreated events during a burst — nothing depends on the
// burst's *total* duration, only on inter-event gaps.
const QUIESCENCE_MS = 50;

// A pending decision triggered by an onActivated, waiting for event
// quiescence before opening the gate. onCreated handlers reset its timer
// so the wait extends across an entire burst, however long.
let pendingActivation = null;

const scheduleActivationDecision = (activeInfo) => {
  if (pendingActivation) clearTimeout(pendingActivation.timerId);
  const timerId = setTimeout(async () => {
    pendingActivation = null;
    if (isInCreationBurst()) return;
    try {
      await api.storage.session.set({ [ACTIVATED_KEY]: true });
      activeTabCache = await api.tabs.get(activeInfo.tabId);
    } catch (e) { /* tab closed mid-activation */ }
  }, QUIESCENCE_MS);
  pendingActivation = { activeInfo, timerId };
};

// Cache the active tab. Populated via the activation decision above and
// rehydrated on demand in makeRight() after the service worker restarts.
let activeTabCache = null;
api.tabs.onActivated.addListener(scheduleActivationDecision);

// Move the referenced tab to the immediate right of the active tab,
// or to the immediate right of the last pinned tab.
const makeRight = async newTab => {
  recentCreations.push(Date.now());
  // Bound the array — isInCreationBurst() filters lazily, so under sustained
  // tab creation without intervening onActivated events it could grow.
  if (recentCreations.length > 50) {
    const cutoff = Date.now() - 1000;
    recentCreations = recentCreations.filter(ts => ts >= cutoff);
  }

  // Extend any pending activation decision: a new onCreated means the event
  // stream isn't quiet yet, so the gate decision should keep waiting.
  if (pendingActivation) {
    scheduleActivationDecision(pendingActivation.activeInfo);
  }

  // Never yank a tab out of a tab group. Catches Chrome placing a new tab
  // inside an existing group (Ctrl+T while focused on a grouped tab).
  if (isInGroup(newTab)) return;

  // Don't run during session restore: the gate stays closed until the user
  // has actually activated a tab post-restore.
  const { [ACTIVATED_KEY]: ready } = await api.storage.session.get(ACTIVATED_KEY);
  if (!ready) return;

  // No active tab cached — service worker was just woken up by this event.
  // Repopulate from the current window so we don't drop the first tab opened
  // after an SW restart.
  if (!activeTabCache) {
    const [t] = await api.tabs.query({ active: true, windowId: newTab.windowId });
    if (!t) return;
    activeTabCache = t;
  }

  // Refetch — tab references go STALE. Dammit.
  const [activeTab, freshNewTab] = await Promise.all([
    safeGetTab(activeTabCache.id),
    safeGetTab(newTab.id),
  ]);
  if (!activeTab || !freshNewTab) return;

  // The new tab either dragged to new window or something went wrong.
  if (newTab.windowId != activeTab.windowId) {
    return;
  }

  // Re-check groupId against the fresh fetch. During session restore, grouped
  // tabs come in with groupId=-1 at onCreated and get assigned a group via
  // onUpdated milliseconds later — if the tab is now in a group, leave it.
  if (isInGroup(freshNewTab)) return;

  // To the right
  let targetIndex = activeTab.index + 1;

  // If the active tab is pinned, we have to set the target index
  // to that of the first non-pinned tab.
  if (activeTab.pinned) {
    const win = await api.windows.get(newTab.windowId, { populate: true });
    targetIndex = getFirstNonPinnedTab(win).index;
  }

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
