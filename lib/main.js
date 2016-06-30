var windows = require("sdk/windows").browserWindows;

function onWindowOpen(window) {
  var lastActiveTabIndex = window.tabs.activeTab.index;

  window.tabs.on('activate', function onActivate(tab) {
    lastActiveTabIndex = tab.index;
  });

  window.tabs.on('open', function onOpen(tab) {
    var targetIndex = lastActiveTabIndex + 1;
    if (tab.index != targetIndex)
      tab.index = targetIndex;
  });
}

for each (var window in windows)
  onWindowOpen(window);

windows.on('open', onWindowOpen);
