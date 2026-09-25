// Helpers de dates en heure locale. Tout passe par les composantes locales
// (année, mois, jour) pour rester juste lors des changements d'heure.

export const DAY_MS = 86400000;
export const HOUR_MS = 3600000;

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export const addDays = (d, n) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());

export function addMonths(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes(), d.getSeconds());
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last));
  return r;
}

// Semaine du lundi au dimanche
export function startOfWeek(d) {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

export const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const dayRange = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i));

// Nombre de jours calendaires entre deux dates (insensible à l'heure et au DST)
export const dayDiff = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);

// Place `time` sur le jour `day` en gardant son heure locale
export function atDayWithTimeOf(day, time) {
  const r = startOfDay(day);
  r.setHours(time.getHours(), time.getMinutes(), time.getSeconds(), 0);
  return r;
}

// Décale `date` du même nombre de jours que from -> to, et prend l'heure de `to`.
// Sert à répercuter la modification d'une occurrence sur l'événement maître d'une série.
export const shiftLike = (date, from, to) => atDayWithTimeOf(addDays(startOfDay(date), dayDiff(from, to)), to);

export const pad = (n) => String(n).padStart(2, '0');
export const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toTimeInput = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function combine(dateStr, timeStr) {
  const d = parseDate(dateStr);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  d.setHours(h, mi, 0, 0);
  return d;
}

export function toRFC3339(d) {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${toDateInput(d)}T${toTimeInput(d)}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function tzLabel(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60;
  return `GMT${off >= 0 ? '+' : '-'}${pad(h)}${m ? ':' + pad(m) : ''}`;
}

// Formats français
const F = (opts) => new Intl.DateTimeFormat('fr-FR', opts);
const fDow = F({ weekday: 'short' });
const fDowLong = F({ weekday: 'long' });
const fMonthYear = F({ month: 'long', year: 'numeric' });
const fDayMonth = F({ day: 'numeric', month: 'short' });
const fDayMonthYear = F({ day: 'numeric', month: 'short', year: 'numeric' });
const fFull = F({ weekday: 'long', day: 'numeric', month: 'long' });
const fFullYear = F({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fShort = F({ weekday: 'short', day: 'numeric', month: 'short' });

export const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fmtDow = (d) => fDow.format(d);
export const fmtDowLong = (d) => fDowLong.format(d);
export const fmtMonthYear = (d) => fMonthYear.format(d);
export const fmtDayMonth = (d) => fDayMonth.format(d);
export const fmtDayMonthYear = (d) => fDayMonthYear.format(d);
export const fmtFull = (d) => (d.getFullYear() === new Date().getFullYear() ? fFull : fFullYear).format(d);
export const fmtShort = (d) => fShort.format(d);
export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
