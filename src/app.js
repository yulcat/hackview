'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { HackviewUI } = require('./ui');
const { SessionWatcher } = require('./watcher');
const { UsageMonitor } = require('./usage');

class HackviewApp {
  constructor(opts) {
    this.dirs = opts.dirs || [];
    this.numSessions = opts.sessions || 2;
    this.usageInterval = opts.usageInterval || 60000;
    this.budget = opts.budget || 40;
    this.blockHours = opts.blockHours || 5;

    this.ui = new HackviewUI(this.numSessions, this.budget, this.blockHours);
    this.watchers = [];
    this.usageMonitor = null;
  }

  start() {
    // Initialize UI
    this.ui.init();

    // Start session watchers
    for (let i = 0; i < this.numSessions; i++) {
      this._startWatcher(i);
    }

    // Detect block start from earliest session file today
    this._detectBlockStart();

    // Start usage monitor
    this.usageMonitor = new UsageMonitor(this.usageInterval);
    this.usageMonitor.on('update', (data) => {
      this.ui.updateUsage(data);
    });
    this.usageMonitor.start();
  }

  _startWatcher(sessionIndex) {
    // Each session watches all dirs but picks the Nth most recent file
    // For now, watchers share dirs but independently find their best file
    // We can later make them pick different files

    const watcher = new SessionWatcher(this.dirs, sessionIndex);

    watcher.on('file-change', ({ file }) => {
      this.ui.setFile(sessionIndex, file);
    });

    watcher.on('no-file', () => {
      this.ui.setNoFile(sessionIndex);
    });

    watcher.on('event', (event) => {
      this.ui.addEvent(sessionIndex, event);
    });

    watcher.start();
    this.watchers.push(watcher);
  }

  _detectBlockStart() {
    // Find the earliest .jsonl file created today across all watched dirs
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    let earliest = null;

    for (const dir of this.dirs) {
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const full = path.join(dir, f);
          try {
            const stat = fs.statSync(full);
            // Use birthtime (creation) if available, else mtime
            const created = stat.birthtimeMs || stat.mtimeMs;
            if (created >= todayStart) {
              if (earliest === null || created < earliest) {
                earliest = created;
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    if (earliest) {
      this.ui.blockStartMs = earliest;
    }
    // Re-check every 30s in case new sessions start
    setInterval(() => this._detectBlockStart(), 30000);
  }

  stop() {
    for (const w of this.watchers) {
      try { w.stop(); } catch (e) {}
    }
    if (this.usageMonitor) {
      try { this.usageMonitor.stop(); } catch (e) {}
    }
    this.ui.destroy();
  }
}

module.exports = { HackviewApp };
