// /equipo — registro de visitas a terreno y reuniones del equipo AFM.
// No aparece en el sitio público. Requiere el código compartido del equipo, que solo permite registrar
// visitas (no da acceso a los reportes ni a los datos de los vecinos).
import L from 'leaflet';
import '../styles.css';
import '../admin/admin.css';
import './equipo.css';

import { BOUNDARY } from '../../../shared/boundary.js';
import { BOUNDS, CENTER, OUTSIDE_MESSAGE, isInsideConchali } from '../../../shared/geo.js';
import { VISIT_LIMITS, todayISO, validateVisit } from '../../../shared/visits.js';
import * as api from '../lib/api.js';
import { formatAddress, partsFromNominatim, reverseGeocode, searchAddress } from '../lib/address.js';
import { $, brand, esc, toast } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

const CODE_KEY = 'afm-team-code'; // solo mientras la pestaña esté abierta
const app = $('#app');
let map;
let marker;
let draft;
let lookupTimer;

const readCode = () => {
  try {
    return sessionStorage.getItem(CODE_KEY) || '';
  } catch {
    return '';
  }
};
const saveCode = (c) => {
  try {
    if (c) sessionStorage.setItem(CODE_KEY, c);
    else sessionStorage.removeItem(CODE_KEY);
  } catch {
    /* sin almacenamiento: se pedirá el código en cada visita */
  }
};
let code = readCode();

function shell(content) {
  app.innerHTML = `<header class="header admin-header"><span class="brand-button">${brand()}</span><span class="admin-badge">${icon('map-pin', 15)} EQUIPO</span><div class="header-actions" id="team-actions"></div></header><main class="admin-main team-main">${content}</main>`;
}

// ---------- Código del equipo ----------
function renderCode(message = '') {
  shell(`<section class="admin-card"><span class="eyebrow">ACCESO DEL EQUIPO</span><h1>Visitas a terreno</h1><p class="muted">Ingresa el código del equipo para registrar reuniones y visitas a terreno.</p>
    <form id="code-form" class="admin-form"><label class="field-label" for="team-code">Código del equipo</label><input class="dark-input" id="team-code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AFM-XXXX-XXXX-XXXX" required>
    <p class="form-error" id="code-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
    <button class="button orange full" type="submit">Continuar ${icon('arrow-right', 18)}</button></form></section>`);
  $('#team-code').focus();
  $('#code-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#code-form button');
    const value = $('#team-code').value.trim().toUpperCase();
    btn.disabled = true;
    try {
      await api.team.check(value);
      code = value;
      saveCode(code);
      renderForm();
    } catch (err) {
      btn.disabled = false;
      const el = $('#code-error');
      el.hidden = false;
      el.textContent =
        err.status === 401 ? 'Código incorrecto.' : err.status === 429 ? 'Demasiados intentos. Espera unos segundos.' : err.message;
    }
  };
}

// ---------- Formulario ----------
const field = (id, label, { type = 'text', max, required = true, placeholder = '', autocomplete = 'off', extra = '' } = {}) =>
  `<div><label class="field-label" for="${id}">${label} ${required ? '<span class="required">*</span>' : '<span>(opcional)</span>'}</label><input class="dark-input" id="${id}" data-field="${id}" type="${type}" ${max ? `maxlength="${max}"` : ''} placeholder="${placeholder}" autocomplete="${autocomplete}" value="${esc(draft[id])}" ${extra}></div>`;

function emptyDraft() {
  return { firstName: '', lastNames: '', phone: '', address: '', role: '', commitment: '', visitDate: todayISO(), registeredBy: draft?.registeredBy || '', location: null, addressEdited: false };
}

