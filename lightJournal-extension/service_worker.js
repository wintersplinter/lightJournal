const APP_URL = "https://wintersplinter.github.io/lightJournal/";

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: APP_URL });
});
