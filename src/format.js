'use strict';
// Transcript conversions. Segments are { start, end (ms), speaker?, text }; notes store them in
// Alt's transcript format (entries with segments, ms) and exports follow the recipes in Alt's guide.

/** Flat segments → Alt transcript content (array of entries). */
function toAltEntries(segments) {
  return segments.map(s => ({
    ...(s.speaker ? { speaker: s.speaker } : {}),
    segments: [{ start: s.start, end: s.end, text: s.text, ...(s.speaker ? { speaker: s.speaker } : {}) }],
  }));
}

/**
 * Alt transcript content → flat segments. Handles current entries ({ segments }) and old ones
 * that only have originalText/relativeStart (ms), which end at the next entry's start.
 */
function fromAltEntries(entries) {
  const out = [];
  entries.forEach((entry, i) => {
    if (Array.isArray(entry.segments)) {
      for (const s of entry.segments) {
        out.push({
          start: s.start,
          end: s.end,
          speaker: s.speaker || entry.speaker,
          text: s.text,
          ...(s.translatedText ? { translatedText: s.translatedText } : {}),
        });
      }
    } else if (typeof entry.originalText === 'string') {
      const next = entries[i + 1];
      const start = entry.relativeStart ?? 0;
      out.push({
        start,
        end: next?.relativeStart ?? start + 3000,
        speaker: entry.speaker,
        text: entry.originalText,
      });
    }
  });
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function clock(ms, sep) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(t % 1000, 3)}`;
}
function shortClock(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(t % 60)}` : `${pad(m)}:${pad(t % 60)}`;
}

const label = (s, names) => (s.speaker ? names?.[s.speaker] || s.speaker : null);

function render(segments, fmt, { speakerNames = {}, title = 'Transcript' } = {}) {
  switch (fmt) {
    case 'srt':
      return segments
        .map((s, i) => {
          const who = label(s, speakerNames);
          return `${i + 1}\n${clock(s.start, ',')} --> ${clock(s.end, ',')}\n${who ? `[${who}] ` : ''}${s.text}\n`;
        })
        .join('\n');
    case 'vtt':
      return `WEBVTT\n\n${segments
        .map(s => {
          const who = label(s, speakerNames);
          return `${clock(s.start, '.')} --> ${clock(s.end, '.')}\n${who ? `<v ${who}>` : ''}${s.text}\n`;
        })
        .join('\n')}`;
    case 'txt':
      return `${segments.map(s => s.text).join('\n')}\n`;
    case 'md': {
      // Consecutive segments from one speaker become one paragraph.
      const lines = [`# ${title}`, ''];
      let prev;
      for (const s of segments) {
        const who = label(s, speakerNames);
        if (who !== prev || !who) {
          lines.push(who ? `**${who}** (${shortClock(s.start)})` : `(${shortClock(s.start)})`);
        }
        lines.push(`${s.text}`, '');
        prev = who;
      }
      return `${lines.join('\n').trimEnd()}\n`;
    }
    case 'json':
      return `${JSON.stringify(segments, null, 2)}\n`;
    default:
      throw new Error(`Unknown format ${fmt} (json, srt, vtt, txt, md)`);
  }
}

const FORMATS = ['json', 'srt', 'vtt', 'txt', 'md'];

module.exports = { toAltEntries, fromAltEntries, render, clock, FORMATS };