function renderForm() {
  draft = draft || emptyDraft();
  shell(`<div class="section-title"><div><span class="eyebrow muted">EQUIPO AFM</span><h1>Registrar visita<span class="orange-text">.</span></h1><p class="muted">Reuniones y visitas a terreno. Solo el equipo de moderación verá estos registros.</p></div></div>
    <form id="visit-form" class="team-form" novalidate>
      <fieldset><legend>Persona con quien se reunieron</legend>
        <div class="field-row">${field('firstName', 'Nombre', { max: VISIT_LIMITS.firstName })}${field('lastNames', 'Apellidos', { max: VISIT_LIMITS.lastNames })}</div>
        <div class="field-row">${field('phone', 'Teléfono', { type: 'tel', max: 16, placeholder: '9 1234 5678', extra: 'inputmode="tel"' })}${field('role', 'Cargo', { max: VISIT_LIMITS.role, placeholder: 'Ej. Presidenta junta de vecinos' })}</div>
        ${field('address', 'Dirección', { max: VISIT_LIMITS.address, placeholder: 'Escríbela o márcala en el mapa' })}
        <p class="field-help" id="address-status">Puedes escribirla a mano, buscarla o tocar el mapa.</p>
        <div id="address-search" class="address-search" role="search"><label class="sr-only" for="address-query">Buscar dirección en Conchalí</label>${icon('search', 19)}<input id="address-query" placeholder="Buscar dirección en Conchalí" autocomplete="off"><button type="button" aria-label="Buscar dirección">${icon('arrow-right', 20)}</button></div>
        <p id="search-status" class="search-status" role="status"></p><div id="address-results"></div>
        <div class="team-map-wrap"><div id="visit-map" aria-label="Ubicación en el mapa"></div></div>
        <p class="field-help" id="point-status">${draft.location ? 'Punto marcado.' : 'Sin punto marcado.'} <button type="button" class="text-button" id="clear-point" ${draft.location ? '' : 'hidden'}>Quitar punto</button> <button type="button" class="text-button" id="use-map-address" hidden>Usar la dirección del mapa</button></p>
      </fieldset>
      <fieldset><legend>La visita</legend>
        <div class="field-row">${field('visitDate', 'Fecha de visita', { type: 'date', extra: `max="${todayISO()}" min="2020-01-01"` })}${field('registeredBy', 'Registrado por', { required: false, max: VISIT_LIMITS.registeredBy, placeholder: 'Tu nombre' })}</div>
        <label class="field-label" for="commitment">Compromiso <span class="required">*</span></label>
        <textarea class="dark-input" id="commitment" data-field="commitment" rows="5" maxlength="${VISIT_LIMITS.commitment}" placeholder="¿Qué se acordó o a qué se comprometieron?">${esc(draft.commitment)}</textarea>
        <span class="char-count"><span id="commit-count">${draft.commitment.length}</span> / ${VISIT_LIMITS.commitment}</span>
      </fieldset>
      <p class="form-error" id="visit-error" role="alert" hidden></p>
      <button class="button orange full" type="submit">Guardar visita ${icon('check', 18)}</button>
    </form>`);
  $('#team-actions').innerHTML = `<button class="button black small" id="forget-code">${icon('log-out', 16)} Salir</button>`;
  $('#forget-code').onclick = () => {
    code = '';
    saveCode('');
    draft = null;
    renderCode();
  };
  document.querySelectorAll('[data-field]').forEach((el) => {
    el.oninput = () => {
      draft[el.dataset.field] = el.value;
      if (el.id === 'commitment') $('#commit-count').textContent = el.value.length;
      if (el.id === 'address') {
        draft.addressEdited = el.value.trim() !== '';
        $('#address-status').textContent = draft.addressEdited
          ? 'Dirección escrita a mano. El punto del mapa no la cambiará.'
          : 'Puedes escribirla a mano, buscarla o tocar el mapa.';
      }
    };
  });
  initMap();
  $('#visit-form').onsubmit = submit;
}

function setPoint(lat, lng, knownAddress = null) {
  if (!isInsideConchali(lat, lng)) return showError(OUTSIDE_MESSAGE);
  draft.location = { lat, lng };
  if (marker) marker.setLatLng([lat, lng]);
  else
    marker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({ className: 'location-pin', html: icon('map-pin', 34), iconSize: [34, 34], iconAnchor: [17, 32] }),
    })
      .addTo(map)
      .on('dragend', (e) => {
        const p = e.target.getLatLng();
        if (isInsideConchali(p.lat, p.lng)) {
          draft.location = { lat: p.lat, lng: p.lng };
          lookupAddress(p.lat, p.lng);
        } else {
          e.target.setLatLng([draft.location.lat, draft.location.lng]);
          showError(OUTSIDE_MESSAGE);
        }
      });
  $('#point-status').firstChild.textContent = 'Punto marcado. ';
  $('#clear-point').hidden = false;
  $('#visit-error').hidden = true;
  if (knownAddress) applyMapAddress(knownAddress);
  else lookupAddress(lat, lng);
}

/** Pone la dirección del mapa en el campo, salvo que se haya escrito a mano. */
function applyMapAddress(text, force = false) {
  draft.mapAddress = text;
  if (draft.addressEdited && !force) {
    $('#use-map-address').hidden = !text || text === draft.address;
    return;
  }
  draft.address = text;
  draft.addressEdited = false;
  $('#address').value = text;
  $('#use-map-address').hidden = true;
  $('#address-status').textContent = 'Dirección tomada del mapa. Revísala y corrígela si es necesario.';
}

