// browser (Firefox) vs chrome (Chromium)
const api = typeof chrome != "undefined" ? chrome : browser;

const init => () {
  // Reference to the active tab
  var activeTab = null;

  // Update cached ref to active tab
  function updateActiveTab() {
    api.tabs.query({'active': true}, function(tabs) {
      if (activeTab === null) {
        initEventHandlers();
      }
      activeTab = tabs[0];
    });
  }

  // Get active tab reference on startup
  updateActiveTab();

  // As getting active tab id at startup is async, really start our own
  // activity until we actually have it.
  // This is called in updateActiveTab if activeTab is null.
  function initEventHandlers() {
    // Update reference to active tab any time there's a tab
    // activated event.
    api.tabs.onActivated.addListener(function(activeInfo) {
      api.tabs.get(activeInfo.tabId, function(tabInfo) {
        activeTab = tabInfo;
      });
    });

    // Any time a new tab is created, set its index to the index
    // of the active tab, plus one.
    api.tabs.onCreated.addListener(makeRight);

    // ODD. If instead of this, I get a fresh reference to the active tab
    // right before moving, it still has stale index!!
    // Soooo, I guess we're doing this.
    api.tabs.onMoved.addListener(updateActiveTab);
  }

  // Move the referenced tab to the immediate right of the active tab,
  // or to the immediate right of the last pinned tab.
  function makeRight(newTab) {
    // Too soon after startup.
    if (!activeTab) {
      return;
    }

    // The new tab either dragged to new window or something went wrong.
    if (newTab.windowId != activeTab.windowId) {
      return;
    }

    var targetIndex = activeTab.index + 1;

    // Only bother moving if it wouldn't organically be placed immediately to the
    // right of the active tab.
    if (newTab.index == targetIndex) {
      return;
    }

    // We need current window for a few things required for correct tab placement.
    // And apparently tab references go STALE. Dammit.
    api.windows.getCurrent({'populate': true}, function(win) {

      // Maybe is a restored tab, or another add-on, or something else is wonky.
      if (newTab.index < win.tabs.length - 1
          || newTab.index > win.tabs.length - 1) {
        return;
      }

      // If the active tab is pinned, we have to set the target index
      // to that of the first non-pinned tab.
      if (activeTab.pinned) {
        targetIndex = getFirstNonPinnedTab(win).index;
      }

      // YOU GOT TO MOVE IT MOVE IT
      api.tabs.move(newTab.id, { index: targetIndex }, function(t) {
        // woohoo.
      });
    });
  }

  // Return a tab object for the first non-pinned tab in the tab strip
  // for the given window.
  function getFirstNonPinnedTab(win) {
    for (var tab of win.tabs) {
      if (!tab.pinned) {
        return tab;
      }
    }
  }
};

init();
