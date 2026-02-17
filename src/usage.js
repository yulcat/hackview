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
  return `${y}-${m}-${day}`;
}

/**
 * Run ccusage and parse the output
 */
function fetchUsage() {
  return new Promise((resolve) => {
    const today = getTodayDate();

    // Try npx ccusage daily --json --since <today>
    execFile('npx', ['--yes', 'ccusage@latest', 'daily', '--json', '--since', today], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        // Try without npx (if globally installed)
        execFile('ccusage', ['daily', '--json', '--since', today], {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        }, (err2, stdout2) => {
          if (err2) {
            resolve(null);
            return;
          }
          resolve(parseUsageOutput(stdout2));
        });
        return;
      }
      resolve(parseUsageOutput(stdout));
    });
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

    // data could be array of daily records or object with totals
    if (Array.isArray(data)) {
      return aggregateUsage(data);
    } else if (data && typeof data === 'object') {
      // single day object
      return formatUsageData(data);
    }
    return null;
  } catch (e) {
    return null;
  }
}

function aggregateUsage(records) {
  const today = getTodayDate();
  const todayRecords = records.filter(r => r.date === today || !r.date);

  if (todayRecords.length === 0 && records.length > 0) {
    // Use most recent
    todayRecords.push(records[records.length - 1]);
  }

  if (todayRecords.length === 0) return null;

  let totalInput = 0, totalOutput = 0, totalCost = 0, totalCacheRead = 0, totalCacheWrite = 0;
  const modelBreakdown = {};

  for (const r of todayRecords) {
    totalInput += r.inputTokens || r.input_tokens || 0;
    totalOutput += r.outputTokens || r.output_tokens || 0;
    totalCost += r.cost || r.totalCost || 0;
    totalCacheRead += r.cacheReadTokens || r.cache_read_input_tokens || 0;
    totalCacheWrite += r.cacheCreationTokens || r.cache_creation_input_tokens || 0;

    // model breakdown
    if (r.models || r.modelBreakdown) {
      const mb = r.models || r.modelBreakdown;
      for (const [model, stats] of Object.entries(mb)) {
        if (!modelBreakdown[model]) modelBreakdown[model] = { input: 0, output: 0, cost: 0 };
        modelBreakdown[model].input += stats.inputTokens || stats.input_tokens || 0;
        modelBreakdown[model].output += stats.outputTokens || stats.output_tokens || 0;
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
  return {
    date: r.date || today,
    totalInput: r.inputTokens || r.input_tokens || 0,
    totalOutput: r.outputTokens || r.output_tokens || 0,
    totalCost: r.cost || r.totalCost || 0,
    totalCacheRead: r.cacheReadTokens || r.cache_read_input_tokens || 0,
    totalCacheWrite: r.cacheCreationTokens || r.cache_creation_input_tokens || 0,
    modelBreakdown: r.models || r.modelBreakdown || {},
  };
}

class UsageMonitor extends EventEmitter {
  constructor(intervalMs = 60000) {
    super();
    this.intervalMs = intervalMs;
    this.timer = null;
    this.lastData = null;
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
      const data = await fetchUsage();
      this.lastData = data;
      this.emit('update', data);
    } catch (e) {
      this.emit('update', this.lastData);
    }
  }
}

module.exports = { UsageMonitor, fetchUsage, formatNum, getTodayDate };
