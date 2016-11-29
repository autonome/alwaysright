var activeTab = null;

browser.tabs.onActivated.addListener(function(tab) {
  console.log('active tab', tab)
  activeTab = tab;
});

browser.tabs.onCreated.addListener(function(newTab) {
  var opts = {
    currentWindow: true,
    active: true
  };
  console.log('new tab index', newTab.index);
  //browser.tabs.query(opts, function(result) {
    //var activeTab = result[0];
    console.log("new tab! changing newTab index (", newTab.index, ") to active tab index (", activeTab.index, ") + 1");
    newTab.index = activeTab.index + 1;
  //});
});


/*
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
*/
