import {
  addDays, addMonths, startOfDay, startOfWeek, startOfMonth, sameDay, dayRange, dayDiff,
  toDateInput, toTimeInput, parseDate, combine, fmtTime, fmtDow, fmtMonthYear, fmtDayMonth,
  fmtFull, capitalize, tzLabel, HOUR_MS, DAY_MS,
} from './dates.js';
import { isSpanning, bandLayout, splitByDay, packColumns, railLayout } from './layout.js';
import { PRESETS, presetOf, presetToRRule, describe } from './recur.js';
import { EVENT_COLORS, eventColor, textOn } from './colors.js';
import { LocalStore } from './store-local.js';
import { GoogleAuth, GoogleStore, AuthError, loadGis } from './store-google.js';
import { People, initials } from './people.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------------------
// Constantes et état

const HOUR_H = 48; // px par heure dans la grille
const LANE_H = 24; // hauteur d'une ligne du bandeau (vues jour/semaine)
const LANE_M = 22; // hauteur d'une ligne du bandeau (vue mois)
const RAIL_W = 6;
const MIN_EVENT_MIN = 22; // hauteur minimale d'un événement, en minutes
const NONE = '__none__'; // filtre "sans personne"
const SYNC_EVERY_MS = 5 * 60_000;

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* rien */
    }
  },
};

const settings = Object.assign({ clientId: '', mode: 'local', scrollHour: 7, showRails: true, everConnected: false }, LS.get('agenda.settings', {}));
const saveSettings = () => LS.set('agenda.settings', settings);

const isNarrow = () => window.innerWidth < 760;

const state = {
  view: LS.get('agenda.view', isNarrow() ? '3days' : 'week'),
  cursor: startOfDay(new Date()),
  miniCursor: null,
  store: null,
  auth: null,
  authExpired: false,
  calendars: [],
  calById: new Map(),
  hiddenCals: new Set(),
  hiddenPeople: new Set(LS.get('agenda.hiddenPeople', [])),
  events: [],
  byKey: new Map(),
  cache: new Map(),
  seq: 0,
  loading: false,
  lastFetch: 0,
  scrollTop: null,
  renderedView: null,
};

const people = new People();

// ---------------------------------------------------------------------------
// Plages et navigation

function viewDays() {
  const c = state.cursor;
  switch (state.view) {
    case 'day': return dayRange(c, 1);
    case '3days': return dayRange(c, 3);
    case 'month': {
      const s = startOfWeek(startOfMonth(c));
      const last = new Date(c.getFullYear(), c.getMonth() + 1, 0);
      const weeks = dayDiff(s, startOfWeek(last)) / 7 + 1;
      return dayRange(s, weeks * 7);
    }
    default: return dayRange(startOfWeek(c), 7);
  }
}

function move(dir) {
  const c = state.cursor;
  state.cursor =
    state.view === 'day' ? addDays(c, dir)
    : state.view === '3days' ? addDays(c, 3 * dir)
    : state.view === 'month' ? startOfMonth(addMonths(startOfMonth(c), dir))
    : addDays(c, 7 * dir);
  state.miniCursor = null;
  update();
}

function goToday() {
  state.cursor = startOfDay(new Date());
  state.miniCursor = null;
  state.scrollTop = null;
  update();
}

function setView(v) {
  if (v === state.view) return;
  state.view = v;
  LS.set('agenda.view', v);
  update();
}

function goDay(d) {
  state.cursor = startOfDay(d);
  state.view = 'day';
  LS.set('agenda.view', 'day');
  update();
}

function periodTitle(days) {
  const a = days[0];
  const b = days[days.length - 1];
  if (state.view === 'day') return capitalize(fmtFull(a));
  if (state.view === 'month') return capitalize(fmtMonthYear(state.cursor));
  if (a.getMonth() === b.getMonth()) return capitalize(fmtMonthYear(a));
  const m = new Intl.DateTimeFormat('fr-FR', { month: 'short' });
  const sameYear = a.getFullYear() === b.getFullYear();
  return capitalize(`${m.format(a)}${sameYear ? '' : ' ' + a.getFullYear()} à ${m.format(b)} ${b.getFullYear()}`);
}

// ---------------------------------------------------------------------------
// Filtres

function personVisible(ev) {
  if (!state.hiddenPeople.size) return true;
  if (!ev.people?.length) return !state.hiddenPeople.has(NONE);
  return ev.people.some((p) => !state.hiddenPeople.has(p));
}

const visibleEvents = () => state.events.filter((ev) => !state.hiddenCals.has(ev.calendarId) && personVisible(ev));
const colorOf = (ev) => eventColor(ev, state.calById);

function saveHiddenCals() {
  LS.set(`agenda.hidden.${state.store?.kind || 'local'}`, [...state.hiddenCals]);
}

// ---------------------------------------------------------------------------
// Chargement des données

function rangeKey(days) {
  return `${state.store.kind}|${+days[0]}|${+addDays(days[days.length - 1], 1)}`;
}

function persistOffline() {
  if (state.store?.kind !== 'google') return;
  LS.set('agenda.offline', {
    calendars: state.calendars,
    events: state.events.map((e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() })),
  });
}

function loadOffline() {
  const o = LS.get('agenda.offline', null);
  if (!o) return;
  setCalendars(o.calendars || []);
  state.events = (o.events || []).map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) }));
}

function setCalendars(cals) {
  state.calendars = cals;
  state.calById = new Map(cals.map((c) => [c.id, c]));
  const saved = LS.get(`agenda.hidden.${state.store?.kind || 'local'}`, null);
  state.hiddenCals = new Set(saved ?? cals.filter((c) => c.selected === false).map((c) => c.id));
}

async function loadCalendars() {
  setCalendars(await state.store.listCalendars());
}

async function refresh({ force = false } = {}) {
  if (!state.store) return;
  if (state.store.kind === 'google' && !state.auth?.valid) {
    state.authExpired = true;
    render();
    return;
  }
  const days = viewDays();
  const key = rangeKey(days);
  if (!force && state.cache.has(key)) {
    state.events = state.cache.get(key);
    render();
  }
  const seq = ++state.seq;
  setLoading(true);
  try {
    const ids = state.calendars.filter((c) => !state.hiddenCals.has(c.id)).map((c) => c.id);
    const start = days[0];
    const end = addDays(days[days.length - 1], 1);
    const events = await state.store.listEvents(start, end, ids);
    if (seq !== state.seq) return;
    state.events = events;
    state.cache.set(key, events);
    state.lastFetch = Date.now();
    persistOffline();
    if (events.partialError) toast(`Un agenda n'a pas pu être chargé : ${events.partialError.message}`, 'error');
    render();
  } catch (e) {
    if (seq === state.seq) handleError(e);
  } finally {
    if (seq === state.seq) setLoading(false);
  }
}

function update() {
  render();
  refresh();
}

