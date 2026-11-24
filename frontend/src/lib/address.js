// Formato de direcciones y consultas a Nominatim (OpenStreetMap).
import { BOUNDS } from '../../../shared/geo.js';

const clean = (v) => String(v || '').trim().replace(/\s+/g, ' ');
const shortStreet = (v) => clean(v).replace(/^Avenida\s+/i, 'Av. ').replace(/^Pasaje\s+/i, 'Pje. ');
const shortSector = (v) => clean(v).replace(/^(Población|Poblacion|Barrio|Sector)\s+/i, '');
const isGeneric = (v) =>
  /^(Conchal[ií]|Chile|Provincia de Santiago|Santiago|Regi[oó]n Metropolitana.*|Santiago Metropolitan Region|\d{7})$/i.test(
    clean(v),
  );

/** Convierte una respuesta de Nominatim en { street, number, neighborhood }. */
export function partsFromNominatim(result) {
  const a = result.address || {};
  const hood = a.neighbourhood || a.quarter || a.residential || a.suburb || '';
  return {
    street: shortStreet(a.road || a.pedestrian || a.footway || a.path || ''),
    number: clean(a.house_number),
    neighborhood: isGeneric(hood) ? '' : shortSector(hood),
  };
}

/** Texto corto de la dirección de un reporte, de sus partes o de un texto libre. */
export function formatAddress(value) {
  if (value && typeof value === 'object') {
    if (value.addressParts && (value.addressParts.street || value.addressParts.neighborhood))
      return formatAddress(value.addressParts);
    if ('street' in value || 'neighborhood' in value) {
      return (
        [
          [shortStreet(value.street), clean(value.number)].filter(Boolean).join(' '),
          isGeneric(value.neighborhood) ? '' : shortSector(value.neighborhood),
        ]
          .filter(Boolean)
          .join(', ') || 'Ubicación en Conchalí'
      );
    }
    return formatAddress(value.address);
  }
  const parts = clean(value).split(',').map(clean).filter(Boolean).filter((p) => !isGeneric(p));
  if (/^\d+[\w/-]*$/.test(parts[0] || '') && parts[1]) {
    const [number, street, ...rest] = parts;
    return formatAddress({ street, number, neighborhood: rest[0] || '' });
  }
  return !parts.length || /^Punto en Conchalí/i.test(parts[0])
    ? 'Ubicación en Conchalí'
    : [shortStreet(parts[0]), ...parts.slice(1, 2).map(shortSector)].join(', ');
}

// Nominatim pide como máximo 1 consulta por segundo: se encolan y se cachean.
const cache = new Map();
let queue = Promise.resolve();
let lastCall = 0;

function nominatim(path, params) {
  const key = `${path}?${new URLSearchParams({ ...params, format: 'jsonv2', addressdetails: '1', 'accept-language': 'es' })}`;
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  const job = queue
    .catch(() => {})
    .then(async () => {
      if (cache.has(key)) return cache.get(key);
      await new Promise((r) => setTimeout(r, Math.max(0, 1200 - (Date.now() - lastCall))));
      lastCall = Date.now();
      const res = await fetch(`https://nominatim.openstreetmap.org/${key}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error('El servicio de direcciones no está disponible.');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      cache.set(key, data);
      return data;
    });
  queue = job;
  return job;
}

export const reverseGeocode = (lat, lng) => nominatim('reverse', { lat: String(lat), lon: String(lng), zoom: '18' });

export const searchAddress = (text) =>
  nominatim('search', {
    q: `${text}, Conchalí, Santiago, Chile`,
    limit: '4',
    countrycodes: 'cl',
    viewbox: `${BOUNDS[0][1]},${BOUNDS[1][0]},${BOUNDS[1][1]},${BOUNDS[0][0]}`,
    bounded: '1',
  });
