'use strict';

/**
 * Parse a single JSONL record from Claude Code session logs
 */

function parseRecord(line) {
  try {
    const record = JSON.parse(line.trim());
    return record;
  } catch (e) {
    return null;
  }
}

/**
 * Extract display-friendly event from a record
 * Returns: { type, content, messageId, isComplete, usage } or null
 */
function extractEvent(record) {
  if (!record || !record.type) return null;

  try {
    switch (record.type) {
      case 'queue-operation': {
        if (record.operation === 'dequeue') {
          return { type: 'session-start', content: 'Session started', messageId: null, isComplete: false };
        }
        return null;
      }

      case 'file-history-snapshot':
        return null; // ignore

      case 'user': {
        const msg = record.message;
        if (!msg) return null;
        const content = extractUserContent(msg.content);
        if (!content) return null;
        return {
          type: 'user',
          content,
          messageId: msg.id || null,
          isComplete: true,
          usage: null,
        };
      }

      case 'assistant': {
        const msg = record.message;
        if (!msg) return null;

        const events = [];
        const contentBlocks = msg.content || [];

        for (const block of contentBlocks) {
          if (block.type === 'thinking') {
            events.push({
              type: 'thinking',
              content: block.thinking ? block.thinking.slice(0, 80) + '...' : 'thinking...',
              messageId: msg.id,
              isComplete: msg.stop_reason !== null,
              usage: msg.usage || null,
            });
          } else if (block.type === 'text') {
            events.push({
              type: 'text',
              content: block.text || '',
              messageId: msg.id,
              isComplete: msg.stop_reason !== null,
              usage: msg.usage || null,
            });
          } else if (block.type === 'tool_use') {
            const inputSummary = summarizeInput(block.input);
            events.push({
              type: 'tool_use',
              content: `${block.name}(${inputSummary})`,
              toolName: block.name,
              messageId: msg.id,
              isComplete: msg.stop_reason !== null,
              usage: msg.usage || null,
            });
          }
        }

        if (events.length === 0 && msg.stop_reason !== null) {
          // completion signal with no content
          return [{
            type: 'complete',
            content: `[${msg.stop_reason}]`,
            messageId: msg.id,
            isComplete: true,
            usage: msg.usage || null,
          }];
        }

        return events.length > 0 ? events : null;
      }

      default:
        return null;
    }
  } catch (e) {
    return null;
  }
}

function extractUserContent(content) {
  if (!content) return null;
  if (typeof content === 'string') {
    return content.slice(0, 200);
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block.type === 'text') {
        parts.push(block.text ? block.text.slice(0, 200) : '');
      } else if (block.type === 'tool_result') {
        const resultContent = block.content;
        let summary = '[tool result]';
        if (typeof resultContent === 'string') {
          summary = `[result: ${resultContent.slice(0, 60)}]`;
        } else if (Array.isArray(resultContent)) {
          const text = resultContent.find(b => b.type === 'text');
          if (text) summary = `[result: ${text.text.slice(0, 60)}]`;
        }
        parts.push(summary);
      } else if (block.type === 'image') {
        parts.push('[image]');
      }
    }
    return parts.join(' ').slice(0, 300) || null;
  }
  return null;
}

function summarizeInput(input) {
  if (!input) return '';
  try {
    const keys = Object.keys(input);
    if (keys.length === 0) return '';

    // prioritize common meaningful keys
    const priority = ['command', 'path', 'file_path', 'url', 'query', 'pattern', 'description'];
    for (const key of priority) {
      if (input[key] !== undefined) {
        const val = String(input[key]);
        return val.slice(0, 50);
      }
    }

    // fallback: first key
    const firstKey = keys[0];
    const val = String(input[firstKey]);
    return `${firstKey}=${val.slice(0, 40)}`;
  } catch (e) {
    return '';
  }
}

module.exports = { parseRecord, extractEvent, summarizeInput };