function handleError(e) {
  if (e instanceof AuthError) {
    state.authExpired = true;
    render();
    return;
  }
  console.error(e);
  toast(e.message || String(e), 'error');
}

function setLoading(on) {
  state.loading = on;
  $('#btn-sync').classList.toggle('spinning', on);
}

// ---------------------------------------------------------------------------
// Sources : local ou Google

async function setupStore() {
  state.cache.clear();
  state.authExpired = false;
  if (settings.clientId && (!state.auth || state.auth.clientId !== settings.clientId)) {
    state.auth = new GoogleAuth(settings.clientId);
    state.auth.init().catch((e) => console.warn(e));
  }
  if (settings.mode === 'google' && state.auth) {
    state.store = new GoogleStore(state.auth);
    loadOffline();
    render();
    if (!state.auth.valid) {
      state.authExpired = true;
      render();
      return;
    }
    try {
      await loadCalendars();
    } catch (e) {
      return handleError(e);
    }
  } else {
    state.store = new LocalStore();
    await loadCalendars();
  }
  update();
}

async function connectGoogle({ reconnect = false } = {}) {
  if (!settings.clientId) {
    openSettings();
    toast("Renseigne d'abord l'ID client Google (voir le README).");
    return;
  }
  if (!state.auth || state.auth.clientId !== settings.clientId) state.auth = new GoogleAuth(settings.clientId);
  const auth = state.auth;
  try {
    if (!auth.client) await auth.init();
    await auth.signIn({ consent: !settings.everConnected });
    settings.everConnected = true;
    const wasGoogle = settings.mode === 'google';
    settings.mode = 'google';
    saveSettings();
    state.authExpired = false;
    if (!wasGoogle || !reconnect || !(state.store instanceof GoogleStore)) {
      state.store = new GoogleStore(auth);
      state.cache.clear();
    }
    await loadCalendars();
    render();
    await refresh({ force: true });
    toast(reconnect ? 'Reconnecté à Google Agenda' : 'Connecté à Google Agenda');
  } catch (e) {
    handleError(e);
  }
}

function disconnectGoogle() {
  state.auth?.signOut();
  settings.mode = 'local';
  saveSettings();
  LS.set('agenda.offline', null);
  setupStore();
}

// ---------------------------------------------------------------------------
// Rendu général

