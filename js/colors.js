// Palette des couleurs d'événements de Google Agenda (colorId 1 à 11)
export const EVENT_COLORS = {
  1: { name: 'Lavande', hex: '#7986cb' },
  2: { name: 'Sauge', hex: '#33b679' },
  3: { name: 'Raisin', hex: '#8e24aa' },
  4: { name: 'Flamant rose', hex: '#e67c73' },
  5: { name: 'Banane', hex: '#f6bf26' },
  6: { name: 'Mandarine', hex: '#f4511e' },
  7: { name: 'Paon', hex: '#039be5' },
  8: { name: 'Graphite', hex: '#616161' },
  9: { name: 'Myrtille', hex: '#3f51b5' },
  10: { name: 'Basilic', hex: '#0b8043' },
  11: { name: 'Tomate', hex: '#d50000' },
};

export function eventColor(ev, calendarsById) {
  if (ev.colorId && EVENT_COLORS[ev.colorId]) return EVENT_COLORS[ev.colorId].hex;
  return calendarsById.get(ev.calendarId)?.color || '#039be5';
}

// Couleur du texte lisible sur un fond donné
export function textOn(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return '#fff';
  const [r, g, b] = m.slice(1).map((x) => {
    const c = parseInt(x, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // 0.179 : seuil où le contraste avec le noir et le blanc s'équilibre
  return L > 0.179 ? '#1f1f1f' : '#ffffff';
}
