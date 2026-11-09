// Runs inside the FanDuel page. Copies the odds JSON the page already requests
// for its own display (event-page / content-managed-page) and hands it to
// relay.js. It makes no requests of its own and changes nothing on the page.
(() => {
  const WANT = /\/api\/(?:event-page|content-managed-page)\b/i;
  const send = (url, text) => {
    try {
      window.postMessage({ __ufcFanDuel: true, url, json: JSON.parse(text) }, location.origin);
    } catch { /* not JSON - ignore */ }
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = res.url || String(args[0]?.url || args[0] || '');
      if (WANT.test(url)) res.clone().text().then((t) => send(url, t)).catch(() => {});
    } catch { /* never break the page */ }
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try {
      if (WANT.test(String(url))) {
        this.addEventListener('load', () => {
          try { send(this.responseURL || String(url), this.responseText); } catch { /* ignore */ }
        });
      }
    } catch { /* never break the page */ }
    return origOpen.call(this, method, url, ...rest);
  };
})();
