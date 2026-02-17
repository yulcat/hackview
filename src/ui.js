'use strict';

const blessed = require('blessed');
const path = require('path');
const { formatNum } = require('./usage');

const COLORS = {
  green: '#00ff00',
  darkGreen: '#005500',
  cyan: '#00ffff',
  darkCyan: '#006666',
  black: '#000000',
  dimGreen: '#00aa00',
  yellow: '#ffff00',
  red: '#ff4444',
  white: '#cccccc',
  bgComplete: '#003300',
  bgActive: '#001a00',
  bgIdle: '#000800',
};

const ASCII_HEADER = [
  ' ██╗  ██╗ █████╗  ██████╗██╗  ██╗██╗   ██╗██╗███████╗██╗    ██╗',
  ' ██║  ██║██╔══██╗██╔════╝██║ ██╔╝██║   ██║██║██╔════╝██║    ██║',
  ' ███████║███████║██║     █████╔╝ ██║   ██║██║█████╗  ██║ █╗ ██║',
  ' ██╔══██║██╔══██║██║     ██╔═██╗ ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║',
  ' ██║  ██║██║  ██║╚██████╗██║  ██╗ ╚████╔╝ ██║███████╗╚███╔███╔╝',
  ' ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝ ',
];

const MINI_HEADER = '  ╔╦╗╔═╗╔═╗╦╔═╦  ╦╦╔═╗╦ ╦\n  ║ ╠═╣║  ╠╩╗╚╗╔╝║║╣ ║║║\n  ╩ ╩ ╩╚═╝╩ ╩ ╚╝ ╩╚═╝╚╩╝';

function shortModelName(model) {
  if (!model) return 'unknown';
  // claude-3-5-sonnet-20241022 → sonnet-3.5
  // claude-opus-4-5 → opus-4.5
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('instant')) return 'instant';
  return model.split('-').slice(-2).join('-');
}

function makeBar(ratio, width, filled = '█', empty = '░') {
  const w = Math.max(4, width);
  const filledCount = Math.round(ratio * w);
  return filled.repeat(filledCount) + empty.repeat(w - filledCount);
}

class HackviewUI {
  constructor(numSessions) {
    this.numSessions = numSessions;
    this.screen = null;
    this.usageBox = null;
    this.sessionBoxes = [];
    this.sessionLogs = []; // arrays of log lines per session
    this.sessionStatus = []; // 'waiting' | 'streaming' | 'idle' | 'complete'
    this.sessionFiles = [];
    this.completionTimers = [];
    this.thinkingAnimFrame = 0;
    this.thinkingTimer = null;
    this.matrixTimer = null;
    this._usageData = null;
    this._matrixChars = [];
  }

