const $ = (id) => document.getElementById(id);
chrome.storage.local.get({ port: 47823, refreshMinutes: 5, lastPost: null }).then((s) => {
  $('port').value = s.port;
  $('refresh').value = s.refreshMinutes;
  const p = s.lastPost;
  if (!p?.at) return;
  const ago = Math.max(0, Math.round((Date.now() - p.at) / 60000));
  const status = $('status');
  status.textContent = '';
  const span = document.createElement('span');
  span.className = p.ok ? 'ok' : 'bad';
  span.textContent = p.ok ? `Sent ${p.count} response(s) from ${p.fights} fight(s)` : p.error;
  status.append(span, ` · ${ago}m ago`);
});
$('port').addEventListener('change', (e) => chrome.storage.local.set({ port: Number(e.target.value) || 47823 }));
$('refresh').addEventListener('change', (e) =>
  chrome.storage.local.set({ refreshMinutes: Math.max(0, Number(e.target.value) || 0) })
);
