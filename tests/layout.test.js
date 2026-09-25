import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisPos, bandLayout, splitByDay, packColumns, railLayout, isSpanning } from '../js/layout.js';
import { dayRange } from '../js/dates.js';

// Semaine du lundi 14 au dimanche 20 septembre 2026
const days = dayRange(new Date(2026, 8, 14), 7);
const at = (d, h, m = 0) => new Date(2026, 8, d, h, m);
const ev = (title, start, end, o = {}) => ({ title, start, end, allDay: false, ...o });

test('un événement de 24 h ou plus va dans le bandeau, pas un événement court', () => {
  assert.equal(isSpanning(ev('garde', at(18, 19), at(25, 19))), true);
  assert.equal(isSpanning(ev('pile 24 h', at(18, 19), at(19, 19))), true);
  assert.equal(isSpanning(ev('concert', at(18, 22), at(19, 1))), false);
  assert.equal(isSpanning({ ...ev('jour', at(18, 0), at(19, 0)), allDay: true }), true);
});

test('un événement commençant vendredi 19:00 démarre aux 19/24 du vendredi', () => {
  const x = axisPos(at(18, 19), days);
  assert.ok(Math.abs(x - (4 + 19 / 24)) < 1e-9, `x = ${x}`);
});

test('garde alternée : les deux gardes partagent la même ligne et se touchent à 19:00', () => {
  const maman = ev('Chez maman', at(11, 19), at(18, 19));
  const papa = ev('Chez papa', at(18, 19), at(25, 19));
  const { items, lanes } = bandLayout([papa, maman], days);
  assert.equal(lanes, 1);
  const m = items.find((i) => i.ev === maman);
  const p = items.find((i) => i.ev === papa);
  assert.equal(m.x0, 0);
  assert.equal(m.startsBefore, true);
  assert.ok(Math.abs(m.x1 - p.x0) < 1e-9);
  assert.equal(p.x1, 7);
  assert.equal(p.endsAfter, true);
});

test('deux événements longs qui se chevauchent prennent deux lignes', () => {
  const a = ev('A', at(14, 8), at(16, 8));
  const b = ev('B', at(15, 8), at(17, 8));
  assert.equal(bandLayout([a, b], days).lanes, 2);
});

test('un événement court qui passe minuit est découpé sur les deux jours', () => {
  const concert = ev('Concert', at(18, 22), at(19, 1));
  const cols = splitByDay([concert], days);
  assert.equal(cols[4].length, 1);
  assert.ok(Math.abs(cols[4][0].top - 22 / 24) < 1e-9);
  assert.equal(cols[4][0].bottom, 1);
  assert.equal(cols[4][0].endsAfter, true);
  assert.equal(cols[5][0].top, 0);
  assert.ok(Math.abs(cols[5][0].bottom - 1 / 24) < 1e-9);
});

test('les événements qui se chevauchent sont répartis en colonnes', () => {
  const segs = splitByDay(
    [ev('a', at(14, 9), at(14, 11)), ev('b', at(14, 10), at(14, 12)), ev('c', at(14, 13), at(14, 14))],
    days,
  )[0];
  packColumns(segs);
  const by = Object.fromEntries(segs.map((s) => [s.ev.title, s]));
  assert.equal(by.a.cols, 2);
  assert.equal(by.b.cols, 2);
  assert.notEqual(by.a.col, by.b.col);
  assert.equal(by.c.cols, 1);
});

test('la hauteur minimale compte pour les chevauchements', () => {
  const segs = splitByDay([ev('a', at(14, 9), at(14, 9, 5)), ev('b', at(14, 9, 10), at(14, 10))], days)[0];
  packColumns(segs, 22 / 1440);
  assert.equal(segs[0].cols, 2);
});

test('les rails suivent la garde heure par heure', () => {
  const papa = ev('Chez papa', at(18, 19), at(25, 19));
  const { cols, lanes } = railLayout([papa], days);
  assert.equal(lanes, 1);
  assert.equal(cols[3].length, 0);
  assert.ok(Math.abs(cols[4][0].top - 19 / 24) < 1e-9);
  assert.equal(cols[5][0].top, 0);
  assert.equal(cols[6][0].bottom, 1);
});

test('les journées entières ne produisent pas de rail', () => {
  const vac = { ...ev('Vacances', at(14, 0), at(17, 0)), allDay: true };
  assert.equal(railLayout([vac], days).lanes, 0);
});
