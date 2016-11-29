var activeTab = null;

browser.tabs.onActivated.addListener(function(activeInfo) {
  browser.tabs.get(activeInfo.tabId).then(function(tabInfo) {
    activeTab = tabInfo;
  });
});

browser.tabs.onCreated.addListener(function(newTab) {
  browser.tabs.move(newTab.id, { index: activeTab.index + 1 });
});
