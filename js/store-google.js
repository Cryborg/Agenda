// Synchronisation avec Google Agenda : connexion OAuth dans le navigateur
// (Google Identity Services, flux "token") et appels REST à l'API Calendar v3.
// Aucun serveur : le jeton d'accès (valable 1 h) reste dans ce navigateur.

import { parseDate, toDateInput, toRFC3339, localTimeZone, shiftLike, startOfDay } from './dates.js';
import { rruleLine } from './recur.js';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];
const TOKEN_KEY = 'agenda.google.token';

export class AuthError extends Error {
  constructor(msg = 'Connexion Google expirée') {
    super(msg);
    this.name = 'AuthError';
  }
}

let gisPromise = null;
export function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisPromise = null;
        reject(new Error('Impossible de charger le service de connexion Google (hors ligne ?)'));
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export class GoogleAuth {
  constructor(clientId) {
    this.clientId = clientId;
    this.client = null;
    this.pending = null;
    try {
      const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (saved && saved.clientId === clientId) Object.assign(this, { token: saved.token, expiresAt: saved.expiresAt });
    } catch {
      /* rien */
    }
  }

  get valid() {
    return !!this.token && Date.now() < this.expiresAt - 60_000;
  }

  async init() {
    await loadGis();
    if (this.client) return;
    this.client = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPES.join(' '),
      callback: (resp) => {
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        if (resp.error) return p.reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, ...SCOPES)) {
          return p.reject(new Error("Il faut cocher l'accès à Google Agenda pour que la synchronisation fonctionne."));
        }
        this.token = resp.access_token;
        this.expiresAt = Date.now() + Number(resp.expires_in || 3600) * 1000;
        try {
          localStorage.setItem(TOKEN_KEY, JSON.stringify({ clientId: this.clientId, token: this.token, expiresAt: this.expiresAt }));
        } catch {
          /* rien */
        }
        p.resolve();
      },
      error_callback: (err) => {
        const p = this.pending;
        this.pending = null;
        if (!p) return;
        const msg =
          err?.type === 'popup_closed' ? 'Connexion annulée.'
          : err?.type === 'popup_failed_to_open' ? 'La fenêtre de connexion Google a été bloquée par le navigateur.'
          : err?.message || 'Échec de la connexion Google.';
        p.reject(new Error(msg));
      },
    });
  }

  // À appeler directement depuis un clic : le navigateur bloque les popups sinon.
  signIn({ consent = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.client) return reject(new Error('Connexion Google pas encore prête, réessaie dans un instant.'));
      this.pending = { resolve, reject };
      this.client.requestAccessToken({ prompt: consent ? 'consent' : '' });
    });
  }

  clear() {
    this.token = null;
    this.expiresAt = 0;
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* rien */
    }
  }

  signOut() {
    if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token, () => {});
    this.clear();
  }
}

// Description Google : souvent du HTML léger. On l'affiche en texte brut.
export function htmlToText(html) {
  if (!html || !/[<&]/.test(html)) return html || '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'), 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function timeBody(allDay, d) {
  return allDay ? { date: toDateInput(d), dateTime: null, timeZone: null } : { date: null, dateTime: toRFC3339(d), timeZone: localTimeZone() };
}

const stripNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

// Personnes assignées : rangées dans extendedProperties.private, un champ
// invisible pour les invités. Ce ne sont PAS des participants Google : personne
// n'est invité ni notifié, c'est une simple étiquette pour filtrer.
const PEOPLE_KEY = 'agendaPeople';

