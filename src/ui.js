'use strict';

const blessed = require('blessed');
const path = require('path');
const os = require('os');
const { formatNum } = require('./usage');

// ─── Color palette ───────────────────────────────────────────────────────────
const COLORS = {
  green:      '#00ff00',
  darkGreen:  '#005500',
  dimGreen:   '#00aa00',
  brightGreen:'#00ff44',
  cyan:       '#00ffff',
  darkCyan:   '#006666',
  black:      '#000000',
  bgActive:   '#001a00',   // streaming: very dark green bg
  bgIdle:     '#000000',   // idle/waiting: black
  bgComplete: '#003300',   // flash green on completion
  yellow:     '#ffff00',
  red:        '#ff4444',
  white:      '#cccccc',
};

// Sparkline chars (low → high)
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// Bar chars
function makeBar(ratio, width, filled = '█', empty = '░') {
  const w = Math.max(4, width);
  const n = Math.min(w, Math.round(Math.clamp ? Math.clamp(ratio, 0, 1) * w : Math.max(0, Math.min(1, ratio)) * w));
  return filled.repeat(n) + empty.repeat(w - n);
}

function shortModelName(model) {
  if (!model) return 'unknown';
  const m = model.toLowerCase();
  if (m.includes('opus'))    return 'opus';
  if (m.includes('sonnet'))  return 'sonnet';
  if (m.includes('haiku'))   return 'haiku';
  if (m.includes('instant')) return 'instant';
  return model.split('-').slice(-2).join('-');
}

