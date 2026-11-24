import { BOUNDARY } from './boundary.js';

const RING = BOUNDARY.geometry.coordinates[0]; // [lng, lat]
const lats = RING.map((p) => p[1]);
const lngs = RING.map((p) => p[0]);

/** Centro aproximado de Conchalí [lat, lng]. */
export const CENTER = [-33.3845, -70.675];

/** Rectángulo que contiene la comuna: [[latMin, lngMin], [latMax, lngMax]]. */
export const BOUNDS = [
  [Math.min(...lats), Math.min(...lngs)],
  [Math.max(...lats), Math.max(...lngs)],
];

export const OUTSIDE_MESSAGE =
  'Este punto se encuentra fuera de Conchalí. AFM permite registrar reportes dentro de la comuna.';

/** true si el punto (lat, lng) está dentro del límite comunal (algoritmo ray casting). */
export function isInsideConchali(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  let inside = false;
  for (let i = 0, j = RING.length - 1; i < RING.length; j = i++) {
    const [xi, yi] = RING[i];
    const [xj, yj] = RING[j];
    const crosses = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}
