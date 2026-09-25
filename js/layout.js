// Algorithmes de placement, sans DOM (testables sous Node).
//
// Le principe qui corrige le défaut de Google Agenda : un événement long
// (journée entière, ou horaire de 24 h et plus) est placé dans le bandeau du
// haut à sa position RÉELLE dans le temps. Un événement qui commence vendredi
// à 19:00 démarre donc aux 19/24 de la case du vendredi au lieu de remplir
// toute la journée. Deux gardes qui se passent le relais à 19:00 partagent la
// même ligne et se touchent exactement à l'heure du changement.

import { addDays, HOUR_MS } from './dates.js';

export const SPAN_THRESHOLD_MS = 24 * HOUR_MS;

export const isSpanning = (ev) => ev.allDay || ev.end - ev.start >= SPAN_THRESHOLD_MS;

const EPS = 1e-6;

// Position d'un instant sur un axe continu où le jour i couvre [i, i+1[.
// `days` = minuits consécutifs.
export function axisPos(t, days) {
  const n = days.length;
  if (t <= days[0]) return 0;
  for (let i = 0; i < n; i++) {
    const s = days[i];
    const e = i + 1 < n ? days[i + 1] : addDays(days[n - 1], 1);
    if (t < e) return i + (t - s) / (e - s);
  }
  return n;
}

// Répartit les événements longs en lignes (lanes) dans le bandeau.
// Renvoie { items: [{ ev, x0, x1, lane, startsBefore, endsAfter }], lanes }
export function bandLayout(events, days) {
  const n = days.length;
  const rangeStart = days[0];
  const rangeEnd = addDays(days[n - 1], 1);
  const items = events
    .filter((ev) => ev.start < rangeEnd && ev.end > rangeStart)
    .map((ev) => ({
      ev,
      x0: axisPos(ev.start, days),
      x1: axisPos(ev.end, days),
      startsBefore: ev.start < rangeStart,
      endsAfter: ev.end > rangeEnd,
    }));

  items.sort(
    (a, b) =>
      a.x0 - b.x0 ||
      b.x1 - b.x0 - (a.x1 - a.x0) ||
      (a.ev.allDay === b.ev.allDay ? 0 : a.ev.allDay ? -1 : 1) ||
      String(a.ev.title).localeCompare(String(b.ev.title)),
  );

  // Placement glouton : la première ligne libre à l'instant de début.
  // Un événement peut commencer pile quand le précédent se termine.
  const laneEnds = [];
  for (const it of items) {
    let lane = laneEnds.findIndex((end) => end <= it.x0 + EPS);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = it.x1;
    it.lane = lane;
  }
  return { items, lanes: laneEnds.length };
}

// Découpe des événements selon les jours affichés.
// Renvoie un tableau (un par jour) de { ev, top, bottom, startsBefore, endsAfter }
// avec top/bottom en fraction de journée (0 = minuit, 1 = minuit suivant).
export function splitByDay(events, days) {
  return days.map((day) => {
    const s = day;
    const e = addDays(day, 1);
    const segs = [];
    for (const ev of events) {
      const instant = ev.start.getTime() === ev.end.getTime();
      const inside = instant ? ev.start >= s && ev.start < e : ev.start < e && ev.end > s;
      if (!inside) continue;
      const a = ev.start < s ? s : ev.start;
      const b = ev.end > e ? e : ev.end;
      segs.push({
        ev,
        top: (a - s) / (e - s),
        bottom: (b - s) / (e - s),
        startsBefore: ev.start < s,
        endsAfter: ev.end > e,
      });
    }
    return segs;
  });
}

// Colonnes pour les événements qui se chevauchent dans une journée.
// `minFrac` = hauteur minimale affichée (un événement de 5 min occupe
// visuellement plus que 5 min, il faut en tenir compte pour les chevauchements).
// Ajoute { col, cols } à chaque segment.
export function packColumns(segs, minFrac = 0) {
  segs.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster = [];
  let colEnds = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    for (const s of cluster) s.cols = colEnds.length;
    cluster = [];
    colEnds = [];
    clusterEnd = -Infinity;
  };
  for (const s of segs) {
    const visualBottom = Math.max(s.bottom, s.top + minFrac);
    if (cluster.length && s.top >= clusterEnd - EPS) flush();
    let col = colEnds.findIndex((end) => end <= s.top + EPS);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(0);
    }
    colEnds[col] = visualBottom;
    s.col = col;
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, visualBottom);
  }
  flush();
  return segs;
}

// "Rails" : fins traits verticaux dans la grille horaire qui montrent, heure
// par heure, les événements longs en cours (ex. chez qui sont les enfants).
// Les lignes sont les mêmes que dans le bandeau pour garder un ordre stable.
export function railLayout(events, days) {
  const timed = events.filter((ev) => !ev.allDay);
  const { items, lanes } = bandLayout(timed, days);
  const laneOf = new Map(items.map((it) => [it.ev, it.lane]));
  const cols = splitByDay(
    items.map((it) => it.ev),
    days,
  ).map((segs) => segs.map((s) => ({ ...s, lane: laneOf.get(s.ev) })));
  return { cols, lanes };
}
