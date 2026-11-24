// Reglas del formulario «Visita a terreno» (/equipo), compartidas entre el navegador y la API.
import { isInsideConchali, OUTSIDE_MESSAGE } from './geo.js';

export const VISIT_LIMITS = {
  firstName: 80,
  lastNames: 120,
  phone: 20,
  address: 160,
  role: 120,
  commitment: 1500,
  registeredBy: 80,
};

/** Teléfono chileno: celular (9 + 8 dígitos) o fijo (9 dígitos), con o sin +56. */
export const VISIT_PHONE_RE = /^(\+?56)?\d{9}$/;

const clean = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/** Fecha local de hoy en formato AAAA-MM-DD. */
export function todayISO(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

/** Valida una visita. Devuelve un mensaje de error o '' si está bien. */
export function validateVisit(v, { today = todayISO() } = {}) {
  if (!clean(v.firstName)) return 'Completa el nombre.';
  if (!clean(v.lastNames)) return 'Completa los apellidos.';
  if (!VISIT_PHONE_RE.test(String(v.phone || '').replace(/[\s()-]/g, '')))
    return 'Ingresa un teléfono válido: 9 dígitos (ej. 9 1234 5678 o 2 2345 6789).';
  if (!clean(v.address)) return 'Completa la dirección.';
  if (!clean(v.role)) return 'Completa el cargo.';
  if (!clean(v.commitment)) return 'Describe el compromiso.';
  for (const [field, max] of Object.entries(VISIT_LIMITS)) {
    if (clean(v[field]).length > max) return `El campo es demasiado largo (máximo ${max} caracteres).`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.visitDate || '') || Number.isNaN(Date.parse(v.visitDate)))
    return 'Indica la fecha de la visita.';
  if (v.visitDate > today) return 'La fecha de la visita no puede ser futura.';
  if (v.visitDate < '2020-01-01') return 'Revisa la fecha de la visita.';
  if (v.location != null) {
    const { lat, lng } = v.location;
    if (!isInsideConchali(Number(lat), Number(lng))) return OUTSIDE_MESSAGE;
  }
  return '';
}

/** Normaliza los textos de una visita ya validada. */
export function normalizeVisit(v) {
  const phoneDigits = String(v.phone).replace(/[\s()-]/g, '').replace(/^\+?56/, '');
  return {
    firstName: clean(v.firstName),
    lastNames: clean(v.lastNames),
    phone: `+56${phoneDigits}`,
    address: clean(v.address),
    role: clean(v.role),
    commitment: String(v.commitment).trim(),
    visitDate: v.visitDate,
    registeredBy: clean(v.registeredBy),
    location:
      v.location != null
        ? { lat: Math.round(Number(v.location.lat) * 1e6) / 1e6, lng: Math.round(Number(v.location.lng) * 1e6) / 1e6 }
        : undefined,
  };
}
