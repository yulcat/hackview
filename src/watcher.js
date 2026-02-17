'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const { parseRecord, extractEvent } = require('./parser');

/**
 * Find the most recently modified .jsonl files in a directory
 * Returns sorted array of { file, mtime }
 */
function findLatestJsonl(dir, nth = 0) {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const full = path.join(dir, f);
        try {
          const stat = fs.statSync(full);
          return { file: full, mtime: stat.mtimeMs };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > nth ? files[nth].file : null;
  } catch (e) {
    return null;
  }
}

/**
 * Read all existing lines from a file
 */
function readAllLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').filter(l => l.trim());
  } catch (e) {
    return [];
  }
}

class SessionWatcher extends EventEmitter {
  constructor(dirs, sessionIndex) {
    super();
    this.dirs = dirs; // array of directories to watch
    this.sessionIndex = sessionIndex;
    this.currentFile = null;
    this.fileSize = 0;
    this.watcher = null;
    this.dirWatcher = null;
    this.checkInterval = null;
    this.messageStates = new Map(); // messageId -> accumulated state
  }

  start() {
    // Poll for the best file every 5 seconds
    this._checkForNewFile();
    this.checkInterval = setInterval(() => this._checkForNewFile(), 5000);

    // Also watch directories for new files
    const validDirs = this.dirs.filter(d => {
      try { fs.accessSync(d); return true; } catch (e) { return false; }
    });

    if (validDirs.length > 0) {
      try {
        this.dirWatcher = chokidar.watch(validDirs, {
          depth: 0,
          ignoreInitial: true,
          persistent: true,
        });
        this.dirWatcher.on('add', (filePath) => {
          if (filePath.endsWith('.jsonl')) {
            this._checkForNewFile();
          }
        });
      } catch (e) {
        // ignore
      }
    }
  }

  stop() {
    if (this.checkInterval) clearInterval(this.checkInterval);
    if (this.watcher) { try { this.watcher.close(); } catch (e) {} }
    if (this.dirWatcher) { try { this.dirWatcher.close(); } catch (e) {} }
  }

  _getBestFile() {
    // Collect ALL jsonl files from all dirs, sorted by mtime
    const allFiles = [];

    for (const dir of this.dirs) {
      try {
        const files = fs.readdirSync(dir)
          .filter(f => f.endsWith('.jsonl'))
          .map(f => {
            const full = path.join(dir, f);
            try {
              const stat = fs.statSync(full);
              return { file: full, mtime: stat.mtimeMs };
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean);
        allFiles.push(...files);
      } catch (e) {}
    }

    allFiles.sort((a, b) => b.mtime - a.mtime);

    // Pick the Nth most recent file (sessionIndex 0 = newest, 1 = 2nd newest, etc.)
    const nth = this.sessionIndex;
    return allFiles.length > nth ? allFiles[nth].file : null;
  }

  _checkForNewFile() {
    const best = this._getBestFile();

    if (best !== this.currentFile) {
      // Switch to new file
      if (this.watcher) {
        try { this.watcher.close(); } catch (e) {}
        this.watcher = null;
      }

      this.currentFile = best;
      this.messageStates.clear();

      if (best) {
        this.emit('file-change', { file: best, sessionIndex: this.sessionIndex });
        this._loadFile(best);
      } else {
        this.emit('no-file', { sessionIndex: this.sessionIndex });
      }
    }
  }

  _loadFile(filePath) {
    // Read existing content
    const lines = readAllLines(filePath);
    try {
      this.fileSize = fs.statSync(filePath).size;
    } catch (e) {
      this.fileSize = 0;
    }

    // Emit historical events (last 50 lines to avoid flooding)
    const recentLines = lines.slice(-50);
    for (const line of recentLines) {
      this._processLine(line, true);
    }

    // Watch for new content
    try {
      this.watcher = chokidar.watch(filePath, {
        persistent: true,
        usePolling: false,
        awaitWriteFinish: false,
      });

      this.watcher.on('change', () => {
        this._readNewContent(filePath);
      });
    } catch (e) {
      // ignore
    }
  }

  _readNewContent(filePath) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size <= this.fileSize) return;

      const fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(stat.size - this.fileSize);
      fs.readSync(fd, buffer, 0, buffer.length, this.fileSize);
      fs.closeSync(fd);

      this.fileSize = stat.size;
      const newContent = buffer.toString('utf8');
      const lines = newContent.split('\n').filter(l => l.trim());

      for (const line of lines) {
        this._processLine(line, false);
      }
    } catch (e) {
      // ignore
    }
  }

  _processLine(line, isHistory) {
    const record = parseRecord(line);
    if (!record) return;

    const events = extractEvent(record);
    if (!events) return;

    const eventList = Array.isArray(events) ? events : [events];

    for (const event of eventList) {
      if (!event) continue;

      // Merge assistant chunks with same messageId
      if (event.messageId && (event.type === 'text' || event.type === 'thinking' || event.type === 'tool_use')) {
        const key = `${event.messageId}:${event.type}:${event.toolName || ''}`;

        if (this.messageStates.has(key)) {
          const existing = this.messageStates.get(key);
          // Update content (append new text)
          const prevContent = existing.content || '';
          const newContent = event.content || '';
          // Only emit if content actually changed
          if (event.type === 'text' && newContent.length > prevContent.length) {
            existing.content = newContent;
            existing.isComplete = event.isComplete;
            if (event.usage) existing.usage = event.usage;
            if (!isHistory) {
              this.emit('event', { ...existing, sessionIndex: this.sessionIndex, isUpdate: true });
            }
          } else if (event.isComplete && !existing.isComplete) {
            existing.isComplete = true;
            if (event.usage) existing.usage = event.usage;
            if (!isHistory) {
              this.emit('event', { ...existing, sessionIndex: this.sessionIndex, isUpdate: true });
            }
          }
          return;
        } else {
          this.messageStates.set(key, { ...event });
        }
      }

      this.emit('event', { ...event, sessionIndex: this.sessionIndex, isHistory, isUpdate: false });
    }
  }
}

module.exports = { SessionWatcher, findLatestJsonl };
