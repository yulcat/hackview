#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const minimist = require('minimist');

const argv = minimist(process.argv.slice(2), {
  string: ['dirs', 'config'],
  number: ['sessions', 'budget'],
  boolean: ['help', 'version'],
  alias: {
    h: 'help',
    v: 'version',
    d: 'dirs',
    s: 'sessions',
    c: 'config',
    b: 'budget',
  },
  default: {
    sessions: 2,
    budget: 40,
  },
});

if (argv.version) {
  const pkg = require('../package.json');
  console.log(`hackview v${pkg.version}`);
  process.exit(0);
}

if (argv.help) {
  console.log(`
  ██╗  ██╗ █████╗  ██████╗██╗  ██╗██╗   ██╗██╗███████╗██╗    ██╗
  ██║  ██║██╔══██╗██╔════╝██║ ██╔╝██║   ██║██║██╔════╝██║    ██║
  ███████║███████║██║     █████╔╝ ██║   ██║██║█████╗  ██║ █╗ ██║
  ██╔══██║██╔══██║██║     ██╔═██╗ ╚██╗ ██╔╝██║██╔══╝  ██║███╗██║
  ██║  ██║██║  ██║╚██████╗██║  ██╗ ╚████╔╝ ██║███████╗╚███╔███╔╝
  ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝ ╚══╝╚══╝

  Usage: hackview [options]

  Options:
    -d, --dirs <dirs>        Comma-separated list of .claude/projects dirs to watch
                             Default: ~/.claude/projects
    -s, --sessions <n>       Number of session panels to show (default: 2)
    -b, --budget <dollars>   Session budget in USD (default: 40)
    -c, --config <file>      Path to config JSON file
    -v, --version            Show version
    -h, --help               Show this help

  Examples:
    hackview
    hackview --dirs ~/.claude/projects/-Users-gon
    hackview --dirs ~/.claude/projects/-Users-gon,-Users-gon-work --sessions 3
    hackview --budget 80
    hackview --sessions 1

  Config file format (~/.hackview.json):
    {
      "dirs": ["~/.claude/projects/-Users-gon"],
      "sessions": 2,
      "budget": 40
    }

  Press Ctrl+C or 'q' to quit.
`);
  process.exit(0);
}

// Load config file
let configDirs = [];
let configSessions = null;

const configPaths = [
  argv.config,
  path.join(os.homedir(), '.hackview.json'),
  path.join(process.cwd(), '.hackview.json'),
].filter(Boolean);

for (const cfgPath of configPaths) {
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.dirs) configDirs = Array.isArray(cfg.dirs) ? cfg.dirs : [cfg.dirs];
    if (cfg.sessions) configSessions = cfg.sessions;
    if (cfg.budget) argv.budget = argv.budget === 40 ? cfg.budget : argv.budget;
    break;
  } catch (e) {
    // not found or parse error, continue
  }
}

// Resolve dirs
function resolveDirs(dirsArg) {
  if (!dirsArg) return [];
  const parts = dirsArg.split(',').map(d => d.trim()).filter(Boolean);
  return parts.map(d => {
    if (d.startsWith('~')) return path.join(os.homedir(), d.slice(1));
    return path.resolve(d);
  });
}

let dirs = [];

if (argv.dirs) {
  dirs = resolveDirs(argv.dirs);
} else if (configDirs.length > 0) {
  dirs = resolveDirs(configDirs.join(','));
} else {
  // Default: ~/.claude/projects
  dirs = [path.join(os.homedir(), '.claude', 'projects')];
}

// If dirs are top-level (contain subdirs with jsonl files), expand one level
const expandedDirs = [];
for (const d of dirs) {
  try {
    const stat = fs.statSync(d);
    if (!stat.isDirectory()) continue;

    const children = fs.readdirSync(d);
    const hasJsonl = children.some(f => f.endsWith('.jsonl'));

    if (hasJsonl) {
      expandedDirs.push(d);
    } else {
      // Check if it's a parent of project dirs
      const subDirs = children
        .map(c => path.join(d, c))
        .filter(c => {
          try { return fs.statSync(c).isDirectory(); } catch (e) { return false; }
        });

      if (subDirs.length > 0) {
        expandedDirs.push(...subDirs);
      } else {
        expandedDirs.push(d);
      }
    }
  } catch (e) {
    // Directory doesn't exist - still add it, watcher will handle
    expandedDirs.push(d);
  }
}

const sessions = argv.sessions || configSessions || 2;

// Start the app
const { HackviewApp } = require('../src/app');

const budget = argv.budget || 40;

const app = new HackviewApp({
  dirs: expandedDirs.length > 0 ? expandedDirs : dirs,
  sessions,
  budget,
});

process.on('uncaughtException', (e) => {
  // Silently ignore to prevent crash
});

process.on('unhandledRejection', (e) => {
  // Silently ignore
});

process.on('SIGINT', () => {
  app.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  app.stop();
  process.exit(0);
});

app.start();
