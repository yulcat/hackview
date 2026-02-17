'use strict';

const path = require('path');
const os = require('os');
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

    // Start usage monitor
    this.usageMonitor = new UsageMonitor(this.usageInterval);
    this.usageMonitor.on('update', (data) => {
      this.ui.updateUsage(data);
    });
    this.usageMonitor.on('block', (block) => {
      this.ui.updateBlock(block);
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