function render() {
  const days = viewDays();
  state.byKey = new Map(state.events.map((e) => [e.key, e]));
  $('#period').textContent = periodTitle(days);
  document.title = `${periodTitle(days)} · Agenda`;
  for (const b of document.querySelectorAll('#views [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === state.view));
  $('#views-select').value = state.view;
  renderBanner();
  renderSidebar(days);
  renderMain(days);
}

function renderBanner() {
  const el = $('#banner');
  if (state.store?.kind === 'google' && state.authExpired) {
    el.hidden = false;
    el.innerHTML = `<span>La connexion à Google a expiré (elle dure une heure). Les événements affichés peuvent ne pas être à jour.</span>
      <button class="btn btn-primary" data-action="reconnect">Se reconnecter</button>`;
  } else {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function renderSidebar(days) {
  renderMini(days);

  $('#cal-list').innerHTML =
    state.calendars
      .map(
        (c) => `<li><label class="check" style="--c:${esc(c.color)}">
          <input type="checkbox" data-cal="${esc(c.id)}" ${state.hiddenCals.has(c.id) ? '' : 'checked'}>
          <span class="box"></span><span class="name">${esc(c.name)}</span></label></li>`,
      )
      .join('') || '<li class="muted small">Aucun agenda</li>';

  const names = people.all(state.events);
  const rows = names.map(
    (n) => `<li class="person-row"><label class="check" style="--c:${people.color(n)}">
        <input type="checkbox" data-person="${esc(n)}" ${state.hiddenPeople.has(n) ? '' : 'checked'}>
        <span class="box"></span><span class="avatar" style="--c:${people.color(n)}">${esc(initials(n))}</span><span class="name">${esc(n)}</span></label>
        <button class="mini-btn" data-only="${esc(n)}" title="N'afficher que ${esc(n)}">${icon('eye', 16)}</button></li>`,
  );
  rows.push(`<li class="person-row"><label class="check" style="--c:#8e918f">
      <input type="checkbox" data-person="${NONE}" ${state.hiddenPeople.has(NONE) ? '' : 'checked'}>
      <span class="box"></span><span class="name muted">Sans personne</span></label></li>`);
  rows.push(`<li><form class="add-person" id="add-person"><input name="name" placeholder="Ajouter une personne" autocomplete="off" maxlength="40"><button class="mini-btn" aria-label="Ajouter">${icon('plus', 16)}</button></form></li>`);
  $('#people-list').innerHTML = rows.join('');
  $('#btn-people-all').hidden = !state.hiddenPeople.size;

  const src = $('#source');
  if (state.store?.kind === 'google') {
    const last = state.lastFetch ? `Dernière synchro à ${fmtTime(new Date(state.lastFetch))}` : '';
    src.innerHTML = state.authExpired
      ? `<div class="source-line warn">${icon('cloud', 16)} Connexion Google expirée</div>
         <div class="source-actions"><button class="btn btn-primary btn-sm" data-action="reconnect">Se reconnecter</button>
         <button class="btn btn-ghost btn-sm" data-action="disconnect">Déconnecter</button></div>`
      : `<div class="source-line ok">${icon('cloud', 16)} Synchronisé avec Google</div>
         <div class="muted small">${last}</div>
         <div class="source-actions"><button class="btn btn-ghost btn-sm" data-action="disconnect">${icon('logout', 16)} Déconnecter</button></div>`;
  } else {
    src.innerHTML = `<div class="source-line">${icon('calendar', 16)} Agenda local</div>
      <div class="muted small">Les événements sont enregistrés sur cet appareil uniquement.</div>
      <div class="source-actions"><button class="btn btn-primary btn-sm" data-action="connect">${icon('cloud', 16)} Connecter Google Agenda</button></div>`;
  }
}

function renderMini(days) {
  const mc = state.miniCursor || startOfMonth(state.cursor);
  const s = startOfWeek(mc);
  const today = new Date();
  const first = days[0];
  const last = days[days.length - 1];
  const cells = dayRange(s, 42)
    .map((d) => {
      const cls = [
        d.getMonth() !== mc.getMonth() && 'other',
        sameDay(d, today) && 'today',
        state.view !== 'month' && d >= first && d <= last && 'in-range',
      ].filter(Boolean).join(' ');
      return `<button class="${cls}" data-mini-day="${toDateInput(d)}">${d.getDate()}</button>`;
    })
    .join('');
  const dows = dayRange(s, 7).map((d) => `<span>${fmtDow(d).charAt(0).toUpperCase()}</span>`).join('');
  $('#mini').innerHTML = `<div class="mini-head"><span>${capitalize(fmtMonthYear(mc))}</span>
    <button class="icon-btn sm" data-mini-move="-1" aria-label="Mois précédent">${icon('left', 18)}</button>
    <button class="icon-btn sm" data-mini-move="1" aria-label="Mois suivant">${icon('right', 18)}</button></div>
    <div class="mini-grid">${dows}${cells}</div>`;
}

function renderMain(days) {
  const main = $('#main');
  const scroller = $('.tg-scroll', main);
  if (scroller && state.renderedView === state.view) state.scrollTop = scroller.scrollTop;
  else if (state.renderedView !== state.view) state.scrollTop = null;
  state.renderedView = state.view;

  if (state.view === 'month') {
    main.innerHTML = renderMonth(days);
    fitMonthCells();
  } else {
    main.innerHTML = renderTimeGrid(days);
    const sc = $('.tg-scroll', main);
    sc.scrollTop = state.scrollTop ?? settings.scrollHour * HOUR_H;
  }
}

// ---------------------------------------------------------------------------
// Fragments communs

function peopleChips(ev, size = '') {
  if (!ev.people?.length) return '';
  return `<span class="chips ${size}">${ev.people
    .map((n) => `<span class="avatar" style="--c:${people.color(n)}" title="${esc(n)}">${esc(initials(n))}</span>`)
    .join('')}</span>`;
}

function durationText(ms) {
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = [];
  if (d) parts.push(`${d} j`);
  if (h) parts.push(`${h} h`);
  if (m && !d) parts.push(`${m} min`);
  return parts.join(' ') || '0 min';
}

function whenText(ev) {
  if (ev.allDay) {
    const last = addDays(ev.end, -1);
    return sameDay(ev.start, last) ? capitalize(fmtFull(ev.start)) : `${capitalize(fmtFull(ev.start))} → ${fmtFull(last)}`;
  }
  if (sameDay(ev.start, ev.end)) return `${capitalize(fmtFull(ev.start))}, ${fmtTime(ev.start)} → ${fmtTime(ev.end)}`;
  return `${capitalize(fmtFull(ev.start))}, ${fmtTime(ev.start)} → ${fmtFull(ev.end)}, ${fmtTime(ev.end)}`;
}

function tooltip(ev) {
  const who = ev.people?.length ? `\n${ev.people.join(', ')}` : '';
  return esc(`${ev.title}\n${whenText(ev)}${who}`);
}

// Barre d'un événement long, positionnée à son heure réelle
function bandBar(it, n, laneH) {
  const ev = it.ev;
  const color = colorOf(ev);
  const left = (it.x0 / n) * 100;
  const width = ((it.x1 - it.x0) / n) * 100;
  const startLbl = !ev.allDay && !it.startsBefore ? `<b>${fmtTime(ev.start)}</b> ` : '';
  const endLbl = !ev.allDay && !it.endsAfter ? `<span class="bar-end">${fmtTime(ev.end)}</span>` : '';
  const cls = ['bar', it.startsBefore && 'cont-l', it.endsAfter && 'cont-r', !ev.allDay && 'timed'].filter(Boolean).join(' ');
  return `<div role="button" tabindex="0" class="${cls}" data-key="${esc(ev.key)}" title="${tooltip(ev)}"
    style="left:calc(${left}% + 1px);width:calc(${width}% - 2px);top:${it.lane * laneH}px;height:${laneH - 2}px;--c:${color};--fg:${textOn(color)}">
    <span class="bar-label">${it.startsBefore ? '‹ ' : ''}${startLbl}${esc(ev.title)}</span>${peopleChips(ev, 'sm')}${endLbl}</div>`;
}

// ---------------------------------------------------------------------------
// Vue jour / 3 jours / semaine

function renderTimeGrid(days) {
  const n = days.length;
  const evs = visibleEvents();
  const spanning = evs.filter(isSpanning);
  const timed = evs.filter((e) => !isSpanning(e));
  const band = bandLayout(spanning, days);
  const rails = settings.showRails ? railLayout(spanning, days) : { cols: days.map(() => []), lanes: 0 };
  const cols = splitByDay(timed, days).map((segs) => packColumns(segs, MIN_EVENT_MIN / 1440));
  const railPad = rails.lanes ? rails.lanes * RAIL_W + 3 : 0;
  const now = new Date();

  const heads = days
    .map(
      (d) => `<button class="tg-dayhead ${sameDay(d, now) ? 'today' : ''}" data-goto="${toDateInput(d)}">
        <span class="dow">${fmtDow(d)}</span><span class="num">${d.getDate()}</span></button>`,
    )
    .join('');

  const bandCells = days.map((d) => `<div class="band-cell" data-band-day="${toDateInput(d)}"></div>`).join('');
  const bandH = Math.max(band.lanes * LANE_H + 4, 26);
  const bars = band.items.map((it) => bandBar(it, n, LANE_H)).join('');

  const hours = Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * HOUR_H}px">${String(i + 1).padStart(2, '0')}:00</span>`).join('');

  const colsHtml = days
    .map((d, i) => {
      const today = sameDay(d, now);
      const railHtml = rails.cols[i]
        .map((s) => {
          const color = colorOf(s.ev);
          return `<div role="button" tabindex="-1" class="rail" data-key="${esc(s.ev.key)}" title="${tooltip(s.ev)}"
            style="left:${2 + s.lane * RAIL_W}px;top:${s.top * 100}%;height:${(s.bottom - s.top) * 100}%;--c:${color}"></div>`;
        })
        .join('');
      const evHtml = cols[i].map((s) => gridEvent(s, railPad, now)).join('');
      const nowLine = today ? `<div class="now" style="top:${((now - d) / DAY_MS) * 100}%"></div>` : '';
      const wk = d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : '';
      return `<div class="col ${today ? 'is-today' : ''} ${wk}" data-day="${toDateInput(d)}">${railHtml}${evHtml}${nowLine}</div>`;
    })
    .join('');

  return `<div class="tg" style="--n:${n};--hour:${HOUR_H}px">
    <div class="tg-head"><div class="tg-gutter tz">${tzLabel()}</div><div class="tg-days">${heads}</div></div>
    <div class="tg-band"><div class="tg-gutter"></div>
      <div class="band-area" style="height:${bandH}px"><div class="band-cells">${bandCells}</div>${bars}</div></div>
    <div class="tg-scroll"><div class="tg-body">
      <div class="tg-hours">${hours}</div>
      <div class="tg-cols">${colsHtml}</div>
    </div></div></div>`;
}

function gridEvent(s, railPad, now) {
  const ev = s.ev;
  const color = colorOf(ev);
  const durMin = (s.bottom - s.top) * 1440;
  const h = Math.max(s.bottom - s.top, MIN_EVENT_MIN / 1440);
  const avail = `(100% - ${railPad + 6}px)`;
  const left = `calc(${railPad}px + ${avail} * ${s.col / s.cols})`;
  const width = `calc(${avail} / ${s.cols} - 1px)`;
  const compact = durMin <= 45;
  const past = ev.end < now ? 'past' : '';
  const time = `${fmtTime(ev.start)} → ${fmtTime(ev.end)}`;
  return `<div role="button" tabindex="0" class="ev ${compact ? 'compact' : ''} ${past}" data-key="${esc(ev.key)}" title="${tooltip(ev)}"
    style="top:${s.top * 100}%;height:calc(${h * 100}% - 1px);left:${left};width:${width};--c:${color};--fg:${textOn(color)}">
    <span class="ev-title">${esc(ev.title)}${compact ? `<span class="ev-time">, ${fmtTime(ev.start)}</span>` : ''}</span>
    ${compact ? '' : `<span class="ev-time">${time}</span>`}${peopleChips(ev, compact ? 'sm' : '')}</div>`;
}

// ---------------------------------------------------------------------------
// Vue mois

function renderMonth(days) {
  const evs = visibleEvents();
  const spanning = evs.filter(isSpanning);
  const timed = evs.filter((e) => !isSpanning(e));
  const now = new Date();
  const month = state.cursor.getMonth();
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const head = weeks[0].map((d) => `<div>${fmtDow(d)}</div>`).join('');
  const rows = weeks
    .map((week) => {
      const band = bandLayout(spanning, week);
      const segs = splitByDay(timed, week);
      const cells = week
        .map((d, i) => {
          const items = segs[i]
            .sort((a, b) => a.ev.start - b.ev.start)
            .map((s) => {
              const ev = s.ev;
              const t = s.startsBefore ? `→ ${fmtTime(ev.end)}` : fmtTime(ev.start);
              return `<div role="button" tabindex="0" class="mv-item" data-key="${esc(ev.key)}" title="${tooltip(ev)}">
                <span class="dot" style="--c:${colorOf(ev)}"></span><span class="mv-t">${t}</span>
                <span class="mv-ttl">${esc(ev.title)}</span>${peopleChips(ev, 'sm')}</div>`;
            })
            .join('');
          const cls = [
            'mv-cell',
            d.getMonth() !== month && 'other',
            sameDay(d, now) && 'today',
            (d.getDay() === 0 || d.getDay() === 6) && 'weekend',
          ].filter(Boolean).join(' ');
          const label = d.getDate() === 1 ? fmtDayMonth(d) : d.getDate();
          return `<div class="${cls}" data-cell-day="${toDateInput(d)}">
            <button class="mv-num" data-goto="${toDateInput(d)}">${label}</button>
            <div class="mv-items" style="margin-top:${band.lanes * LANE_M}px">${items}</div></div>`;
        })
        .join('');
      const bars = band.items.map((it) => bandBar(it, 7, LANE_M)).join('');
      return `<div class="mv-week"><div class="mv-cells">${cells}</div><div class="mv-band" style="height:${band.lanes * LANE_M}px">${bars}</div></div>`;
    })
    .join('');

  return `<div class="mv"><div class="mv-head">${head}</div><div class="mv-rows" style="--rows:${weeks.length}">${rows}</div></div>`;
}

// Masque ce qui dépasse d'une case et affiche "+N autres"
function fitMonthCells() {
  for (const box of document.querySelectorAll('.mv-items')) {
    if (box.scrollHeight <= box.clientHeight + 1) continue;
    const items = [...box.querySelectorAll('.mv-item')];
    const more = document.createElement('button');
    more.className = 'mv-more';
    more.dataset.goto = box.closest('.mv-cell').dataset.cellDay;
    box.append(more);
    let hidden = 0;
    for (let i = items.length - 1; i >= 0 && box.scrollHeight > box.clientHeight + 1; i--) {
      items[i].hidden = true;
      hidden++;
      more.textContent = `+${hidden} autre${hidden > 1 ? 's' : ''}`;
    }
    if (!hidden) more.remove();
  }
}

// ---------------------------------------------------------------------------
// Popover de détail

let popEv = null;

function openPopover(ev, anchor) {
  popEv = ev;
  const pop = $('#popover');
  const cal = state.calById.get(ev.calendarId);
  const color = colorOf(ev);
  const dur = ev.allDay ? '' : ` <span class="muted">(${durationText(ev.end - ev.start)})</span>`;
  const whoList = ev.people?.length
    ? `<div class="pop-row">${icon('users', 18)}<div class="pop-people">${ev.people
        .map((n) => `<span class="person-pill"><span class="avatar" style="--c:${people.color(n)}">${esc(initials(n))}</span>${esc(n)}</span>`)
        .join('')}</div></div>`
    : '';
  pop.innerHTML = `<div class="pop-actions">
      ${ev.editable ? `<button class="icon-btn" data-pop="edit" title="Modifier">${icon('pencil', 18)}</button>
      <button class="icon-btn" data-pop="delete" title="Supprimer">${icon('trash', 18)}</button>` : ''}
      ${ev.htmlLink ? `<a class="icon-btn" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener" title="Ouvrir dans Google Agenda">${icon('external', 18)}</a>` : ''}
      <button class="icon-btn" data-pop="close" title="Fermer">${icon('x', 18)}</button></div>
    <div class="pop-title"><span class="sq" style="--c:${color}"></span><h3>${esc(ev.title)}</h3></div>
    <div class="pop-row">${icon('clock', 18)}<div>${esc(whenText(ev))}${dur}</div></div>
    ${ev.recurringEventId ? `<div class="pop-row" id="pop-recur">${icon('repeat', 18)}<div>Événement récurrent</div></div>` : ''}
    ${whoList}
    ${ev.location ? `<div class="pop-row">${icon('pin', 18)}<div>${esc(ev.location)}</div></div>` : ''}
    ${ev.description ? `<div class="pop-row">${icon('text', 18)}<div class="pop-desc">${esc(ev.description)}</div></div>` : ''}
    <div class="pop-row">${icon('calendar', 18)}<div>${esc(cal?.name || '')}</div></div>`;
  pop.hidden = false;
  placePopover(pop, anchor);

  if (ev.recurringEventId) {
    state.store
      .getSeries(ev)
      .then((s) => {
        const row = $('#pop-recur div');
        if (s && row && popEv === ev) row.textContent = describe(s.rrule, s.start) || 'Événement récurrent';
      })
      .catch(() => {});
  }
}

function placePopover(pop, anchor) {
  if (isNarrow()) {
    pop.style.left = pop.style.top = '';
    return;
  }
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = r.right + 8;
  if (left + pw > vw - 8) left = r.left - pw - 8;
  if (left < 8) left = Math.min(Math.max(8, r.left), vw - pw - 8);
  let top = r.top;
  if (left === r.right + 8 || left === r.left - pw - 8) top = Math.min(Math.max(8, r.top), vh - ph - 8);
  else top = r.bottom + 8 + ph > vh ? Math.max(8, r.top - ph - 8) : r.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function closePopover() {
  popEv = null;
  $('#popover').hidden = true;
}

// ---------------------------------------------------------------------------
// Éditeur

let ghostEl = null;
const clearGhost = () => {
  ghostEl?.remove();
  ghostEl = null;
};

function defaultCalendarId() {
  const editable = state.calendars.filter((c) => c.editable && !state.hiddenCals.has(c.id));
  const last = LS.get(`agenda.lastCal.${state.store.kind}`, null);
  return (editable.find((c) => c.id === last) || editable.find((c) => c.primary) || editable[0] || state.calendars.find((c) => c.editable))?.id;
}

function roundedNow() {
  const d = new Date();
  d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30, 0, 0);
  return d;
}

function openEditor(opts = {}) {
  closePopover();
  const ev = opts.ev || null;
  const editable = state.calendars.filter((c) => c.editable);
  if (!editable.length) return toast('Aucun agenda modifiable.', 'error');

  let start = opts.start;
  let end = opts.end;
  if (!ev && !start) {
    const base = state.view === 'month' || sameDay(state.cursor, new Date()) ? new Date() : state.cursor;
    start = sameDay(base, new Date()) ? roundedNow() : combine(toDateInput(base), '09:00');
    end = new Date(+start + HOUR_MS);
  }
  const init = ev
    ? { title: ev.title === '(Sans titre)' ? '' : ev.title, calendarId: ev.calendarId, allDay: ev.allDay, start: ev.start, end: ev.end,
        location: ev.location || '', description: ev.description || '', colorId: ev.colorId || '', people: [...(ev.people || [])], preset: '' }
    : { title: '', calendarId: opts.calendarId || defaultCalendarId(), allDay: !!opts.allDay, start, end,
        location: '', description: '', colorId: '', people: opts.people || [], preset: '' };
  // Pour une journée entière, la fin affichée est le dernier jour (inclus)
  const endShown = init.allDay ? addDays(init.end, -1) : init.end;
  const selected = new Set(init.people);
  const isRecurringInstance = !!ev?.recurringEventId;
  let seriesPreset = null;

  const dlg = $('#editor');
  const calOptions = editable
    .map((c) => `<option value="${esc(c.id)}" ${c.id === init.calendarId ? 'selected' : ''}>${esc(c.name)}</option>`)
    .join('');
  const colorRadios = [['', 'Couleur de l\'agenda', null], ...Object.entries(EVENT_COLORS).map(([k, v]) => [k, v.name, v.hex])]
    .map(
      ([k, name, hex]) => `<label class="swatch ${k ? '' : 'default'}" title="${esc(name)}" style="--c:${hex || state.calById.get(init.calendarId)?.color || '#8ab4f8'}">
        <input type="radio" name="colorId" value="${k}" ${String(init.colorId || '') === k ? 'checked' : ''}><span></span></label>`,
    )
    .join('');
  const presetOptions = PRESETS.map((p) => `<option value="${p.key}">${p.label}</option>`).join('');

  dlg.innerHTML = `<form method="dialog" class="editor" id="editor-form" novalidate>
    <div class="dlg-head"><h2>${ev ? "Modifier l'événement" : 'Nouvel événement'}</h2>
      <button type="button" class="icon-btn" data-ed="cancel" aria-label="Fermer">${icon('x', 20)}</button></div>
    <input class="title-input" name="title" placeholder="Ajouter un titre" value="${esc(init.title)}" autocomplete="off">
    ${isRecurringInstance ? `<div class="scope" role="radiogroup">
        <label><input type="radio" name="scope" value="instance" checked> Cette occurrence</label>
        <label><input type="radio" name="scope" value="series"> Toute la série</label></div>` : ''}
    <div class="field-row">${icon('clock', 18)}<div class="when">
      <label class="toggle"><input type="checkbox" name="allDay" ${init.allDay ? 'checked' : ''}><span></span>Toute la journée</label>
      <div class="when-grid">
        <span class="lbl">Début</span><input type="date" name="startDate" value="${toDateInput(init.start)}" required>
        <input type="time" name="startTime" value="${toTimeInput(init.start)}" step="300" class="time">
        <span class="lbl">Fin</span><input type="date" name="endDate" value="${toDateInput(endShown)}" required>
        <input type="time" name="endTime" value="${toTimeInput(init.end)}" step="300" class="time">
      </div>
      <div class="muted small" id="ed-duration"></div>
      <select name="preset" class="recur">${presetOptions}<option value="custom" hidden>Récurrence personnalisée (inchangée)</option></select>
    </div></div>
    <div class="field-row">${icon('users', 18)}<div class="people-picker">
      <div class="chip-list" id="ed-people"></div>
      <div class="add-inline"><input id="ed-person-new" placeholder="Nouvelle personne" maxlength="40" autocomplete="off">
      <button type="button" class="btn btn-ghost btn-sm" data-ed="add-person">${icon('plus', 16)} Ajouter</button></div>
      <div class="muted small">Pour tes filtres uniquement : personne n'est invité ni prévenu.</div>
    </div></div>
    <div class="field-row">${icon('calendar', 18)}<select name="calendarId" ${isRecurringInstance ? 'data-series-only' : ''}>${calOptions}</select></div>
    <div class="field-row">${icon('palette', 18)}<div class="swatches">${colorRadios}</div></div>
    <div class="field-row">${icon('pin', 18)}<input name="location" placeholder="Lieu" value="${esc(init.location)}" autocomplete="off"></div>
    <div class="field-row">${icon('text', 18)}<textarea name="description" rows="3" placeholder="Description">${esc(init.description)}</textarea></div>
    <div class="form-error" id="ed-error" hidden></div>
    <div class="dlg-foot">
      ${ev ? `<button type="button" class="btn btn-danger-ghost" data-ed="delete">${icon('trash', 16)} Supprimer</button>` : ''}
      <span class="spacer"></span>
      <button type="button" class="btn btn-ghost" data-ed="cancel">Annuler</button>
      <button type="submit" class="btn btn-primary" id="ed-save">Enregistrer</button>
    </div></form>`;

  const f = $('#editor-form');
  const el = (n) => f.elements[n];

  const renderPeople = () => {
    const all = people.all(state.events);
    for (const n of selected) if (!all.includes(n)) all.push(n);
    $('#ed-people').innerHTML =
      all
        .map(
          (n) => `<button type="button" class="chip ${selected.has(n) ? 'on' : ''}" data-person-toggle="${esc(n)}" style="--c:${people.color(n)}" aria-pressed="${selected.has(n)}">
            <span class="avatar" style="--c:${people.color(n)}">${esc(initials(n))}</span>${esc(n)}</button>`,
        )
        .join('') || '<span class="muted small">Aucune personne pour l\'instant.</span>';
  };
  renderPeople();

  const readTimes = () => {
    const allDay = el('allDay').checked;
    const s = allDay ? parseDate(el('startDate').value) : combine(el('startDate').value, el('startTime').value);
    const e = allDay ? addDays(parseDate(el('endDate').value), 1) : combine(el('endDate').value, el('endTime').value);
    return { allDay, start: s, end: e };
  };

  const syncUi = () => {
    const allDay = el('allDay').checked;
    f.classList.toggle('all-day', allDay);
    const scope = f.elements.scope?.value || 'series';
    const seriesMode = !isRecurringInstance || scope === 'series';
    el('preset').disabled = !seriesMode || (isRecurringInstance && seriesPreset === null);
    el('calendarId').disabled = !seriesMode;
    let txt = '';
    try {
      const t = readTimes();
      if (t.end > t.start) txt = t.allDay ? `${Math.round((t.end - t.start) / DAY_MS)} jour(s)` : `Durée : ${durationText(t.end - t.start)}`;
    } catch {
      /* champ incomplet */
    }
    $('#ed-duration').textContent = txt;
  };

  // Garde la durée quand on change le début (comme Google)
  let prev = readTimes();
  const onStartChange = () => {
    const t = readTimes();
    if (isNaN(t.start)) return;
    const dur = prev.end - prev.start;
    const newEnd = t.allDay ? addDays(t.start, Math.max(1, Math.round(dur / DAY_MS)) - 1) : new Date(+t.start + dur);
    el('endDate').value = toDateInput(newEnd);
    if (!t.allDay) el('endTime').value = toTimeInput(newEnd);
    prev = readTimes();
    syncUi();
  };
  el('startDate').addEventListener('change', onStartChange);
  el('startTime').addEventListener('change', onStartChange);
  for (const n of ['endDate', 'endTime']) el(n).addEventListener('change', () => { prev = readTimes(); syncUi(); });
  el('allDay').addEventListener('change', () => {
    if (!el('allDay').checked && el('startTime').value === '00:00' && el('endTime').value === '00:00') {
      el('startTime').value = '09:00';
      el('endTime').value = '10:00';
    }
    prev = readTimes();
    syncUi();
  });
  f.addEventListener('change', (e) => {
    if (e.target.name === 'scope') syncUi();
    if (e.target.name === 'calendarId') {
      const c = state.calById.get(e.target.value);
      $('.swatch.default', f)?.style.setProperty('--c', c?.color || '#8ab4f8');
    }
  });

  const addPerson = () => {
    const input = $('#ed-person-new');
    const name = people.add(input.value);
    if (!name) return;
    selected.add(name);
    input.value = '';
    renderPeople();
    renderSidebar(viewDays());
  };
  $('#ed-person-new').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addPerson();
    }
  });

  f.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ed],[data-person-toggle]');
    if (!t) return;
    if (t.dataset.personToggle) {
      const n = t.dataset.personToggle;
      selected.has(n) ? selected.delete(n) : selected.add(n);
      renderPeople();
    } else if (t.dataset.ed === 'cancel') dlg.close();
    else if (t.dataset.ed === 'add-person') addPerson();
    else if (t.dataset.ed === 'delete') {
      dlg.close();
      deleteFlow(ev);
    }
  });

  // Récurrence actuelle de la série
  if (ev && isRecurringInstance) {
    el('preset').value = '';
    el('preset').disabled = true;
    state.store
      .getSeries(ev)
      .then((s) => {
        seriesPreset = s ? presetOf(s.rrule, s.start) : '';
        el('preset').value = seriesPreset;
        init.preset = seriesPreset;
        syncUi();
      })
      .catch(() => {
        seriesPreset = null;
      });
  }

  const showError = (html) => {
    const box = $('#ed-error');
    box.innerHTML = html;
    box.hidden = !html;
  };

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    const t = readTimes();
    if (isNaN(t.start) || isNaN(t.end)) return showError('Date ou heure invalide.');
    if (t.allDay ? t.end <= t.start : t.end < t.start) return showError('La fin doit être après le début.');
    const full = {
      title: el('title').value.trim(),
      calendarId: el('calendarId').value,
      allDay: t.allDay,
      start: t.start,
      end: t.end,
      location: el('location').value.trim(),
      description: el('description').value,
      colorId: f.elements.colorId.value || null,
      people: [...selected],
    };
    const scope = f.elements.scope?.value || 'series';
    const btn = $('#ed-save');
    btn.disabled = true;
    btn.textContent = 'Enregistrement…';
    try {
      if (!ev) {
        await state.store.createEvent({ ...full, rrule: presetToRRule(el('preset').value) });
      } else {
        const changes = {};
        if (full.title !== init.title) changes.title = full.title;
        if (full.location !== init.location) changes.location = full.location;
        if (full.description !== init.description) changes.description = full.description;
        if ((full.colorId || '') !== (init.colorId || '')) changes.colorId = full.colorId;
        if (full.calendarId !== init.calendarId && !el('calendarId').disabled) changes.calendarId = full.calendarId;
        if ([...selected].sort().join('\n') !== [...init.people].sort().join('\n')) changes.people = full.people;
        if (full.allDay !== init.allDay || +full.start !== +init.start || +full.end !== +init.end) changes.start = full.start;
        const preset = el('preset').value;
        if (!el('preset').disabled && preset !== 'custom' && preset !== init.preset) changes.rrule = presetToRRule(preset);
        if (Object.keys(changes).length) await state.store.updateEvent(ev, full, changes, scope);
      }
      LS.set(`agenda.lastCal.${state.store.kind}`, full.calendarId);
      dlg.close();
      toast(ev ? 'Événement modifié' : 'Événement créé');
      state.cache.clear();
      refresh({ force: true });
    } catch (err) {
      console.error(err);
      if (err instanceof AuthError) {
        state.authExpired = true;
        renderBanner();
        showError(`La connexion Google a expiré. <button type="button" class="btn btn-primary btn-sm" data-action="reconnect">Se reconnecter</button> puis enregistre à nouveau.`);
      } else showError(esc(err.message || String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enregistrer';
    }
  });

  if (ev && !isRecurringInstance) el('preset').value = '';
  syncUi();
  dlg.addEventListener('close', clearGhost, { once: true });
  dlg.showModal();
  if (!ev) el('title').focus();
}

async function deleteFlow(ev) {
  closePopover();
  let scope = 'instance';
  if (ev.recurringEventId) {
    scope = await ask({
      title: 'Supprimer un événement récurrent',
      message: `« ${ev.title} »`,
      buttons: [
        { label: 'Annuler', value: null },
        { label: 'Cette occurrence', value: 'instance' },
        { label: 'Toute la série', value: 'series', danger: true },
      ],
    });
    if (!scope) return;
  } else {
    const ok = await ask({
      title: 'Supprimer cet événement ?',
      message: `« ${ev.title} »`,
      buttons: [
        { label: 'Annuler', value: null },
        { label: 'Supprimer', value: true, danger: true },
      ],
    });
    if (!ok) return;
  }
  try {
    await state.store.deleteEvent(ev, scope);
    toast('Événement supprimé');
    state.cache.clear();
    refresh({ force: true });
  } catch (e) {
    handleError(e);
  }
}

// ---------------------------------------------------------------------------
// Petites boîtes de dialogue

function ask({ title, message, buttons }) {
  const dlg = $('#confirm');
  dlg.innerHTML = `<div class="confirm"><h2>${esc(title)}</h2><p>${esc(message)}</p>
    <div class="dlg-foot"><span class="spacer"></span>${buttons
      .map((b, i) => `<button type="button" class="btn ${b.danger ? 'btn-danger' : i === 0 ? 'btn-ghost' : 'btn-outline'}" data-i="${i}">${esc(b.label)}</button>`)
      .join('')}</div></div>`;
  return new Promise((resolve) => {
    let value = null;
    dlg.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      value = buttons[+b.dataset.i].value;
      dlg.close();
    };
    dlg.addEventListener('close', () => resolve(value), { once: true });
    dlg.showModal();
  });
}

function openSettings() {
  const dlg = $('#settings');
  const origin = location.origin;
  const hourOpts = Array.from({ length: 13 }, (_, h) => `<option value="${h}" ${h === settings.scrollHour ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('');
  dlg.innerHTML = `<form method="dialog" class="settings" id="settings-form">
    <div class="dlg-head"><h2>Paramètres</h2><button type="button" class="icon-btn" data-set="close" aria-label="Fermer">${icon('x', 20)}</button></div>
    <h3>Synchronisation Google</h3>
    <label class="field"><span>ID client OAuth</span>
      <input name="clientId" value="${esc(settings.clientId)}" placeholder="123456789-xxxx.apps.googleusercontent.com" autocomplete="off" spellcheck="false"></label>
    <p class="muted small">À créer une seule fois dans la console Google Cloud (étapes dans le README). Origine à autoriser pour cette page :
      <code class="copy" data-copy="${esc(origin)}" title="Copier">${esc(origin)}</code></p>
    <h3>Affichage</h3>
    <label class="field inline"><span>Heure visible à l'ouverture</span><select name="scrollHour">${hourOpts}</select></label>
    <label class="toggle"><input type="checkbox" name="showRails" ${settings.showRails ? 'checked' : ''}><span></span>Rappeler les événements longs par un trait dans la grille horaire</label>
    <h3>Agenda local</h3>
    <p class="muted small">L'agenda local contient des exemples (dont une garde alternée) pour tester sans compte Google.</p>
    <button type="button" class="btn btn-outline btn-sm" data-set="reset">Réinitialiser l'agenda local</button>
    <div class="dlg-foot"><span class="spacer"></span>
      <button type="button" class="btn btn-ghost" data-set="close">Annuler</button>
      <button type="submit" class="btn btn-primary">Enregistrer</button></div></form>`;
  const f = $('#settings-form');
  f.onclick = async (e) => {
    const t = e.target.closest('[data-set],[data-copy]');
    if (!t) return;
    if (t.dataset.copy) {
      navigator.clipboard?.writeText(t.dataset.copy).then(() => toast('Origine copiée'));
    } else if (t.dataset.set === 'close') dlg.close();
    else if (t.dataset.set === 'reset') {
      const ok = await ask({
        title: "Réinitialiser l'agenda local ?",
        message: 'Les événements locaux seront remplacés par les exemples. Google Agenda n\'est pas concerné.',
        buttons: [{ label: 'Annuler', value: null }, { label: 'Réinitialiser', value: true, danger: true }],
      });
      if (!ok) return;
      new LocalStore().reset();
      if (state.store?.kind === 'local') {
        state.store.load();
        state.cache.clear();
        await loadCalendars();
        refresh({ force: true });
      }
      toast('Agenda local réinitialisé');
    }
  };
  f.onsubmit = (e) => {
    e.preventDefault();
    const clientId = f.elements.clientId.value.trim();
    const changedId = clientId !== settings.clientId;
    settings.clientId = clientId;
    settings.scrollHour = +f.elements.scrollHour.value;
    settings.showRails = f.elements.showRails.checked;
    if (changedId) {
      settings.everConnected = false;
      state.auth?.clear();
      state.auth = null;
      if (settings.mode === 'google') settings.mode = 'local';
    }
    saveSettings();
    dlg.close();
    if (changedId) setupStore();
    else render();
  };
  dlg.showModal();
}

function toast(msg, kind = '') {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.append(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 3000);
  setTimeout(() => t.remove(), kind === 'error' ? 6500 : 3500);
}

// ---------------------------------------------------------------------------
// Interactions

function toggleSidebar(open) {
  const sb = $('#sidebar');
  const on = open ?? !sb.classList.contains('open');
  sb.classList.toggle('open', on);
  $('#scrim').hidden = !on;
}

let lastPointerType = 'mouse';

function wire() {
  $('#btn-menu').innerHTML = icon('menu', 22);
  $('#btn-prev').innerHTML = icon('left', 22);
  $('#btn-next').innerHTML = icon('right', 22);
  $('#btn-sync').innerHTML = icon('sync', 20);
  $('#btn-settings').innerHTML = icon('settings', 20);
  $('.create-icon').innerHTML = icon('plus', 22);

  $('#btn-menu').onclick = () => toggleSidebar();
  $('#scrim').onclick = () => toggleSidebar(false);
  $('#btn-today').onclick = goToday;
  $('#btn-prev').onclick = () => move(-1);
  $('#btn-next').onclick = () => move(1);
  $('#btn-sync').onclick = () => {
    if (state.store?.kind === 'google' && !state.auth?.valid) return connectGoogle({ reconnect: true });
    state.cache.clear();
    refresh({ force: true });
  };
  $('#btn-settings').onclick = openSettings;
  $('#btn-settings-side').onclick = () => {
    toggleSidebar(false);
    openSettings();
  };
  $('#btn-create').onclick = () => {
    toggleSidebar(false);
    openEditor();
  };
  $('#views').onclick = (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  };
  $('#views-select').onchange = (e) => setView(e.target.value);
  $('#btn-people-all').onclick = () => {
    state.hiddenPeople.clear();
    LS.set('agenda.hiddenPeople', []);
    render();
  };

  // Actions globales (bannière, sidebar, éditeur)
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    if (a.dataset.action === 'reconnect') connectGoogle({ reconnect: true });
    else if (a.dataset.action === 'connect') connectGoogle();
    else if (a.dataset.action === 'disconnect') disconnectGoogle();
  });

  // Sidebar
  const sb = $('#sidebar');
  sb.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.cal) {
      t.checked ? state.hiddenCals.delete(t.dataset.cal) : state.hiddenCals.add(t.dataset.cal);
      saveHiddenCals();
      state.cache.clear();
      render();
      if (t.checked) refresh({ force: true });
    } else if (t.dataset.person) {
      t.checked ? state.hiddenPeople.delete(t.dataset.person) : state.hiddenPeople.add(t.dataset.person);
      LS.set('agenda.hiddenPeople', [...state.hiddenPeople]);
      render();
    }
  });
  sb.addEventListener('click', (e) => {
    const t = e.target.closest('[data-only],[data-mini-day],[data-mini-move]');
    if (!t) return;
    if (t.dataset.only) {
      const keep = t.dataset.only;
      state.hiddenPeople = new Set([...people.all(state.events).filter((n) => n !== keep), NONE]);
      LS.set('agenda.hiddenPeople', [...state.hiddenPeople]);
      render();
    } else if (t.dataset.miniDay) {
      state.cursor = parseDate(t.dataset.miniDay);
      state.miniCursor = null;
      toggleSidebar(false);
      update();
    } else if (t.dataset.miniMove) {
      state.miniCursor = addMonths(state.miniCursor || startOfMonth(state.cursor), +t.dataset.miniMove);
      renderMini(viewDays());
    }
  });
  sb.addEventListener('submit', (e) => {
    if (e.target.id !== 'add-person') return;
    e.preventDefault();
    const name = people.add(e.target.elements.name.value);
    if (name) render();
  });

  // Vue principale
  const main = $('#main');
  main.addEventListener('click', (e) => {
    const evEl = e.target.closest('[data-key]');
    if (evEl) {
      const ev = state.byKey.get(evEl.dataset.key);
      if (ev) openPopover(ev, evEl);
      return;
    }
    const go = e.target.closest('[data-goto]');
    if (go) return goDay(parseDate(go.dataset.goto));
    const bandDay = e.target.closest('[data-band-day]');
    if (bandDay) {
      const d = parseDate(bandDay.dataset.bandDay);
      return openEditor({ allDay: true, start: d, end: addDays(d, 1) });
    }
    const cell = e.target.closest('[data-cell-day]');
    if (cell) {
      const d = parseDate(cell.dataset.cellDay);
      return openEditor({ allDay: true, start: d, end: addDays(d, 1) });
    }
    // Tactile : un appui sur un créneau vide crée un événement
    const col = e.target.closest('.col');
    if (col && lastPointerType === 'touch') {
      const r = col.getBoundingClientRect();
      const min = Math.min(Math.floor((((e.clientY - r.top) / r.height) * 1440) / 30) * 30, 1410);
      const start = parseDate(col.dataset.day);
      start.setHours(0, min, 0, 0);
      openEditor({ start, end: new Date(+start + HOUR_MS) });
    }
  });

  // Souris : cliquer-glisser dans la grille pour créer
  main.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
    const col = e.target.closest('.col');
    if (!col || e.pointerType === 'touch' || e.button !== 0 || e.target.closest('[data-key]')) return;
    e.preventDefault();
    closePopover();
    const day = parseDate(col.dataset.day);
    const r = col.getBoundingClientRect();
    const slot = (y) => Math.max(0, Math.min(1440 - 15, Math.floor((((y - r.top) / r.height) * 1440) / 15) * 15));
    const anchor = slot(e.clientY);
    let a = anchor;
    let b = anchor + 15;
    let moved = false;
    clearGhost();
    ghostEl = document.createElement('div');
    ghostEl.className = 'ghost';
    col.append(ghostEl);
    const draw = () => {
      ghostEl.style.top = `${(a / 1440) * 100}%`;
      ghostEl.style.height = `${((b - a) / 1440) * 100}%`;
      const s = new Date(day);
      s.setHours(0, a);
      const en = new Date(day);
      en.setHours(0, b);
      ghostEl.textContent = `${fmtTime(s)} → ${fmtTime(en)}`;
    };
    const onMove = (ev) => {
      const cur = slot(ev.clientY);
      if (cur !== anchor) moved = true;
      a = Math.min(anchor, cur);
      b = Math.max(anchor, cur) + 15;
      draw();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) {
        a = Math.floor(anchor / 30) * 30;
        b = Math.min(a + 60, 1440);
        draw();
      }
      const start = new Date(day);
      start.setHours(0, a, 0, 0);
      const end = new Date(day);
      end.setHours(0, b, 0, 0);
      openEditor({ start, end });
    };
    draw();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  // Glisser horizontalement (mobile) pour changer de période
  let touch0 = null;
  main.addEventListener('touchstart', (e) => {
    touch0 = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  main.addEventListener('touchend', (e) => {
    if (!touch0) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch0.x;
    const dy = t.clientY - touch0.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy) && Date.now() - touch0.t < 600) move(dx < 0 ? 1 : -1);
    touch0 = null;
  }, { passive: true });

  // Popover
  $('#popover').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pop]');
    if (!b || !popEv) return;
    const ev = popEv;
    if (b.dataset.pop === 'close') closePopover();
    else if (b.dataset.pop === 'edit') openEditor({ ev });
    else if (b.dataset.pop === 'delete') deleteFlow(ev);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#popover').hidden && !e.target.closest('#popover') && !e.target.closest('[data-key]')) closePopover();
  });

  // Clavier (mêmes raccourcis que Google Agenda)
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('[role="button"][data-key]')) {
      e.preventDefault();
      e.target.click();
      return;
    }
    if (e.target.closest('input, textarea, select, dialog') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Escape') closePopover();
    else if (k === 't') goToday();
    else if (k === 'j' || k === 'n' || k === 'ArrowRight') move(1);
    else if (k === 'k' || k === 'p' || k === 'ArrowLeft') move(-1);
    else if (k === 'd' || k === '1') setView('day');
    else if (k === 'x' || k === '3') setView('3days');
    else if (k === 'w' || k === '2') setView('week');
    else if (k === 'm' || k === '4') setView('month');
    else if (k === 'c') {
      e.preventDefault();
      openEditor();
    } else return;
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      closePopover();
      render();
    }, 150);
  });

  // Synchro : au retour sur l'onglet et toutes les 5 minutes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.store) return;
    if (state.store.kind === 'google' && !state.auth?.valid) {
      state.authExpired = true;
      renderBanner();
      renderSidebar(viewDays());
      return;
    }
    if (Date.now() - state.lastFetch > 60_000) refresh({ force: true });
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && state.store?.kind === 'google' && state.auth?.valid) refresh({ force: true });
  }, SYNC_EVERY_MS);
  // Ligne de l'heure courante et expiration du jeton
  setInterval(() => {
    if (state.store?.kind === 'google' && !state.authExpired && !state.auth?.valid) {
      state.authExpired = true;
      renderBanner();
      renderSidebar(viewDays());
    }
    if (!$('#editor').open && $('#popover').hidden) renderMain(viewDays());
  }, 60_000);
}

// ---------------------------------------------------------------------------

wire();
setupStore().catch(handleError);
if (settings.clientId) loadGis().catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
