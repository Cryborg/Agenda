// Récurrence : règles simples (RRULE) pour l'éditeur et pour le mode local.

import { addDays, addMonths, dayDiff, atDayWithTimeOf, startOfDay } from './dates.js';

export const PRESETS = [
  { key: '', label: 'Ne se répète pas' },
  { key: 'DAILY', label: 'Tous les jours', freq: 'DAILY', interval: 1 },
  { key: 'WEEKLY', label: 'Toutes les semaines', freq: 'WEEKLY', interval: 1 },
  { key: 'WEEKLY2', label: 'Toutes les 2 semaines', freq: 'WEEKLY', interval: 2 },
  { key: 'MONTHLY', label: 'Tous les mois', freq: 'MONTHLY', interval: 1 },
  { key: 'YEARLY', label: 'Tous les ans', freq: 'YEARLY', interval: 1 },
];

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRRule(line) {
  if (!line) return null;
  const body = line.replace(/^RRULE:/i, '');
  const out = {};
  for (const part of body.split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.toUpperCase()] = v;
  }
  if (!out.FREQ) return null;
  return out;
}

export const rruleLine = (recurrence) => (recurrence || []).find((l) => /^RRULE:/i.test(l)) || null;

// Retrouve le préréglage correspondant à une règle, ou 'custom'
export function presetOf(line, start) {
  const r = parseRRule(line);
  if (!r) return '';
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'WKST']);
  if (Object.keys(r).some((k) => !known.has(k))) return 'custom';
  const interval = Number(r.INTERVAL || 1);
  if (r.BYDAY && !(r.FREQ === 'WEEKLY' && r.BYDAY === BYDAY[start.getDay()])) return 'custom';
  const p = PRESETS.find((p) => p.freq === r.FREQ && p.interval === interval);
  return p ? p.key : 'custom';
}

export function presetToRRule(key) {
  const p = PRESETS.find((p) => p.key === key);
  if (!p || !p.freq) return null;
  return `RRULE:FREQ=${p.freq}${p.interval > 1 ? `;INTERVAL=${p.interval}` : ''}`;
}

export function describe(line, start) {
  const key = presetOf(line, start);
  if (key === 'custom') return 'Récurrence personnalisée';
  return PRESETS.find((p) => p.key === key)?.label || '';
}

function parseUntil(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v || '');
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59', s = '59', z] = m;
  return z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
}

// Occurrences d'un événement récurrent qui touchent [rangeStart, rangeEnd[.
// `master` : { start, end, rrule, exdates: [ms] }. Renvoie [{ start, end }].
export function expand(master, rangeStart, rangeEnd, maxIter = 5000) {
  const r = parseRRule(master.rrule);
  if (!r) {
    const { start, end } = master;
    const hit = start < rangeEnd && (end > rangeStart || (+start === +end && start >= rangeStart));
    return hit ? [{ start, end }] : [];
  }
  const interval = Math.max(1, Number(r.INTERVAL || 1));
  const count = r.COUNT ? Number(r.COUNT) : Infinity;
  const until = r.UNTIL ? parseUntil(r.UNTIL) : null;
  const ex = new Set(master.exdates || []);
  const spanDays = dayDiff(master.start, master.end);
  const out = [];
  const step = (k) => {
    switch (r.FREQ) {
      case 'DAILY': return addDays(master.start, k * interval);
      case 'WEEKLY': return addDays(master.start, 7 * k * interval);
      case 'MONTHLY': return addMonths(master.start, k * interval);
      case 'YEARLY': return addMonths(master.start, 12 * k * interval);
      default: return null;
    }
  };
  for (let k = 0; k < Math.min(count, maxIter); k++) {
    const start = step(k);
    if (!start || start >= rangeEnd || (until && start > until)) break;
    // Durée recalculée en jours + heure de fin, pour survivre aux changements d'heure
    const end = atDayWithTimeOf(addDays(startOfDay(start), spanDays), master.end);
    if (end > rangeStart && !ex.has(start.getTime())) out.push({ start, end });
  }
  return out;
}
