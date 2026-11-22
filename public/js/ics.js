// Builds an iCalendar (.ics) file in the browser so releases can be imported into
// Google, Apple or Outlook Calendar. All-day events; one per release date.
import { addDays, isValid } from './dates.js';

const escText = (s) => String(s ?? '')
  .replace(/\\/g, '\\\\')
  .replace(/\r?\n/g, '\\n')
  .replace(/([,;])/g, '\\$1');

// RFC 5545: lines longer than 75 octets are folded with CRLF + one space.
function fold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * events: [{ uid, date: 'YYYY-MM-DD', summary, description?, url? }]
 */
export function buildIcs(events, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//OTT Radar India//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'X-WR-CALNAME:OTT Radar',
  ];
  for (const e of events) {
    if (!isValid(e.date)) continue;
    const start = e.date.replace(/-/g, '');
    const end = addDays(e.date, 1).replace(/-/g, '');
    lines.push(
      'BEGIN:VEVENT',
      `UID:${String(e.uid).replace(/[^\w.:-]/g, '')}-${start}@ott-radar-india`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${escText(e.summary)}`,
    );
    if (e.description) lines.push(`DESCRIPTION:${escText(e.description)}`);
    if (e.url && /^https?:\/\//.test(e.url)) lines.push(`URL:${e.url}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}

export function downloadIcs(text, filename) {
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
