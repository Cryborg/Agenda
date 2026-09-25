// Registre local des personnes (nom + couleur). Les assignations elles-mêmes
// voyagent avec les événements ; ce registre complète simplement la liste
// avec les personnes créées ici et garde les couleurs choisies.

const KEY = 'agenda.people.v1';
const PALETTE = ['#8ab4f8', '#f28b82', '#fdd663', '#81c995', '#c58af9', '#78d9ec', '#fcad70', '#ff8bcb', '#a8dab5', '#d7aefb'];

function hash(s) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) | 0;
  return Math.abs(h);
}

export class People {
  constructor() {
    try {
      this.list = JSON.parse(localStorage.getItem(KEY) || '[]');
    } catch {
      this.list = [];
    }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.list));
    } catch {
      /* rien */
    }
  }

  find(name) {
    const n = name.trim().toLocaleLowerCase('fr');
    return this.list.find((p) => p.name.toLocaleLowerCase('fr') === n);
  }

  add(name) {
    name = name.trim();
    if (!name) return null;
    const existing = this.find(name);
    if (existing) return existing.name;
    this.list.push({ name, color: PALETTE[this.list.length % PALETTE.length] });
    this.save();
    return name;
  }

  remove(name) {
    this.list = this.list.filter((p) => p.name !== name);
    this.save();
  }

  color(name) {
    return this.find(name)?.color || PALETTE[hash(name) % PALETTE.length];
  }

  // Liste complète : registre + noms rencontrés dans les événements chargés
  all(events = []) {
    const names = new Map(this.list.map((p) => [p.name.toLocaleLowerCase('fr'), p.name]));
    for (const ev of events) for (const n of ev.people || []) {
      const k = n.toLocaleLowerCase('fr');
      if (!names.has(k)) names.set(k, n);
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b, 'fr'));
  }
}

export const initials = (name) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toLocaleUpperCase('fr'))
    .join('');
