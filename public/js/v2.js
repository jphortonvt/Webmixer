// v2 (Ruled) page only: theme toggle, and line icons in place of the
// track-type emojis. ui.js still writes the emoji (it is what the server
// stores); this tags each button with data-icon and the CSS draws the icon.

// Theme toggle. With no saved choice the page follows the system setting.
(function () {
  const root = document.documentElement;
  const btn = document.getElementById('theme-toggle');
  const meta = document.querySelector('meta[name="theme-color"]');
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  if (!btn) return;

  const current = () => root.dataset.theme || (system.matches ? 'dark' : 'light');

  function paint() {
    const dark = current() === 'dark';
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', label);
    btn.title = label;
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--r-color-paper').trim() || (dark ? '#100D17' : '#FFFFFF');
  }

  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('rv2-theme', next); } catch (e) { /* private mode */ }
    paint();
  });
  system.addEventListener('change', paint);
  paint();
})();

// Track-type icons
(function () {
  const ICONS = {
    '🎸': ['guitar', 'Guitar'],
    '🔊': ['bass', 'Bass'],
    '🎹': ['keys', 'Keyboard'],
    '🥁': ['drums', 'Drums'],
    '🎤': ['vocals', 'Vocals'],
    '🎵': ['note', 'Default'],
  };
  const SELECTOR = '.btn-track-icon, .popover-icon-btn';

  // Only attributes change here, and the observers ignore attributes, so
  // tagging can't retrigger itself.
  function tag(el) {
    const entry = ICONS[el.textContent.trim()];
    if (!entry) {
      el.removeAttribute('data-icon');
      return;
    }
    const [icon, label] = entry;
    if (el.dataset.icon !== icon) el.dataset.icon = icon;
    el.setAttribute('aria-label', el.classList.contains('btn-track-icon') ? `Track type: ${label}` : label);
  }

  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.matches(SELECTOR)) tag(node);
    node.querySelectorAll(SELECTOR).forEach(tag);
  }

  function onMutations(mutations) {
    for (const m of mutations) {
      const host = (m.target.nodeType === 1 ? m.target : m.target.parentElement);
      const btn = host && host.closest(SELECTOR);
      if (btn) tag(btn);
      m.addedNodes.forEach(scan);
    }
  }

  // Channel strips are rebuilt inside #mixer; the picker popover is appended to <body>
  const mixer = document.getElementById('mixer');
  if (mixer) new MutationObserver(onMutations).observe(mixer, { childList: true, subtree: true, characterData: true });
  new MutationObserver(onMutations).observe(document.body, { childList: true });
  scan(document.body);
})();

// Account menu: the avatar button discloses the name, Admin and Logout.
(function () {
  const btn = document.getElementById('user-menu-btn');
  const menu = document.getElementById('user-menu');
  if (!btn || !menu) return;

  function setOpen(open, { focusFirst = false, returnFocus = false } = {}) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && focusFirst) {
      const first = menu.querySelector('a:not(.hidden)');
      if (first) first.focus();
    } else if (!open && returnFocus) {
      btn.focus();
    }
  }

  // detail === 0 means a keyboard press, so move focus into the menu
  btn.addEventListener('click', (e) => setOpen(menu.hidden, { focusFirst: e.detail === 0 }));

  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setOpen(false, { returnFocus: true });
  });
  // Tabbing out of the menu closes it
  menu.addEventListener('focusout', (e) => {
    if (e.relatedTarget && !menu.contains(e.relatedTarget) && e.relatedTarget !== btn) setOpen(false);
  });
})();
