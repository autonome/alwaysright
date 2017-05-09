var activeTab = null;

// Get active tab reference on load.
browser.tabs.query({currentWindow: true, active: true}).then(function(tabs) {
  browser.tabs.get(tabs[0].id).then(function(tabInfo) {
    activeTab = tabInfo;
  });
});

// Update reference to active tab any tab there's a tab
// activated event.
browser.tabs.onActivated.addListener(function(activeInfo) {
  browser.tabs.get(activeInfo.tabId).then(function(tabInfo) {
    activeTab = tabInfo;
  });
});

// Any time a new tab is created, set it's index to the index
// of the active tab, plus one.
browser.tabs.onCreated.addListener(function(newTab) {
  var targetIndex = activeTab.index + 1;
  if (newTab.index != targetIndex) {
    browser.tabs.move(newTab.id, { index: activeTab.index + 1 });
  }
});
