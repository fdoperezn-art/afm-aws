// Utilidades pequeñas de DOM y formato.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapa texto para insertarlo en HTML (evita inyección de código desde los reportes). */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const formatDate = (iso) =>
  new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

export const formatDateTime = (iso) =>
  new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));

export const brand = () =>
  '<span class="brand"><img class="brand-logo" src="/afm-logo.jpg" alt="AFM"><span class="brand-wordmark">AQUÍ FALTA<br>LA MUNI<span>.</span></span></span>';

let toastTimer;
export function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 4500);
}

/** Normaliza texto para búsquedas sin tildes ni mayúsculas. */
export const fold = (text) => String(text).toLocaleLowerCase('es').normalize('NFD').replace(/\p{Diacritic}/gu, '');
