'use strict';

const { execFile } = require('child_process');
const { EventEmitter } = require('events');

function formatNum(n) {
  if (!n) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

function getTodayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function getTodayDateHyphen() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Run ccusage and parse the output
 */
function fetchUsage() {
  return new Promise((resolve) => {
    const today = getTodayDate();

    const { exec } = require('child_process');
    const args = `--yes ccusage@latest daily --json --since ${today}`;
    // Try multiple npx locations (homebrew, nvm, system)
    const npxPaths = [
      'npx',
      '/opt/homebrew/bin/npx',
      '/usr/local/bin/npx',
      `${process.env.HOME}/.nvm/versions/node/${process.version}/bin/npx`,
    ];

    const errors = [];
    const tryNext = (idx) => {
      if (idx >= npxPaths.length) {
        resolve({ _error: true, message: errors.join(' | ') || 'all npx paths failed' });
        return;
      }
      const cmd = `${npxPaths[idx]} ${args}`;
      exec(cmd, {
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
        shell: '/bin/bash',
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      }, (err, stdout, stderr) => {
        if (err || !stdout.trim()) {
          const errMsg = `[${npxPaths[idx]}] ${err ? err.message.split('\n')[0] : 'empty output'}`;
          errors.push(errMsg);
          tryNext(idx + 1);
          return;
        }
        const result = parseUsageOutput(stdout);
        if (result) { resolve(result); } else {
          errors.push(`[${npxPaths[idx]}] parse failed: ${stdout.slice(0, 100)}`);
          tryNext(idx + 1);
        }
      });
    };
    tryNext(0);
  });
}

function parseUsageOutput(stdout) {
  try {
    // ccusage might output multiple lines; find the JSON part
    const lines = stdout.trim().split('\n');
    let jsonStr = null;

    // Try to find a JSON array or object
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('[') || line.startsWith('{')) {
        // Collect until end of JSON
        jsonStr = lines.slice(i).join('\n');
        break;
      }
    }

    if (!jsonStr) return null;

    const data = JSON.parse(jsonStr);

    // ccusage wraps in {daily: [...], totals: {...}}
    if (data && data.daily && Array.isArray(data.daily)) {
      return aggregateUsage(data.daily);
    } else if (Array.isArray(data)) {
      return aggregateUsage(data);
    } else if (data && typeof data === 'object') {
      return formatUsageData(data);
    }
    return null;
  } catch (e) {
    return null;
  }
}

function aggregateUsage(records) {
  const today = getTodayDateHyphen();
  const todayCompact = getTodayDate();
  const todayRecords = records.filter(r => r.date === today || r.date === todayCompact);

  if (todayRecords.length === 0 && records.length > 0) {
    todayRecords.push(records[records.length - 1]);
  }

  if (todayRecords.length === 0) return null;

  let totalInput = 0, totalOutput = 0, totalCost = 0, totalCacheRead = 0, totalCacheWrite = 0;
  const modelBreakdown = {};

  for (const r of todayRecords) {
    totalInput += r.inputTokens || 0;
    totalOutput += r.outputTokens || 0;
    totalCost += r.totalCost || r.cost || 0;
    totalCacheRead += r.cacheReadTokens || 0;
    totalCacheWrite += r.cacheCreationTokens || 0;

    // ccusage format: modelBreakdowns is an array of {modelName, inputTokens, ...}
    const breakdowns = r.modelBreakdowns || r.modelBreakdown || [];
    if (Array.isArray(breakdowns)) {
      for (const mb of breakdowns) {
        const name = mb.modelName || mb.model || 'unknown';
        if (!modelBreakdown[name]) modelBreakdown[name] = { input: 0, output: 0, cost: 0 };
        modelBreakdown[name].input += mb.inputTokens || 0;
        modelBreakdown[name].output += mb.outputTokens || 0;
        modelBreakdown[name].cost += mb.cost || 0;
      }
    } else if (typeof breakdowns === 'object') {
      for (const [model, stats] of Object.entries(breakdowns)) {
        if (!modelBreakdown[model]) modelBreakdown[model] = { input: 0, output: 0, cost: 0 };
        modelBreakdown[model].input += stats.inputTokens || 0;
        modelBreakdown[model].output += stats.outputTokens || 0;
        modelBreakdown[model].cost += stats.cost || 0;
      }
    }
  }

  return {
    date: today,
    totalInput,
    totalOutput,
    totalCost,
    totalCacheRead,
    totalCacheWrite,
    modelBreakdown,
  };
}

function formatUsageData(r) {
  const today = getTodayDate();
  const modelBreakdown = {};
  const breakdowns = r.modelBreakdowns || r.modelBreakdown || [];
  if (Array.isArray(breakdowns)) {
    for (const mb of breakdowns) {
      const name = mb.modelName || mb.model || 'unknown';
      modelBreakdown[name] = { input: mb.inputTokens || 0, output: mb.outputTokens || 0, cost: mb.cost || 0 };
    }
  }
  return {
    date: r.date || today,
    totalInput: r.inputTokens || 0,
    totalOutput: r.outputTokens || 0,
    totalCost: r.totalCost || r.cost || 0,
    totalCacheRead: r.cacheReadTokens || 0,
    totalCacheWrite: r.cacheCreationTokens || 0,
    modelBreakdown,
  };
}

/**
 * Fetch active block info from ccusage blocks --active --json
 */
function fetchActiveBlock() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const args = `--yes ccusage@latest blocks --active --json`;
    const npxPaths = [
      'npx',
      '/opt/homebrew/bin/npx',
      '/usr/local/bin/npx',
      `${process.env.HOME}/.nvm/versions/node/${process.version}/bin/npx`,
    ];

    const tryNext = (idx) => {
      if (idx >= npxPaths.length) {
        resolve(null);
        return;
      }
      const cmd = `${npxPaths[idx]} ${args}`;
      exec(cmd, {
        timeout: 45000,
        maxBuffer: 2 * 1024 * 1024,
        shell: '/bin/bash',
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
      }, (err, stdout) => {
        if (err || !stdout.trim()) {
          tryNext(idx + 1);
          return;
        }
        try {
          const data = JSON.parse(stdout.trim());
          const blocks = data.blocks || [];
          if (blocks.length > 0) {
            const b = blocks[0];
            resolve({
              startTime: b.startTime,
              endTime: b.endTime,
              costUSD: b.costUSD || 0,
              totalTokens: b.totalTokens || 0,
              tokenCounts: b.tokenCounts || {},
              models: b.models || [],
              burnRate: b.burnRate,
              projection: b.projection,
              isActive: true,
            });
          } else {
            resolve(null); // no active block
          }
        } catch (e) {
          tryNext(idx + 1);
        }
      });
    };
    tryNext(0);
  });
}

class UsageMonitor extends EventEmitter {
  constructor(intervalMs = 60000) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastData = null;
    this.lastBlock = null;
  }

  start() {
    this._fetch();
    this.timer = setInterval(() => this._fetch(), this.intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async _fetch() {
    try {
      const [data, block] = await Promise.all([fetchUsage(), fetchActiveBlock()]);
      this.lastData = data || this.lastData;
      this.lastBlock = block || this.lastBlock;
      this.emit('update', this.lastData);
      this.emit('block', this.lastBlock);
    } catch (e) {
      this.emit('update', this.lastData);
      this.emit('block', this.lastBlock);
    }
  }
}

module.exports = { UsageMonitor, fetchUsage, fetchActiveBlock, formatNum, getTodayDate };
