// Agenda local (stocké dans le navigateur). Sert de mode démo et de mode
// hors ligne, avec la même interface que le store Google.

import { addDays, parseDate, toDateInput, toRFC3339, startOfWeek, startOfDay, shiftLike } from './dates.js';
import { expand } from './recur.js';

const KEY = 'agenda.local.v1';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function serialize(d, allDay) {
  return allDay ? toDateInput(d) : toRFC3339(d);
}
function revive(s, allDay) {
  return allDay ? parseDate(s) : new Date(s);
}

function seed() {
  const monday = startOfWeek(new Date());
  const at = (dayOffset, h, m = 0) => {
    const d = addDays(monday, dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const ev = (o) => ({
    id: uid(),
    location: '',
    description: '',
    colorId: null,
    people: [],
    rrule: null,
    exdates: [],
    allDay: false,
    ...o,
    start: serialize(o.start, o.allDay),
    end: serialize(o.end, o.allDay),
  });
  return {
    calendars: [
      { id: 'perso', name: 'Perso', color: '#039be5', primary: true },
      { id: 'garde', name: 'Garde des enfants', color: '#e67c73' },
      { id: 'famille', name: 'Famille', color: '#33b679' },
    ],
    events: [
      // Garde alternée : relais le vendredi à 19:00, une semaine sur deux
      ev({ calendarId: 'garde', title: 'Chez maman', start: at(-122, 19), end: at(-115, 19), rrule: 'RRULE:FREQ=WEEKLY;INTERVAL=2', colorId: '4' }),
      ev({ calendarId: 'garde', title: 'Chez papa', start: at(-115, 19), end: at(-108, 19), rrule: 'RRULE:FREQ=WEEKLY;INTERVAL=2', colorId: '5' }),
      ev({ calendarId: 'perso', title: "Réunion d'équipe", start: at(-55, 10), end: at(-55, 11), rrule: 'RRULE:FREQ=WEEKLY' }),
      ev({ calendarId: 'perso', title: 'Dentiste', start: at(3, 17, 30), end: at(3, 18, 15), location: 'Cabinet du Dr Martin', people: ['Léa'] }),
      ev({ calendarId: 'perso', title: 'Concert', start: at(4, 22), end: at(5, 1), colorId: '3' }),
      ev({ calendarId: 'famille', title: 'Dîner chez Paul', start: at(5, 20), end: at(5, 23, 30), people: ['Tom'] }),
      ev({ calendarId: 'famille', title: 'Week-end à la mer', start: at(12, 9), end: at(13, 18), colorId: '7' }),
      ev({ calendarId: 'famille', title: 'Anniversaire de Léa', allDay: true, start: at(12, 0), end: at(13, 0), people: ['Léa', 'Tom'] }),
      ev({ calendarId: 'famille', title: 'Vacances scolaires', allDay: true, start: at(19, 0), end: at(35, 0), colorId: '2' }),
    ],
  };
}

export class LocalStore {
  constructor() {
    this.kind = 'local';
    this.load();
  }

  load() {
    try {
      this.db = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch {
      this.db = null;
    }
    if (!this.db) {
      this.db = seed();
      this.save();
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.db));
    } catch {
      /* stockage indisponible : on garde en mémoire */
    }
  }

  reset() {
    this.db = seed();
    this.save();
  }

  async listCalendars() {
    return this.db.calendars.map((c) => ({ ...c, editable: true }));
  }

  master(id) {
    return this.db.events.find((e) => e.id === id);
  }

  async listEvents(rangeStart, rangeEnd, calendarIds) {
    const wanted = new Set(calendarIds);
    const out = [];
    for (const m of this.db.events) {
      if (!wanted.has(m.calendarId)) continue;
      const start = revive(m.start, m.allDay);
      const end = revive(m.end, m.allDay);
      const occ = expand({ start, end, rrule: m.rrule, exdates: m.exdates }, rangeStart, rangeEnd);
      for (const o of occ) {
        const id = m.rrule ? `${m.id}@${o.start.getTime()}` : m.id;
        out.push({
          key: `${m.calendarId}|${id}`,
          id,
          calendarId: m.calendarId,
          title: m.title || '(Sans titre)',
          start: o.start,
          end: o.end,
          allDay: m.allDay,
          location: m.location,
          description: m.description,
          colorId: m.colorId,
          people: m.people || [],
          recurringEventId: m.rrule ? m.id : null,
          originalStart: m.rrule ? o.start : null,
          editable: true,
        });
      }
    }
    return out;
  }

  async getSeries(ev) {
    const m = this.master(ev.recurringEventId);
    return m ? { rrule: m.rrule, start: revive(m.start, m.allDay) } : null;
  }

  async createEvent(data) {
    this.db.events.push({
      id: uid(),
      calendarId: data.calendarId,
      title: data.title,
      allDay: data.allDay,
      start: serialize(data.start, data.allDay),
      end: serialize(data.end, data.allDay),
      location: data.location || '',
      description: data.description || '',
      colorId: data.colorId || null,
      people: data.people || [],
      rrule: data.rrule || null,
      exdates: [],
    });
    this.save();
  }

  // `full` = état complet de l'événement après modification, `changes` = ce qui a bougé
  async updateEvent(ev, full, changes, scope) {
    if (ev.recurringEventId && scope === 'instance') {
      // L'occurrence devient un événement indépendant, exclu de la série
      const m = this.master(ev.recurringEventId);
      m.exdates.push(ev.originalStart.getTime());
      await this.createEvent({ ...full, rrule: null });
      return;
    }
    const m = this.master(ev.recurringEventId || ev.id);
    if (!m) throw new Error('Événement introuvable');
    if ('title' in changes) m.title = changes.title;
    if ('location' in changes) m.location = changes.location;
    if ('description' in changes) m.description = changes.description;
    if ('colorId' in changes) m.colorId = changes.colorId;
    if ('people' in changes) m.people = changes.people;
    if ('calendarId' in changes) m.calendarId = changes.calendarId;
    if ('rrule' in changes) {
      m.rrule = changes.rrule;
      m.exdates = [];
    }
    if ('start' in changes) {
      const allDay = full.allDay;
      let start = full.start;
      let end = full.end;
      if (ev.recurringEventId) {
        // On décale le début de la série comme on a décalé cette occurrence
        const mStart = revive(m.start, m.allDay);
        const mEnd = revive(m.end, m.allDay);
        start = shiftLike(mStart, ev.start, full.start);
        end = shiftLike(mEnd, ev.end, full.end);
        if (allDay) {
          start = startOfDay(start);
          end = startOfDay(end);
        }
        m.exdates = [];
      }
      m.allDay = allDay;
      m.start = serialize(start, allDay);
      m.end = serialize(end, allDay);
    }
    this.save();
  }

  async deleteEvent(ev, scope) {
    if (ev.recurringEventId && scope === 'instance') {
      this.master(ev.recurringEventId).exdates.push(ev.originalStart.getTime());
    } else {
      const id = ev.recurringEventId || ev.id;
      this.db.events = this.db.events.filter((e) => e.id !== id);
    }
    this.save();
  }
}