function lookupAddress(lat, lng) {
  clearTimeout(lookupTimer);
  const point = draft.location;
  $('#address-status').textContent = 'Buscando la dirección del punto…';
  lookupTimer = setTimeout(async () => {
    try {
      const parts = partsFromNominatim(await reverseGeocode(lat, lng));
      if (draft.location !== point) return;
      const text = parts.street ? formatAddress(parts) : '';
      if (text) applyMapAddress(text);
      else $('#address-status').textContent = 'No encontramos la dirección de ese punto. Escríbela a mano.';
    } catch {
      if (draft.location === point) $('#address-status').textContent = 'No se pudo obtener la dirección. Escríbela a mano.';
    }
  }, 500);
}

async function onAddressSearch(e) {
  e.preventDefault();
  const query = $('#address-query').value.trim();
  const status = $('#search-status');
  const results = $('#address-results');
  const button = $('#address-search button');
  if (query.length < 3) {
    status.textContent = 'Escribe al menos 3 caracteres para buscar.';
    return;
  }
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = 'Buscando en Conchalí…';
  results.innerHTML = '';
  try {
    const found = await searchAddress(query);
    status.textContent = found.length ? 'Selecciona una dirección:' : 'No la encontramos. Márcala en el mapa o escríbela a mano.';
    results.innerHTML = found
      .map((r, i) => `<button type="button" data-address="${i}">${icon('map-pin', 15)}${esc(formatAddress(partsFromNominatim(r)))}</button>`)
      .join('');
    results.querySelectorAll('[data-address]').forEach(
      (b) =>
        (b.onclick = () => {
          const r = found[Number(b.dataset.address)];
          const lat = Number(r.lat);
          const lng = Number(r.lon);
          if (!isInsideConchali(lat, lng)) return showError(OUTSIDE_MESSAGE);
          draft.addressEdited = false; // eligió una dirección: se usa la del resultado
          setPoint(lat, lng, formatAddress(partsFromNominatim(r)));
          map.setView([lat, lng], 17);
          results.innerHTML = '';
          status.textContent = 'Dirección seleccionada. Puedes ajustar el punto en el mapa.';
        }),
    );
  } catch {
    status.textContent = 'La búsqueda no está disponible. Marca el punto en el mapa o escribe la dirección.';
  } finally {
    button.disabled = false;
  }
}

function initMap() {
  if (map) map.remove();
  marker = null;
  map = L.map('visit-map', { scrollWheelZoom: false, zoomSnap: 0.25 }).setView(CENTER, 14);
  map.fitBounds(BOUNDS, { padding: [10, 10] });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  L.geoJSON(BOUNDARY, { style: { color: '#fd6a02', weight: 2.5, fillOpacity: 0.03 }, interactive: false }).addTo(map);
  if (draft.location) setPoint(draft.location.lat, draft.location.lng);
  map.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng));
  $('#clear-point').onclick = () => {
    draft.location = null;
    marker?.remove();
    marker = null;
    $('#point-status').firstChild.textContent = 'Sin punto marcado. ';
    $('#clear-point').hidden = true;
    $('#use-map-address').hidden = true;
  };
  $('#use-map-address').onclick = () => applyMapAddress(draft.mapAddress, true);
  $('#address-search button').onclick = onAddressSearch;
  $('#address-query').onkeydown = (e) => {
    if (e.key === 'Enter') onAddressSearch(e);
  };
  setTimeout(() => map?.invalidateSize(), 60);
}

function showError(message) {
  const el = $('#visit-error');
  el.hidden = false;
  el.textContent = message;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

async function submit(e) {
  e.preventDefault();
  const error = validateVisit(draft);
  if (error) return showError(error);
  const btn = $('#visit-form button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    await api.team.createVisit(code, draft);
    const saved = draft;
    draft = emptyDraft(); // conserva «Registrado por» para la siguiente
    renderDone(saved);
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = `Guardar visita ${icon('check', 18)}`;
    if (err.status === 401) {
      code = '';
      saveCode('');
      return renderCode('El código del equipo cambió o no es válido. Ingrésalo nuevamente; los datos del formulario se conservan.');
    }
    showError(err.status && err.status < 500 ? err.message : 'No se pudo guardar. Revisa tu conexión e inténtalo otra vez.');
  }
}

function renderDone(v) {
  shell(`<section class="admin-card team-done"><span class="success-check">${icon('check', 44)}</span><h1>Visita registrada</h1><p class="muted">${esc(v.firstName)} ${esc(v.lastNames)} · ${esc(v.role)} · ${esc(v.visitDate.split('-').reverse().join('-'))}</p><button class="button orange full" id="another">Registrar otra visita ${icon('plus', 18)}</button></section>`);
  $('#another').onclick = renderForm;
  toast('Visita guardada.');
}

// ---------- Inicio ----------
if (code) renderForm();
else renderCode();
