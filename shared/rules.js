// Reglas de negocio compartidas entre el navegador y la API.
import { CATEGORIES } from './categories.js';
import { isInsideConchali, OUTSIDE_MESSAGE } from './geo.js';

export const TERMS_VERSION = '2026-09-13';
export const MAX_DESCRIPTION = 500;
export const MAX_PHOTOS = 2;
/** Foto original que elige el vecino (se reduce en el teléfono antes de subirla). */
export const MAX_ORIGINAL_BYTES = 15 * 1024 * 1024;
export const INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
/** Foto ya reducida que llega al servidor: siempre JPEG. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const UPLOAD_TYPE = 'image/jpeg';
/** Lado mayor de la foto reducida, en píxeles, y calidad JPEG. */
export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.82;

// Duplicados: misma foto si la huella perceptual difiere en pocos bits y está cerca.
export const DUP_HASH_MAX_DISTANCE = 8; // de 64 bits (una foto reenviada suele quedar en 0–6)
export const DUP_AUTO_MAX_METERS = 500;
export const DUP_SUGGEST_MAX_METERS = 50; // misma categoría a menos de esto → «posible duplicado»

/** Distancia en metros entre dos puntos (fórmula del semiverseno). */
export function distanceMeters(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

export const RELATIONS = ['Vivo en Conchalí', 'Trabajo en Conchalí', 'Estudio en Conchalí', 'Visito Conchalí'];
export const SECTORS = ['Vivo en este sector', 'Trabajo o estudio aquí', 'Paso por este sector'];
export const FLAG_REASONS = [
  'Contenido ofensivo o discriminatorio',
  'Amenazas o violencia',
  'Datos personales de terceros',
  'Contenido que no corresponde a AFM',
  'Otro motivo',
];

export const categoryById = (id) => CATEGORIES.find((c) => c.id === id) || CATEGORIES.at(-1);
export const PHONE_RE = /^9\d{8}$/;

/**
 * Valida un paso del asistente (0 a 4). Devuelve un mensaje de error o '' si está bien.
 * En el servidor se llama con todos los pasos sobre el borrador ya armado.
 */
export function validateStep(step, d) {
  if (step === 0 && !CATEGORIES.some((c) => c.id === d.category)) return 'Selecciona una categoría para continuar.';
  if (step === 1 && !categoryById(d.category).details.includes(d.detail)) return 'Selecciona el detalle de tu reporte.';
  if (step === 2 && !d.location) return 'Marca la ubicación del problema en el mapa.';
  if (step === 2 && !isInsideConchali(d.location.lat, d.location.lng)) return OUTSIDE_MESSAGE;
  if (step === 3) {
    const text = (d.description || '').trim();
    if (!text || text.length > MAX_DESCRIPTION) return 'Describe el problema usando entre 1 y 500 caracteres.';
    if (!d.photos?.length || d.photos.length > MAX_PHOTOS) return 'Agrega al menos una foto. Puedes subir hasta dos.';
  }
  if (step === 4) {
    if (!d.firstName?.trim() || !d.lastName?.trim()) return 'Completa tu nombre y apellido.';
    if (d.firstName.trim().length > 80 || d.lastName.trim().length > 80)
      return 'El nombre y el apellido admiten hasta 80 caracteres.';
    if (!PHONE_RE.test((d.phone || '').replace(/\s/g, '')))
      return 'Ingresa un celular chileno válido: 9 seguido de 8 dígitos.';
    if (!RELATIONS.includes(d.relation)) return 'Selecciona tu relación con Conchalí.';
    if (!SECTORS.includes(d.sector)) return 'Selecciona tu relación con el sector.';
    if (!d.consent)
      return 'Debes conocer y aceptar los Términos y privacidad y las normas de uso de AFM para finalizar el reporte.';
  }
  return '';
}

/** Valida el reporte completo; devuelve el primer error o ''. */
export function validateReport(d) {
  for (let step = 0; step < 5; step++) {
    const error = validateStep(step, d);
    if (error) return error;
  }
  return '';
}
