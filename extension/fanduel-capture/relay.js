// Bridges inject.js (page world) to the background worker (extension world).
window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data?.__ufcFanDuel) return;
  chrome.runtime
    .sendMessage({ type: 'fanduel-response', url: ev.data.url, json: ev.data.json, page: location.href })
    .catch(() => {});
});
