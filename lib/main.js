const windows = require("windows").browserWindows;

function onWindowOpen(window) {
  let lastActiveTabIndex = window.tabs.activeTab.index;

  window.tabs.on('activate', function onActivate(tab) {
    lastActiveTabIndex = tab.index;
  });

  window.tabs.on('open', function onOpen(tab) {
    let targetIndex = lastActiveTabIndex + 1;
    if (tab.index != targetIndex)
      tab.index = targetIndex;
  });
}

for each (var window in windows)
  onWindowOpen(window);
windows.on('open', onWindowOpen);
