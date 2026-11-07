// Public demo (/demo): the normal mixer, open to anyone without signing in.
// Reads are redirected to /api/demo; anything that would save something
// shows a "Demo only" toast instead. The server enforces the same thing (the
// demo API has no write routes), so this only keeps the page friendly.
const Demo = (() => {
  const active = /^\/demo\/?$/.test(location.pathname);
  if (!active) return { active: false };

  document.documentElement.classList.add('is-demo');

  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  // --- Toast ----------------------------------------------------------------

  let toastEl = null;
  let toastTimer = null;

  function toast(detail) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'demo-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.innerHTML = '<strong>Demo only</strong><span></span>';
    toastEl.querySelector('span').textContent = detail || 'This is turned off in the demo.';
    toastEl.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 2800);
  }

  // --- Requests -------------------------------------------------------------

  const realFetch = window.fetch.bind(window);
  const VIEWER = { id: 0, name: 'Demo', email: '', picture: null, is_admin: false };

  const reads = [
    [/^\/auth\/me$/, () => json(VIEWER)],
    [/^\/api\/sessions$/, () => realFetch('/api/demo/sessions')],
    [/^\/api\/sessions\/demo\/(tracks|comments|icons)$/, (m) => realFetch('/api/demo/' + m[1])],
    [/^\/api\/sessions\/demo\/mix$/, () => json({ error: 'No saved mix' }, 404)],
    [/^\/api\/(mixes|songs)$/, () => json([])],
  ];

  function writeMessage(path) {
    if (/\/comments$/.test(path)) return 'Commenting is turned off in the demo.';
    if (/\/mix$/.test(path)) return 'Saving mixes is turned off in the demo.';
    if (/\/mixdown$/.test(path)) return 'Mixdowns are turned off in the demo.';
    return 'Changes are not saved in the demo.';
  }

  window.fetch = function (input, init) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.origin !== location.origin) return realFetch(input, init);

    const method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      toast(writeMessage(url.pathname));
      return Promise.resolve(json({ error: 'Demo only' }, 403));
    }

    for (const [pattern, handler] of reads) {
      const m = url.pathname.match(pattern);
      if (m) return Promise.resolve(handler(m));
    }
    // Nothing else the band's API offers is open to the demo
    if (/^\/(api|auth)\//.test(url.pathname)) return Promise.resolve(json({ error: 'Not in the demo' }, 404));
    return realFetch(input, init);
  };

  // --- Buttons that would open a prompt or dialog before saving ------------

  const blocked = {
    'btn-save-mix': 'Saving mixes is turned off in the demo.',
    'btn-export-mix': 'Mixdowns are turned off in the demo.',
    'btn-star-session': 'Starring is turned off in the demo.',
    'btn-edit-tags': 'Tagging is turned off in the demo.',
    'btn-archive-session': 'Archiving is turned off in the demo.',
    'btn-edit-name': 'Renaming is turned off in the demo.',
  };

  // Capture phase, so this runs before the page's own click handlers
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[id]');
    if (!btn || !blocked[btn.id]) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast(blocked[btn.id]);
  }, true);

  // --- Page chrome ----------------------------------------------------------

  document.addEventListener('DOMContentLoaded', () => {
    document.title = 'TRAXXXXXXXXS · Demo';

    const brand = document.querySelector('.brand');
    if (brand) {
      const badge = document.createElement('span');
      badge.className = 'demo-badge';
      badge.textContent = 'Demo';
      brand.appendChild(badge);
    }

    const note = document.querySelector('.footer-note');
    if (note) note.textContent = 'TRAXXXXXXXXS · demo · read only';

    const empty = document.getElementById('playlist-empty');
    if (empty) empty.textContent = 'Mixdowns the band exports land here. Exporting is turned off in the demo.';
  });

  return { active, toast };
})();
