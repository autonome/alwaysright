// don't enable until session is restored
//let obsvc = require("observer-service");
//obsvc.add("sessionstore-windows-restored", function() {
  //obsvc.remove("sessionstore-windows-restored", arguments.callee);

  let tabs = require("tabs");
  let lastActiveTabIndex = tabs.activeTab.index;

  tabs.on('activate', function onActivate(tab) {
    lastActiveTabIndex = tab.index;
  });

  tabs.on('open', function onOpen(tab) {
    let targetIndex = lastActiveTabIndex + 1;
    if (tab.index != targetIndex)
      tab.index = targetIndex;
  });
//});
