// Injected on demand (never on every page) to outline the page for an agent.
//
// Runs in the extension's isolated world, so the page can't see or call it, and
// it listens for nothing: only the service worker invokes readPage. Element refs
// (ref_N) stay stable for the life of the document and are held weakly.
// Password, one-time-code and card fields are never read out.

if (!globalThis.__controlC) {
  const refs = new Map();      // ref -> WeakRef(element)
  const refOf = new WeakMap(); // element -> ref
  let nextRef = 1;
  const ref = (el) => {
    let r = refOf.get(el);
    if (!r) { r = `ref_${nextRef++}`; refOf.set(el, r); refs.set(r, new WeakRef(el)); }
    return r;
  };

  const INPUT_ROLES = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox' };
  const TAG_ROLES = {
    button: 'button', select: 'combobox', textarea: 'textbox', img: 'img', nav: 'navigation', main: 'main',
    header: 'banner', footer: 'contentinfo', form: 'form', ul: 'list', ol: 'list', li: 'listitem', table: 'table',
    tr: 'row', th: 'columnheader', td: 'cell', dialog: 'dialog', summary: 'button', aside: 'complementary', label: 'label',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
  };
  const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'slider', 'switch', 'tab', 'menuitem', 'option']);
  // Roles whose visible text is their name; their children aren't listed again.
  const LEAF = new Set(['button', 'link', 'heading', 'textbox', 'searchbox', 'combobox', 'option', 'tab', 'menuitem', 'img', 'label']);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(' ')[0];
    const tag = el.localName;
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') return el.type === 'hidden' ? null : INPUT_ROLES[el.type] || 'textbox';
    if (TAG_ROLES[tag]) return TAG_ROLES[tag];
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return 'textbox';
    if (el.hasAttribute('onclick') || el.tabIndex >= 0 && el.hasAttribute('tabindex')) return 'generic-clickable';
    return null;
  }

  const clean = (s, n = 120) => {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
  };

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => el.getRootNode().getElementById?.(id)?.textContent || '').join(' ');
      if (t.trim()) return clean(t);
    }
    if (el.labels?.length) return clean([...el.labels].map((l) => l.textContent).join(' '));
    if (role === 'img') return clean(el.alt || el.title);
    if (el.localName === 'input' && /^(submit|button|reset)$/.test(el.type)) return clean(el.value);
    if (LEAF.has(role) || role === 'generic-clickable') return clean(el.innerText || el.placeholder || el.title);
    return clean(el.title);
  }

  const sensitive = (el) => el.type === 'password' || /one-time-code|^cc-/.test(el.autocomplete || '');

  function details(el, role) {
    const d = [];
    if (role === 'heading') d.push(`level=${el.localName.slice(1) || el.getAttribute('aria-level')}`);
    if (role === 'link') d.push(`href=${clean(el.getAttribute('href'), 100)}`);
    if ('value' in el && /textbox|searchbox|combobox|slider/.test(role)) {
      d.push(sensitive(el) ? 'value=[redacted]' : el.value ? `value="${clean(el.value, 80)}"` : '');
      if (el.placeholder) d.push(`placeholder="${clean(el.placeholder, 60)}"`);
    }
    if (el.checked) d.push('checked');
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') d.push('disabled');
    if (el.getAttribute('aria-expanded')) d.push(`expanded=${el.getAttribute('aria-expanded')}`);
    return d.filter(Boolean).join(' ');
  }

  function hidden(el) {
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden';
  }

  function readPage({ filter, maxChars }) {
    const lines = [];
    let size = 0;
    let truncated = false;
    const emit = (depth, line) => {
      if (truncated) return;
      const l = `${'  '.repeat(filter === 'interactive' ? 0 : depth)}${line}`;
      if (size + l.length > maxChars) { truncated = true; return; }
      lines.push(l);
      size += l.length + 1;
    };

    function walk(node, depth) {
      if (truncated || depth > 40) return;
      const kids = node.shadowRoot ? [...node.shadowRoot.childNodes, ...node.childNodes] : node.childNodes;
      for (const child of kids) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (filter === 'all') { const t = clean(child.textContent, 200); if (t) emit(depth, `text "${t}"`); }
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE || /^(script|style|noscript|template|svg|head)$/.test(child.localName)) continue;
        if (hidden(child)) continue;
        const role = roleOf(child);
        const show = role && (filter === 'all' || INTERACTIVE.has(role) || role === 'generic-clickable');
        if (show) {
          const name = nameOf(child, role);
          const extra = details(child, role);
          emit(depth, `${role}${name ? ` "${name}"` : ''}${extra ? ` ${extra}` : ''} [${ref(child)}]`);
          if (!LEAF.has(role)) walk(child, depth + 1);
        } else {
          walk(child, depth); // plain containers are flattened away
        }
      }
    }

    walk(document.body || document.documentElement, 0);
    const head = [
      `Title: ${document.title}`,
      `URL: ${location.href}`,
      `Viewport: ${innerWidth}x${innerHeight}, scrolled to ${Math.round(scrollX)},${Math.round(scrollY)} of ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`,
      '',
    ];
    if (truncated) lines.push(`[truncated at ${maxChars} characters; use filter "interactive" or a larger max_chars]`);
    return head.concat(lines).join('\n');
  }

  globalThis.__controlC = { readPage, refs };
}
