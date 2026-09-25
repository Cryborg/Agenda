import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, presetOf, presetToRRule } from '../js/recur.js';
import { shiftLike } from '../js/dates.js';

const at = (m, d, h, mi = 0) => new Date(2026, m - 1, d, h, mi);

test('garde une semaine sur deux : les occurrences qui débordent sur la plage sont incluses', () => {
  const master = { start: at(9, 4, 19), end: at(9, 11, 19), rrule: 'RRULE:FREQ=WEEKLY;INTERVAL=2' };
  const occ = expand(master, at(9, 14, 0), at(9, 21, 0));
  // L'occurrence du 18 au 25 touche la semaine, celle du 4 au 11 non
  assert.deepEqual(occ.map((o) => o.start.getDate()), [18]);
  assert.equal(occ[0].end.getDate(), 25);
  assert.equal(occ[0].end.getHours(), 19);
});

test("l'heure reste 19:00 après le passage à l'heure d'hiver", () => {
  const master = { start: at(10, 16, 19), end: at(10, 23, 19), rrule: 'RRULE:FREQ=WEEKLY;INTERVAL=2' };
  const occ = expand(master, at(10, 26, 0), at(11, 30, 0));
  assert.ok(occ.length >= 2);
  for (const o of occ) {
    assert.equal(o.start.getHours(), 19);
    assert.equal(o.end.getHours(), 19);
  }
});

test('les dates exclues et COUNT sont respectées', () => {
  const start = at(9, 1, 10);
  const master = {
    start,
    end: at(9, 1, 11),
    rrule: 'RRULE:FREQ=DAILY;COUNT=5',
    exdates: [at(9, 3, 10).getTime()],
  };
  const occ = expand(master, at(8, 1, 0), at(10, 1, 0));
  assert.deepEqual(occ.map((o) => o.start.getDate()), [1, 2, 4, 5]);
});

test('événement non récurrent hors plage : rien', () => {
  assert.equal(expand({ start: at(9, 1, 10), end: at(9, 1, 11) }, at(9, 2, 0), at(9, 3, 0)).length, 0);
});

test('préréglages de récurrence', () => {
  const fri = at(9, 18, 19);
  assert.equal(presetOf('RRULE:FREQ=WEEKLY;INTERVAL=2', fri), 'WEEKLY2');
  assert.equal(presetOf('RRULE:FREQ=WEEKLY;BYDAY=FR', fri), 'WEEKLY');
  assert.equal(presetOf('RRULE:FREQ=WEEKLY;BYDAY=MO,FR', fri), 'custom');
  assert.equal(presetOf('RRULE:FREQ=MONTHLY;UNTIL=20270101T000000Z', fri), 'custom');
  assert.equal(presetOf(null, fri), '');
  assert.equal(presetToRRule('WEEKLY2'), 'RRULE:FREQ=WEEKLY;INTERVAL=2');
  assert.equal(presetToRRule(''), null);
});

test("décaler une occurrence décale la série d'autant", () => {
  // Série qui commence le 4 sept. 19:00 ; on déplace l'occurrence du 18 au samedi 19 à 18:00
  const r = shiftLike(at(9, 4, 19), at(9, 18, 19), at(9, 19, 18));
  assert.equal(r.getDate(), 5);
  assert.equal(r.getHours(), 18);
});
