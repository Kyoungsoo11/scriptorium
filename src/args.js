'use strict';
// Minimal option parser: --key value, --key=value, --flag, --no-flag, and positionals.

const { UsageError } = require('./store');

/**
 * @param {string[]} argv
 * @param {{ booleans?: string[], values?: string[] }} spec  options a command accepts
 */
function parseArgs(argv, spec) {
  const booleans = new Set(spec.booleans || []);
  const values = new Set(spec.values || []);
  const opts = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    let [key, inline] = arg.slice(2).split(/=(.*)/s);
    if (booleans.has(key)) {
      opts[key] = inline === undefined ? true : !/^(false|0|no)$/i.test(inline);
    } else if (key.startsWith('no-') && booleans.has(key.slice(3))) {
      opts[key.slice(3)] = false;
    } else if (values.has(key)) {
      const value = inline !== undefined ? inline : argv[++i];
      if (value === undefined) throw new UsageError(`--${key} needs a value`);
      opts[key] = value;
    } else {
      throw new UsageError(`Unknown option --${key}`);
    }
  }
  return { opts, positionals };
}

/** "90", "90s", "15m", "1h30m", "1:30:00" → seconds. */
function parseDuration(text) {
  const s = String(text).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  const m = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i.exec(s);
  if (!m || !(m[1] || m[2] || m[3])) throw new UsageError(`Bad duration "${text}" (e.g. 90s, 15m, 1h30m)`);
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

module.exports = { parseArgs, parseDuration };