function escTag(str) {
  if (!str) return '';
  return String(str).replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function formatUptime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatClock() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ─── CPU sampling ─────────────────────────────────────────────────────────────
let _prevCpuTimes = null;

function getCpuPercent() {
  try {
    const cpus = os.cpus();
    const totals = cpus.reduce((acc, cpu) => {
      const times = cpu.times;
      acc.idle += times.idle;
      acc.total += times.idle + times.user + times.nice + times.sys + times.irq;
      return acc;
    }, { idle: 0, total: 0 });

    if (!_prevCpuTimes) {
      _prevCpuTimes = totals;
      return 0;
    }

    const idleDiff  = totals.idle  - _prevCpuTimes.idle;
    const totalDiff = totals.total - _prevCpuTimes.total;
    _prevCpuTimes = totals;

    if (totalDiff === 0) return 0;
    return Math.round((1 - idleDiff / totalDiff) * 100);
  } catch (e) {
    return 0;
  }
}

function getMemPercent() {
  try {
    const total = os.totalmem();
    const free  = os.freemem();
    return { pct: Math.round((1 - free / total) * 100), total, free };
  } catch (e) {
    return { pct: 0, total: 0, free: 0 };
  }
}

// ─── Network sparkline state (fake/real hybrid) ───────────────────────────────
const NET_HISTORY_LEN = 12;
let _netHistory = Array(NET_HISTORY_LEN).fill(0);
let _prevNetBytes = null;
let _lastNetBytes = 0;

async function sampleNet() {
  try {
    const fs = require('fs');
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n');
    let rx = 0, tx = 0;
    for (const line of lines.slice(2)) {
      const parts = line.trim().split(/\s+/);
      if (!parts[0] || parts[0] === 'lo:') continue;
      rx += parseInt(parts[1], 10) || 0;
      tx += parseInt(parts[9], 10) || 0;
    }
    const total = rx + tx;
    let diff = 0;
    if (_prevNetBytes !== null && total > _prevNetBytes) {
      diff = total - _prevNetBytes;
    }
    _prevNetBytes = total;
    _lastNetBytes = diff;
    return diff;
  } catch (e) {
    // fallback: fake random movement
    const fakeVal = Math.random() * 8000 + 500;
    _lastNetBytes = fakeVal;
    return fakeVal;
  }
}

function pushNetSample(val) {
  _netHistory.push(val);
  if (_netHistory.length > NET_HISTORY_LEN) _netHistory.shift();
}

function renderSparkline(history) {
  const max = Math.max(...history, 1);
  return history.map(v => {
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * SPARK_CHARS.length));
    return SPARK_CHARS[idx];
  }).join('');
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB/s`;
  if (n >= 1024)        return `${(n / 1024).toFixed(1)}KB/s`;
  return `${Math.round(n)}B/s`;
}

// ─── HackviewUI ───────────────────────────────────────────────────────────────
class HackviewUI {
  constructor(numSessions) {
    this.numSessions = numSessions;
    this.screen = null;

    // Top panel: header box (fixed) + content box inside it
    this.headerBox = null;   // outer bordered box

    // Per-session: header label + scroll area
    this.sessionHeaderBoxes = [];  // fixed label strips
    this.sessionScrollBoxes = [];  // scrollable log areas

    this.sessionLogs    = [];  // string[][]
    this.sessionStatus  = [];  // 'waiting'|'streaming'|'thinking'|'idle'|'complete'
    this.sessionFiles   = [];
    this.completionTimers = [];

    this._usageData   = null;
    this._startTime   = Date.now();
    this._clockTimer  = null;
    this._netTimer    = null;
    this._renderTimer = null;
    this._dirtyHeader = true;
    this._dirtySessions = new Set();

    // throttle renders
    this._lastRender = 0;
    this._renderPending = false;
  }

  // ── init ────────────────────────────────────────────────────────────────────
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
    this._startTimers();
    this._scheduleRender();
  }

  // ── layout ─────────────────────────────────────────────────────────────────
  _buildLayout() {
    const sh = this.screen.height;

    // Header panel: 8 lines + border = 10 total
    const headerHeight = 9;
    const remainingH   = sh - headerHeight;
    const sessionH     = Math.floor(remainingH / this.numSessions);

    // ── HEADER BOX ──
    this.headerBox = blessed.box({
      top: 0, left: 0,
      width: '100%',
      height: headerHeight,
      tags: true,
      border: { type: 'line' },
      style: {
        fg: COLORS.green,
        bg: COLORS.black,
        border: { fg: COLORS.darkGreen },
      },
    });
    this.screen.append(this.headerBox);

    // ── SESSION PANELS ──
    for (let i = 0; i < this.numSessions; i++) {
      this.sessionLogs.push([]);
      this.sessionStatus.push('waiting');
      this.sessionFiles.push(null);
      this.completionTimers.push(null);

      const top    = headerHeight + i * sessionH;
      const height = (i === this.numSessions - 1) ? sh - top : sessionH;

      // Fixed header strip (2 lines + border overhead)
      const labelHeight = 3;
      const labelBox = blessed.box({
        top, left: 0,
        width: '100%',
        height: labelHeight,
        tags: true,
        border: { type: 'line' },
        style: {
          fg: COLORS.green,
          bg: COLORS.black,
          border: { fg: COLORS.darkGreen },
        },
      });
      this.screen.append(labelBox);
      this.sessionHeaderBoxes.push(labelBox);

      // Scrollable log area (below the label)
      const scrollTop = top + labelHeight - 1; // overlap border by 1
      const scrollH   = height - labelHeight + 1;

      const scrollBox = blessed.box({
        top: scrollTop, left: 0,
        width: '100%',
        height: Math.max(3, scrollH),
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
      this.screen.append(scrollBox);
      this.sessionScrollBoxes.push(scrollBox);

      this._dirtySessions.add(i);
    }

    this._renderHeader();
    for (let i = 0; i < this.numSessions; i++) {
      this._renderSessionLabel(i);
      this._renderSessionLog(i);
    }
  }

  // ── Header rendering ────────────────────────────────────────────────────────
  _renderHeader() {
    try {
      const sw = this.screen.width - 4;
      const cpu = getCpuPercent();
      const mem = getMemPercent();
      const uptime = formatUptime(Date.now() - this._startTime);
      const clock = formatClock();
      const spark = renderSparkline(_netHistory);
      const netSpeed = formatBytes(_lastNetBytes);

      // CPU bar (small, 8 chars)
      const cpuBar = makeBar(cpu / 100, 8);
      // Mem bar (10 chars)
      const memBar = makeBar(mem.pct / 100, 10);

      // Row 1: Clock  HACKVIEW  CPU%
      const cpuColor = cpu > 80 ? COLORS.red : cpu > 50 ? COLORS.yellow : COLORS.green;
      const title = 'H A C K V I E W';
      const row1 = (
        `{green-fg}{bold}${clock}{/bold}{/green-fg}` +
        `  {bold}{green-fg}${title}{/green-fg}{/bold}` +
        `  {${cpuColor}-fg}▲${String(cpu).padStart(2)}%{/} {#005500-fg}${cpuBar}{/}`
      );

      // Row 2: Mem bar + uptime
      const memColor = mem.pct > 85 ? COLORS.red : mem.pct > 65 ? COLORS.yellow : COLORS.dimGreen;
      const row2 = (
        `{#006666-fg}MEM{/} {${memColor}-fg}${memBar}{/} {#00aa00-fg}${mem.pct}%{/}` +
        `  {#006666-fg}UP{/} {#00aa00-fg}${uptime}{/}`
      );

      // Row 3: Network sparkline
      const row3 = (
        `{#006666-fg}NET{/} {#005500-fg}${spark}{/} {#00aa00-fg}${netSpeed}{/}`
      );

      // Divider
      const div = `{#003300-fg}${'─'.repeat(Math.max(0, sw))}{/}`;

      // Usage rows
      let usageRow1 = '{#006666-fg}  ◈ LOADING USAGE...{/}';
      let usageRow2 = '';

      if (this._usageData) {
        const d = this._usageData;
        const inStr   = formatNum(d.totalInput);
        const outStr  = formatNum(d.totalOutput);
        const costStr = d.totalCost ? `$${d.totalCost.toFixed(2)}` : '$0.00';
        const cacheStr = d.totalCacheRead ? formatNum(d.totalCacheRead) : '0';

        usageRow1 = (
          `{#006666-fg}TODAY{/} {green-fg}{bold}${inStr}{/bold}{/green-fg} in / ` +
          `{green-fg}{bold}${outStr}{/bold}{/green-fg} out` +
          `  {#006666-fg}cached: ${cacheStr}{/}` +
          `  {#00aa00-fg}cost: {bold}${costStr}{/bold}{/}`
        );

        const models = Object.entries(d.modelBreakdown || {});
        if (models.length > 0) {
          const totalTok = models.reduce((s, [, v]) => s + (v.input || 0) + (v.output || 0), 0) || 1;
          const barW = Math.min(8, Math.floor((sw - 20) / Math.max(1, models.length)));
          const parts = models.map(([model, stats]) => {
            const tok   = (stats.input || 0) + (stats.output || 0);
            const ratio = tok / totalTok;
            const bar   = makeBar(ratio, barW);
            return `{#00aa00-fg}${shortModelName(model)}{/} {green-fg}${bar}{/}`;
          });
          const costFmt = `{#00aa00-fg}{bold}${costStr}{/bold}{/}`;
          usageRow2 = `${costFmt}  ` + parts.join('  ');
        }
      }

      const lines = [row1, row2, row3, div, usageRow1];
      if (usageRow2) lines.push(usageRow2);

      this.headerBox.setContent(lines.join('\n'));
    } catch (e) {
      // don't crash
    }
  }

  // ── Session label (fixed header) ─────────────────────────────────────────────
  _getStatusTag(idx) {
    switch (this.sessionStatus[idx]) {
      case 'waiting':   return '{#006666-fg}[waiting]{/}';
      case 'streaming': return '{green-fg}{bold}[streaming▮]{/bold}{/green-fg}';
      case 'thinking':  return '{#005500-fg}[thinking...]{/}';
      case 'idle':      return '{#00aa00-fg}[idle]{/}';
      case 'complete':  return '{#00ffff-fg}[done ✓]{/}';
      default:          return '{#006666-fg}[...]{/}';
    }
  }

  _renderSessionLabel(idx) {
    try {
      const box  = this.sessionHeaderBoxes[idx];
      const file = this.sessionFiles[idx];
      const status = this._getStatusTag(idx);

      let fileInfo = '{#006666-fg}no file{/}';
      if (file) {
        const dir   = path.basename(path.dirname(file));
        const fname = path.basename(file, '.jsonl');
        const shortDir = dir.length > 30 ? '…' + dir.slice(-29) : dir;
        fileInfo = `{#006666-fg}${escTag(shortDir)}/{/}{#00aa00-fg}${escTag(fname.slice(0, 24))}{/}`;
      }

      const label = `{green-fg}{bold} ◉ SESSION ${idx + 1}{/bold}{/green-fg}  ${status}  ${fileInfo}`;
      box.setContent(label);
    } catch (e) {
      // ignore
    }
  }

  // ── Session log area ──────────────────────────────────────────────────────────
  _renderSessionLog(idx) {
    try {
      const box  = this.sessionScrollBoxes[idx];
      const logs = this.sessionLogs[idx];
      box.setContent(logs.join('\n'));
      // Auto-scroll to bottom
      box.setScrollPerc(100);
    } catch (e) {
      // ignore
    }
  }

  _addSessionLine(idx, line) {
    const logs = this.sessionLogs[idx];
    logs.push(line);

    // Keep last 300 lines
    if (logs.length > 300) logs.splice(0, logs.length - 300);

    this._dirtySessions.add(idx);
    this._scheduleRender();
  }

  // ── Throttled render ──────────────────────────────────────────────────────────
  _scheduleRender() {
    if (this._renderPending) return;
    this._renderPending = true;

    // Batch renders: max 20fps (50ms)
    setImmediate(() => {
      this._renderPending = false;
      this._doRender();
    });
  }

  _doRender() {
    try {
      if (this._dirtyHeader) {
        this._renderHeader();
        this._dirtyHeader = false;
      }

      for (const idx of this._dirtySessions) {
        this._renderSessionLabel(idx);
        this._renderSessionLog(idx);
      }
      this._dirtySessions.clear();

      this.screen.render();
    } catch (e) {
      // don't crash
    }
  }

  // ── Timers ────────────────────────────────────────────────────────────────────
  _startTimers() {
    // Clock + system stats: update every second
    this._clockTimer = setInterval(async () => {
      this._dirtyHeader = true;

      // Sample network
      const netVal = await sampleNet().catch(() => 0);
      pushNetSample(netVal);

      this._scheduleRender();
    }, 1000);
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  setFile(sessionIndex, filePath) {
    this.sessionFiles[sessionIndex]  = filePath;
    this.sessionStatus[sessionIndex] = 'idle';
    this._dirtySessions.add(sessionIndex);
    this._scheduleRender();
  }

  setNoFile(sessionIndex) {
    this.sessionFiles[sessionIndex]  = null;
    this.sessionStatus[sessionIndex] = 'waiting';
    this.sessionLogs[sessionIndex]   = [];
    this._dirtySessions.add(sessionIndex);
    this._scheduleRender();
  }

  addEvent(sessionIndex, event) {
    let line = null;
    const ts = new Date().toISOString().substr(11, 8);

    try {
      switch (event.type) {
        case 'session-start':
          line = `{#006666-fg}${ts}{/} {cyan-fg}▶ SESSION STARTED{/}`;
          this.sessionStatus[sessionIndex] = 'idle';
          break;

        case 'user': {
          const text    = event.content || '';
          const preview = escTag(text.replace(/\n/g, ' ').slice(0, 120));
          line = `{#006666-fg}${ts}{/} {#00ffff-fg}▷ USER:{/} {white-fg}${preview}{/}`;
          this.sessionStatus[sessionIndex] = 'streaming';
          break;
        }

        case 'thinking': {
          this.sessionStatus[sessionIndex] = 'thinking';
          const thinkText = event.content || '';
          // Truncate to ~2-3 short lines worth
          const maxLen = 180;
          const truncated = thinkText.replace(/\n/g, ' ').trim().slice(0, maxLen);
          const display   = truncated.length < thinkText.trim().length
            ? truncated + '…'
            : truncated;
          line = `{#006666-fg}${ts}{/} {#004400-fg}💭 ${escTag(display)}{/}`;
          break;
        }

        case 'text': {
          this.sessionStatus[sessionIndex] = 'streaming';
          const text = event.content || '';
          if (!text.trim()) return;
          const preview = escTag(text.replace(/\n/g, ' ').slice(0, 150));
          line = `{#006666-fg}${ts}{/} {green-fg}◎ {/}{white-fg}${preview}{/}`;
          break;
        }

        case 'tool_use':
          this.sessionStatus[sessionIndex] = 'streaming';
          line = `{#006666-fg}${ts}{/} {yellow-fg}⚙ ${escTag(event.content || '')}{/}`;
          break;

        case 'complete': {
          this.sessionStatus[sessionIndex] = 'complete';

          if (event.usage) {
            const u      = event.usage;
            const inTok  = formatNum(u.input_tokens  || 0);
            const outTok = formatNum(u.output_tokens || 0);
            line = `{#006666-fg}${ts}{/} {#00ffff-fg}✓ DONE{/} {#006666-fg}in:${inTok} out:${outTok}{/}`;
          } else {
            line = `{#006666-fg}${ts}{/} {#00ffff-fg}✓ DONE{/}`;
          }

          this._flashComplete(sessionIndex);
          break;
        }

        default:
          return;
      }
    } catch (e) {
      // don't crash on bad events
      return;
    }

    if (line) {
      this._updateSessionBg(sessionIndex);
      this._addSessionLine(sessionIndex, line);
    }
  }

  _updateSessionBg(sessionIndex) {
    try {
      const scrollBox  = this.sessionScrollBoxes[sessionIndex];
      const labelBox   = this.sessionHeaderBoxes[sessionIndex];
      const status     = this.sessionStatus[sessionIndex];

      const isActive = status === 'streaming' || status === 'thinking';
      const bg = isActive ? COLORS.bgActive : COLORS.bgIdle;
      const borderFg = isActive ? COLORS.dimGreen : COLORS.darkGreen;

      scrollBox.style.bg = bg;
      scrollBox.style.border = { fg: borderFg };
      labelBox.style.bg  = bg;
      labelBox.style.border = { fg: borderFg };
    } catch (e) {
      // ignore
    }
  }

  _flashComplete(sessionIndex) {
    try {
      const scrollBox = this.sessionScrollBoxes[sessionIndex];
      const labelBox  = this.sessionHeaderBoxes[sessionIndex];

      if (this.completionTimers[sessionIndex]) {
        clearTimeout(this.completionTimers[sessionIndex]);
      }

      // Flash: bright green
      scrollBox.style.bg = COLORS.bgComplete;
      scrollBox.style.border = { fg: COLORS.brightGreen };
      labelBox.style.bg  = COLORS.bgComplete;
      labelBox.style.border = { fg: COLORS.brightGreen };

      this._dirtySessions.add(sessionIndex);
      this._scheduleRender();

      // Revert after 1.5s
      this.completionTimers[sessionIndex] = setTimeout(() => {
        try {
          scrollBox.style.bg = COLORS.bgIdle;
          scrollBox.style.border = { fg: COLORS.darkGreen };
          labelBox.style.bg  = COLORS.bgIdle;
          labelBox.style.border = { fg: COLORS.darkGreen };
          this.sessionStatus[sessionIndex] = 'idle';
          this._dirtySessions.add(sessionIndex);
          this._scheduleRender();
        } catch (e) {}
      }, 1500);
    } catch (e) {
      // ignore
    }
  }

  updateUsage(data) {
    this._usageData   = data;
    this._dirtyHeader = true;
    this._scheduleRender();
  }

  destroy() {
    if (this._clockTimer) clearInterval(this._clockTimer);
    if (this._renderTimer) clearInterval(this._renderTimer);
    for (const t of this.completionTimers) {
      if (t) clearTimeout(t);
    }
    try { this.screen.destroy(); } catch (e) {}
  }
}

module.exports = { HackviewUI };
