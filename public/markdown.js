// Small, safe Markdown renderer for Claude's responses.
// Everything is HTML-escaped first; only a fixed set of constructs is turned
// back into markup, so transcript content can never inject HTML.
(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));

  function blocks(text) {
    const lines = text.split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let m;
      if (!l.trim()) { flush(); continue; }
      if (l.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const head = cells(l);
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        i--;
        out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); const n = Math.min(m[1].length + 2, 6); out.push(`<h${n}>${inline(m[2])}</h${n}>`); continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { flush(); out.push('<hr>'); continue; }
      if (/^\s*>\s?/.test(l)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        i--;
        out.push(`<blockquote>${blocks(q.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush();
        const ordered = /^\s*\d+[.)]/.test(l);
        const items = [];
        while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          const li = lines[i];
          if (/^\s*([-*+]|\d+[.)])\s+/.test(li) && !/^\s{4,}/.test(li)) items.push(li.replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
          else items[items.length - 1] += '\n' + li.trim();
          i++;
        }
        i--;
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((it) => `<li>${it.split('\n').map(inline).join('<br>')}</li>`).join('')}</${tag}>`);
        continue;
      }
      para.push(l);
    }
    flush();
    return out.join('');
  }

  window.renderMarkdown = (src) => {
    const parts = esc(String(src ?? '')).split(/^```[^\n]*\n?/m);
    // Even parts are prose, odd parts are fenced code.
    return parts.map((p, i) => (i % 2 ? `<pre class="code"><code>${p.replace(/\n$/, '')}</code></pre>` : blocks(p))).join('');
  };
})();