function readPeople(item) {
  try {
    const v = JSON.parse(item.extendedProperties?.private?.[PEOPLE_KEY] || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

const peopleBody = (people) => ({ private: { [PEOPLE_KEY]: people?.length ? JSON.stringify(people) : null } });

export class GoogleStore {
  constructor(auth) {
    this.kind = 'google';
    this.auth = auth;
    this.calendars = new Map();
  }

  async api(path, { method = 'GET', query, body } = {}) {
    if (!this.auth.valid) throw new AuthError();
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.auth.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      this.auth.clear();
      throw new AuthError();
    }
    if (!res.ok) {
      let msg = `Erreur Google (${res.status})`;
      try {
        const j = await res.json();
        if (j.error?.message) msg += ` : ${j.error.message}`;
      } catch {
        /* rien */
      }
      throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  async listCalendars() {
    const items = [];
    let pageToken;
    do {
      const r = await this.api('/users/me/calendarList', { query: { pageToken, maxResults: 250 } });
      items.push(...(r.items || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    const cals = items
      .filter((c) => !c.deleted)
      .map((c) => ({
        id: c.id,
        name: c.summaryOverride || c.summary,
        color: c.backgroundColor || '#039be5',
        primary: !!c.primary,
        editable: c.accessRole === 'owner' || c.accessRole === 'writer',
        selected: c.selected !== false,
      }))
      .sort((a, b) => b.primary - a.primary || b.editable - a.editable || a.name.localeCompare(b.name));
    this.calendars = new Map(cals.map((c) => [c.id, c]));
    return cals;
  }

  fromGoogle(item, cal) {
    const allDay = !!item.start?.date;
    const start = allDay ? parseDate(item.start.date) : new Date(item.start.dateTime);
    const end = allDay ? parseDate(item.end.date) : new Date(item.end?.dateTime || item.start.dateTime);
    const organizerSelf = !item.organizer || item.organizer.self === true || item.organizer.email === cal.id;
    return {
      key: `${cal.id}|${item.id}`,
      id: item.id,
      calendarId: cal.id,
      title: item.summary || (item.visibility === 'private' || !cal.editable ? 'Occupé' : '(Sans titre)'),
      start,
      end,
      allDay,
      location: item.location || '',
      description: htmlToText(item.description),
      rawDescription: item.description || '',
      colorId: item.colorId || null,
      people: readPeople(item),
      recurringEventId: item.recurringEventId || null,
      htmlLink: item.htmlLink,
      editable: cal.editable && !item.locked && (organizerSelf || !!item.guestsCanModify),
    };
  }

  async listEvents(rangeStart, rangeEnd, calendarIds) {
    const results = await Promise.allSettled(
      calendarIds.map(async (calId) => {
        const cal = this.calendars.get(calId);
        if (!cal) return [];
        const out = [];
        let pageToken;
        do {
          const r = await this.api(`/calendars/${encodeURIComponent(calId)}/events`, {
            query: {
              timeMin: rangeStart.toISOString(),
              timeMax: rangeEnd.toISOString(),
              singleEvents: 'true',
              maxResults: 2500,
              pageToken,
            },
          });
          for (const it of r.items || []) if (it.status !== 'cancelled' && it.start) out.push(this.fromGoogle(it, cal));
          pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
      }),
    );
    const auth = results.find((r) => r.status === 'rejected' && r.reason instanceof AuthError);
    if (auth) throw auth.reason;
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length === results.length && failed.length) throw failed[0].reason;
    const events = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    events.partialError = failed.length ? failed[0].reason : null;
    return events;
  }

  eventPath(calId, id) {
    return `/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(id)}`;
  }

  async getSeries(ev) {
    const m = await this.api(this.eventPath(ev.calendarId, ev.recurringEventId));
    return { rrule: rruleLine(m.recurrence), start: m.start?.date ? parseDate(m.start.date) : new Date(m.start.dateTime) };
  }

  async createEvent(data) {
    const body = stripNulls({
      summary: data.title,
      location: data.location || null,
      description: data.description || null,
      colorId: data.colorId || null,
      start: stripNulls(timeBody(data.allDay, data.start)),
      end: stripNulls(timeBody(data.allDay, data.end)),
      recurrence: data.rrule ? [data.rrule] : null,
      extendedProperties: data.people?.length ? peopleBody(data.people) : null,
    });
    await this.api(`/calendars/${encodeURIComponent(data.calendarId)}/events`, { method: 'POST', body });
  }

  async updateEvent(ev, full, changes, scope) {
    const series = ev.recurringEventId && scope === 'series';
    const id = series ? ev.recurringEventId : ev.id;
    const path = this.eventPath(ev.calendarId, id);
    const body = {};
    if ('title' in changes) body.summary = changes.title;
    if ('location' in changes) body.location = changes.location;
    if ('description' in changes) body.description = changes.description;
    if ('colorId' in changes) body.colorId = changes.colorId;
    if ('people' in changes) body.extendedProperties = peopleBody(changes.people);

    let master = null;
    if (series && ('start' in changes || 'rrule' in changes)) master = await this.api(path);

    if ('start' in changes) {
      let start = full.start;
      let end = full.end;
      if (series) {
        // On décale le début de la série comme on a décalé cette occurrence
        const mStart = master.start.date ? parseDate(master.start.date) : new Date(master.start.dateTime);
        const mEnd = master.end.date ? parseDate(master.end.date) : new Date(master.end.dateTime);
        start = shiftLike(mStart, ev.start, full.start);
        end = shiftLike(mEnd, ev.end, full.end);
        if (full.allDay) {
          start = startOfDay(start);
          end = startOfDay(end);
        }
      }
      body.start = timeBody(full.allDay, start);
      body.end = timeBody(full.allDay, end);
    }

    if ('rrule' in changes) {
      const others = (master?.recurrence || []).filter((l) => !/^RRULE:/i.test(l));
      body.recurrence = changes.rrule ? [changes.rrule, ...others] : [];
    }

    if (Object.keys(body).length) await this.api(path, { method: 'PATCH', body });
    if ('calendarId' in changes) {
      await this.api(`${path}/move`, { method: 'POST', query: { destination: changes.calendarId } });
    }
  }

  async deleteEvent(ev, scope) {
    const id = ev.recurringEventId && scope === 'series' ? ev.recurringEventId : ev.id;
    await this.api(this.eventPath(ev.calendarId, id), { method: 'DELETE' });
  }
}