  init() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'HACKVIEW',
      fullUnicode: true,
      forceUnicode: true,
    });

    this.screen.key(['C-c', 'q'], () => {
      this.destroy();
      process.exit(0);
    });

    this._buildLayout();
    this._startAnimations();
    this.screen.render();
  }

  _buildLayout() {
    const sw = this.screen.width;
    const sh = this.screen.height;

    // Usage panel height: 7 lines (header) + 1 usage line + 1 model bars + borders
    const usageHeight = 10;
    const sessionHeight = Math.floor((sh - usageHeight) / this.numSessions);

    // ── USAGE PANEL ──
    this.usageBox = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: usageHeight,
      tags: true,
      border: { type: 'line' },
      style: {
        fg: COLORS.green,
        bg: COLORS.black,
        border: { fg: COLORS.darkGreen },
      },
    });
    this.screen.append(this.usageBox);

    // ── SESSION PANELS ──
    for (let i = 0; i < this.numSessions; i++) {
      this.sessionLogs.push([]);
      this.sessionStatus.push('waiting');
      this.sessionFiles.push(null);
      this.completionTimers.push(null);

      const top = usageHeight + i * sessionHeight;
      const height = (i === this.numSessions - 1)
        ? sh - top  // last panel takes remaining space
        : sessionHeight;

      const box = blessed.box({
        top,
        left: 0,
        width: '100%',
        height,
        tags: true,
        border: { type: 'line' },
        scrollable: true,
        alwaysScroll: true,
        scrollbar: {
          ch: '│',
          style: { fg: COLORS.darkGreen },
        },
        style: {
          fg: COLORS.green,
          bg: COLORS.black,
          border: { fg: COLORS.darkGreen },
        },
      });

      this.screen.append(box);
      this.sessionBoxes.push(box);
    }

    this._renderUsage(null);
    for (let i = 0; i < this.numSessions; i++) {
      this._renderSessionHeader(i);
    }
  }

  _renderUsage(data) {
    this._usageData = data;
    const sw = this.screen.width - 4;

    let lines = [];

    // ASCII art header - pick size based on terminal width
    if (sw >= 66) {
      for (const line of ASCII_HEADER) {
        lines.push(`{green-fg}${line}{/green-fg}`);
      }
    } else {
      lines.push(`{green-fg}${MINI_HEADER}{/green-fg}`);
    }

    lines.push('');

    if (!data) {
      lines.push('{#006666-fg}  ◈ LOADING USAGE DATA...{/}');
    } else {
      const inStr = formatNum(data.totalInput);
      const outStr = formatNum(data.totalOutput);
      const costStr = data.totalCost ? `$${data.totalCost.toFixed(4)}` : '$0.00';
      const cacheStr = data.totalCacheRead ? formatNum(data.totalCacheRead) : '0';

      lines.push(
        `{green-fg}  ◈ TODAY  {bold}${inStr}{/bold} in / {bold}${outStr}{/bold} out  ` +
        `{#006666-fg}cached: ${cacheStr}  {green-fg}cost: {bold}${costStr}{/bold}{/green-fg}`
      );

      // model breakdown bars
      const models = Object.entries(data.modelBreakdown || {});
      if (models.length > 0) {
        const totalTokens = models.reduce((s, [, v]) => s + (v.input || 0) + (v.output || 0), 0) || 1;
        const barWidth = Math.min(20, Math.floor((sw - 30) / models.length));

        const barParts = models.map(([model, stats]) => {
          const tokens = (stats.input || 0) + (stats.output || 0);
          const ratio = tokens / totalTokens;
          const bar = makeBar(ratio, barWidth);
          const name = shortModelName(model);
          return `{#00aa00-fg}${name}{/} {green-fg}${bar}{/} {#006666-fg}${formatNum(tokens)}{/}`;
        });
        lines.push('  ' + barParts.join('  '));
      }
    }

    this.usageBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  _getStatusTag(sessionIndex) {
    const status = this.sessionStatus[sessionIndex];
    switch (status) {
      case 'waiting':    return '{#006666-fg}[waiting...]{/}';
      case 'streaming':  return '{green-fg}{bold}[streaming▮]{/bold}{/green-fg}';
      case 'idle':       return '{#00aa00-fg}[idle]{/}';
      case 'complete':   return '{#00ffff-fg}[done ✓]{/}';
      default:           return '{#006666-fg}[...]{/}';
    }
  }

  _renderSessionHeader(sessionIndex) {
    const box = this.sessionBoxes[sessionIndex];
    const file = this.sessionFiles[sessionIndex];
    const status = this._getStatusTag(sessionIndex);

    let fileInfo = '{#006666-fg}no file{/}';
    if (file) {
      const dir = path.basename(path.dirname(file));
      const fname = path.basename(file, '.jsonl');
      fileInfo = `{#006666-fg}${dir}/{/}{#00aa00-fg}${fname.slice(0, 20)}{/}`;
    }

    const header = `{green-fg}{bold} ◉ SESSION ${sessionIndex + 1}{/bold}{/green-fg}  ${status}  ${fileInfo}`;
    const divider = '{#005500-fg}' + '─'.repeat(this.screen.width - 4) + '{/}';

    const existing = this.sessionLogs[sessionIndex];
    const allLines = [header, divider, ...existing];
    box.setContent(allLines.join('\n'));
    box.setScrollPerc(100);
    this.screen.render();
  }

  _addSessionLine(sessionIndex, line) {
    const logs = this.sessionLogs[sessionIndex];
    logs.push(line);

    // Keep last 200 lines
    if (logs.length > 200) logs.splice(0, logs.length - 200);

    this._renderSessionHeader(sessionIndex);
  }

  // ─── Public API ───

  setFile(sessionIndex, filePath) {
    this.sessionFiles[sessionIndex] = filePath;
    this.sessionStatus[sessionIndex] = 'idle';
    this._renderSessionHeader(sessionIndex);
  }

  setNoFile(sessionIndex) {
    this.sessionFiles[sessionIndex] = null;
    this.sessionStatus[sessionIndex] = 'waiting';
    this.sessionLogs[sessionIndex] = [];
    this._renderSessionHeader(sessionIndex);
  }

  addEvent(sessionIndex, event) {
    let line = '';
    const ts = new Date().toISOString().substr(11, 8);

    switch (event.type) {
      case 'session-start':
        line = `{#006666-fg}${ts}{/} {cyan-fg}▶ SESSION STARTED{/}`;
        this.sessionStatus[sessionIndex] = 'idle';
        break;

      case 'user': {
        const text = event.content || '';
        const preview = text.replace(/\n/g, ' ').slice(0, 120);
        line = `{#006666-fg}${ts}{/} {#00ffff-fg}▷ USER:{/} {white-fg}${escTag(preview)}{/}`;
        break;
      }

      case 'thinking':
        this.sessionStatus[sessionIndex] = 'streaming';
        line = `{#006666-fg}${ts}{/} {#005500-fg}◌ thinking...{/}`;
        break;

      case 'text': {
        this.sessionStatus[sessionIndex] = 'streaming';
        const text = event.content || '';
        if (!text.trim()) return;
        const preview = text.replace(/\n/g, ' ').slice(0, 150);
        line = `{#006666-fg}${ts}{/} {green-fg}◎ {/}{white-fg}${escTag(preview)}{/}`;
        break;
      }

      case 'tool_use':
        this.sessionStatus[sessionIndex] = 'streaming';
        line = `{#006666-fg}${ts}{/} {yellow-fg}⚙ ${escTag(event.content || '')}{/}`;
        break;

      case 'complete': {
        const prevStatus = this.sessionStatus[sessionIndex];
        this.sessionStatus[sessionIndex] = 'complete';

        if (event.usage) {
          const u = event.usage;
          const inTok = formatNum(u.input_tokens || 0);
          const outTok = formatNum(u.output_tokens || 0);
          line = `{#006666-fg}${ts}{/} {#00ffff-fg}✓ DONE{/} {#006666-fg}in:${inTok} out:${outTok}{/}`;
        } else {
          line = `{#006666-fg}${ts}{/} {#00ffff-fg}✓ DONE{/}`;
        }

        // Flash green background for 1.5 seconds
        this._flashComplete(sessionIndex);
        break;
      }

      default:
        return;
    }

    if (line) {
      this._addSessionLine(sessionIndex, line);
    }
  }

  _flashComplete(sessionIndex) {
    const box = this.sessionBoxes[sessionIndex];

    // Clear existing timer
    if (this.completionTimers[sessionIndex]) {
      clearTimeout(this.completionTimers[sessionIndex]);
    }

    // Flash: green background
    box.style.bg = COLORS.bgComplete;
    box.style.border = { fg: COLORS.green };
    this._renderSessionHeader(sessionIndex);

    // Revert after 1.5s
    this.completionTimers[sessionIndex] = setTimeout(() => {
      box.style.bg = COLORS.black;
      box.style.border = { fg: COLORS.darkGreen };
      this.sessionStatus[sessionIndex] = 'idle';
      this._renderSessionHeader(sessionIndex);
    }, 1500);
  }

  updateUsage(data) {
    this._renderUsage(data);
  }

  _startAnimations() {
    // Blinking cursor in streaming sessions
    this.thinkingTimer = setInterval(() => {
      this.thinkingAnimFrame = (this.thinkingAnimFrame + 1) % 4;
      this.screen.render();
    }, 500);
  }

  destroy() {
    if (this.thinkingTimer) clearInterval(this.thinkingTimer);
    if (this.matrixTimer) clearInterval(this.matrixTimer);
    for (const t of this.completionTimers) {
      if (t) clearTimeout(t);
    }
    try { this.screen.destroy(); } catch (e) {}
  }
}

function escTag(str) {
  if (!str) return '';
  return String(str)
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}');
}

module.exports = { HackviewUI };
