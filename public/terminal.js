// Live mirror of one tmux pane, drawn with xterm.js.
// The browser terminal always matches the pane's size (the real terminal owns
// the size); the font is scaled so it fits the available space.
(() => {
  const THEME = {
    background: '#1b1a19', foreground: '#e8e4dc', cursor: '#e8e4dc', selectionBackground: '#5a4a40',
    black: '#1b1a19', red: '#e46a5c', green: '#5bb97a', yellow: '#e0a645', blue: '#74a3e4', magenta: '#c08fd6', cyan: '#5fc4c4', white: '#d6d2ca',
    brightBlack: '#6d6962', brightRed: '#ff8a7a', brightGreen: '#7fd69a', brightYellow: '#f2c46b', brightBlue: '#9cc0f2', brightMagenta: '#d8acec', brightCyan: '#86dede', brightWhite: '#ffffff',
  };

  const BASE_FONT = 13;

  class TerminalView {
    constructor(host, paneId, { onStatus } = {}) {
      this.host = host;
      this.paneId = paneId;
      this.onStatus = onStatus || (() => {});
      this.disposed = false;
      this.fontSize = BASE_FONT;
      this.pending = [];
      this.term = new window.Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: this.fontSize,
        theme: THEME,
        cursorBlink: true,
        scrollback: 2000,
        allowProposedApi: false,
        macOptionIsMeta: true,
      });
      this.term.open(host);
      this.term.onData((data) => this.send(data));
      this.resizeObserver = new ResizeObserver(() => {
        this.fit();
        clearTimeout(this.sizeTimer);
        this.sizeTimer = setTimeout(() => this.requestSize(), 250);
      });
      this.resizeObserver.observe(host);
      this.connect();
    }

    connect() {
      if (this.disposed) return;
      this.onStatus('connecting');
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal?pane=${this.paneId.replace('%', '')}`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.onStatus('live');
        // Anything typed while connecting is sent now instead of being lost.
        for (const data of this.pending.splice(0)) this.send(data);
      };
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') { this.term.write(new Uint8Array(e.data)); return; }
        const m = JSON.parse(e.data);
        if (m.type === 'snapshot') {
          this.term.resize(m.cols, m.rows);
          this.term.reset();
          this.term.write(m.screen);
          this.term.write(`\x1b[${m.cursor.y + 1};${m.cursor.x + 1}H`);
          this.fit();
          requestAnimationFrame(() => this.requestSize());
        }
      };
      ws.onclose = (e) => {
        if (this.disposed) return;
        if (e.code === 4404) { this.onStatus('closed'); return; }
        this.onStatus('reconnecting');
        setTimeout(() => this.connect(), 1500);
      };
    }

    send(data) {
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'input', data }));
      else if (this.pending.length < 200) this.pending.push(data);
    }

    // Ask for the pane size that fills this panel at the normal font size. The hub
    // only applies it while no real terminal is attached to the session.
    requestSize() {
      const screen = this.host.querySelector('.xterm-screen');
      if (!screen || this.ws?.readyState !== 1) return;
      const box = this.host.getBoundingClientRect();
      const r = screen.getBoundingClientRect();
      if (!r.width || !box.width) return;
      const k = BASE_FONT / this.fontSize;
      const cols = Math.floor(box.width / ((r.width / this.term.cols) * k));
      const rows = Math.floor(box.height / ((r.height / this.term.rows) * k));
      if (cols >= 40 && rows >= 10 && (cols !== this.term.cols || rows !== this.term.rows)) {
        this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    }

    focus() { this.term.focus(); }

    // Scale the font so the pane's columns and rows fit the host element.
    // Line heights round to whole pixels, so re-measure after each change and step
    // down until the screen really fits.
    fit(pass = 0) {
      const screen = this.host.querySelector('.xterm-screen');
      if (!screen) return;
      const box = this.host.getBoundingClientRect();
      const r = screen.getBoundingClientRect();
      if (!r.width || !r.height || !box.width) return;
      const scale = Math.min(box.width / r.width, box.height / r.height);
      let next = Math.max(6, Math.min(15, Math.floor(this.fontSize * scale * 4) / 4));
      if (pass > 0 && next >= this.fontSize && (r.width > box.width + 1 || r.height > box.height + 1)) next = this.fontSize - 0.25;
      if (next !== this.fontSize && next >= 6) {
        this.fontSize = next;
        this.term.options.fontSize = next;
        if (pass < 8) requestAnimationFrame(() => this.fit(pass + 1));
      }
    }

    dispose() {
      this.disposed = true;
      this.resizeObserver.disconnect();
      try { this.ws?.close(); } catch {}
      this.term.dispose();
    }
  }

  window.TerminalView = TerminalView;
})();
