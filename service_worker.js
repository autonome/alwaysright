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

// storage.session lets state survive MV3 service-worker termination while
// still being cleared on browser restart. It needs the "storage" permission
// and Firefox 115+; without it we fall back to in-memory state only.
const sessionStore = api.storage && api.storage.session;
const sessionGet = async key => {
  if (!sessionStore) return undefined;
  try { return (await sessionStore.get(key))[key]; } catch (e) { return undefined; }
};
const sessionSet = async (key, value) => {
  if (!sessionStore) return;
  try { await sessionStore.set({ [key]: value }); } catch (e) {}
};
const sessionRemove = async key => {
  if (!sessionStore) return;
  try { await sessionStore.remove(key); } catch (e) {}
};

// "User has activated a tab since the last browser cold start" gate.
// Used to keep makeRight() out of session restore — Chrome auto-activates
// the active restored tab during session restore, so we can't trust a bare
// onActivated as a "user has interacted" signal. Cleared on browser restart
// (or when the last window closes, for the case where Chrome's background
// process keeps the session alive).
const ACTIVATED_KEY = 'userHasActivated';
let gateOpen = false;
const isGateOpen = async () =>
  gateOpen || (gateOpen = !!(await sessionGet(ACTIVATED_KEY)));
const openGate = async () => {
  gateOpen = true;
  await sessionSet(ACTIVATED_KEY, true);
};
const clearGate = async () => {
  gateOpen = false;
  await sessionRemove(ACTIVATED_KEY);
};
api.runtime.onStartup.addListener(clearGate);

// Per-window record of the active tab and the tab active before it:
// { [windowId]: { current, previous } }. This is tracked on every
// onActivated, independently of the gate, so it never goes stale.
// A tab opened in the foreground (Ctrl+T) is activated around the same time
// as its onCreated, in either order, so makeRight() uses `previous` when
// `current` is the new tab itself. Mirrored to storage.session so the first
// tab opened after a service-worker restart is still placed correctly.
const ACTIVE_TABS_KEY = 'activeTabs';
let activeTabsPromise = null;
const getActiveTabs = () =>
  activeTabsPromise || (activeTabsPromise = sessionGet(ACTIVE_TABS_KEY).then(v => v || {}));

api.windows.onRemoved.addListener(async windowId => {
  const activeTabs = await getActiveTabs();
  delete activeTabs[windowId];
  sessionSet(ACTIVE_TABS_KEY, activeTabs);
  try {
    const wins = await api.windows.getAll();
    if (wins.length === 0) await clearGate();
  } catch (e) {}
});

const isInGroup = tab => tab.groupId !== undefined && tab.groupId !== -1;

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

// A pending gate decision triggered by an onActivated, waiting for event
// quiescence. onCreated handlers reset its timer so the wait extends across
// an entire burst, however long. This only decides whether to open the gate;
// active-tab tracking above happens regardless.
let gateTimer = null;
const scheduleGateDecision = () => {
  clearTimeout(gateTimer);
  gateTimer = setTimeout(() => {
    gateTimer = null;
    if (!isInCreationBurst()) openGate();
  }, QUIESCENCE_MS);
};

api.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!gateOpen) scheduleGateDecision();
  const activeTabs = await getActiveTabs();
  const rec = activeTabs[windowId] || {};
  if (rec.current !== tabId) {
    activeTabs[windowId] = { current: tabId, previous: rec.current };
    sessionSet(ACTIVE_TABS_KEY, activeTabs);
  }
});

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

  // Extend any pending gate decision: a new onCreated means the event
  // stream isn't quiet yet, so the decision should keep waiting.
  if (gateTimer) scheduleGateDecision();

  // Never yank a tab out of a tab group. Catches Chrome placing a new tab
  // inside an existing group (Ctrl+T while focused on a grouped tab).
  if (isInGroup(newTab)) return;

  try {
    // Don't run during session restore: the gate stays closed until the user
    // has actually activated a tab post-restore.
    if (!(await isGateOpen())) return;

    const rec = (await getActiveTabs())[newTab.windowId];
    if (!rec) return;
    const activeId = rec.current === newTab.id ? rec.previous : rec.current;
    if (activeId === undefined) return;

    // Refetch — tab references go STALE. Dammit. Take both tabs from one
    // window snapshot so their indexes are consistent with each other.
    const win = await api.windows.get(newTab.windowId, { populate: true });
    const activeTab = win.tabs.find(t => t.id === activeId);
    const freshNewTab = win.tabs.find(t => t.id === newTab.id);

    // Either tab closed, or was dragged to another window.
    if (!activeTab || !freshNewTab) return;

    // Re-check groupId against the fresh fetch. During session restore, grouped
    // tabs come in with groupId=-1 at onCreated and get assigned a group via
    // onUpdated milliseconds later — if the tab is now in a group, leave it.
    if (isInGroup(freshNewTab)) return;

    // Skip tabs Chrome placed somewhere specific. A fresh user-initiated tab
    // (Ctrl+T, click "+") always lands at the end of the strip; anything else
    // (Ctrl+Shift+T or "Reopen closed tab" restoring to original position,
    // middle-click placed adjacent to opener) represents intentional placement
    // that we shouldn't override.
    if (freshNewTab.index !== win.tabs.length - 1) return;

    // To the right
    let targetIndex = activeTab.index + 1;

    // If the active tab is pinned, we have to set the target index
    // to that of the first non-pinned tab.
    if (activeTab.pinned) {
      targetIndex = getFirstNonPinnedTab(win).index;
    }

    // Moving a tab between two tabs of the same group makes Chrome add it to
    // that group. If the target is inside a group, go just past its end.
    const before = win.tabs[targetIndex - 1];
    if (before && isInGroup(before)) {
      while (targetIndex < freshNewTab.index
             && win.tabs[targetIndex].groupId === before.groupId) {
        targetIndex++;
      }
    }

    // Only bother moving if it wouldn't organically be placed immediately to the
    // right of the active tab.
    if (freshNewTab.index == targetIndex) {
      return;
    }

    // YOU GOT TO MOVE IT MOVE IT
    await api.tabs.move(newTab.id, { index: targetIndex });
  } catch (e) {
    console.error('AlwaysRight: tab placement failed', e);
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
