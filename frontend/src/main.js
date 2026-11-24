// AFM · Aquí falta la muni — mapa ciudadano de Conchalí.
// Reconstrucción de la versión publicada en Netlify, ahora conectada a la API en AWS.
import L from 'leaflet';
import 'leaflet.markercluster';
import './styles.css';

import { BOUNDARY } from '../../shared/boundary.js';
import { CATEGORIES } from '../../shared/categories.js';
import { BOUNDS, CENTER, OUTSIDE_MESSAGE, isInsideConchali } from '../../shared/geo.js';
import {
  FLAG_REASONS, INPUT_TYPES, MAX_ORIGINAL_BYTES, RELATIONS, SECTORS, TERMS_VERSION, categoryById, validateStep,
} from '../../shared/rules.js';
import {
  DEMO_REPORTS, LEGAL, LEGAL_HEADINGS, LEGAL_TITLES, PRIVACY_EXTRA, SERVICE_NOTICE,
} from './content.js';
import * as api from './lib/api.js';
import { formatAddress, partsFromNominatim, reverseGeocode, searchAddress } from './lib/address.js';
import { $, $$, brand, esc, fold, formatDate, toast } from './lib/dom.js';
import { icon, roadSign } from './lib/icons.js';
import * as mine from './lib/my-reports.js';
import { reducePhoto } from './lib/photos.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// ---------- Estado ----------
let cases = []; // casos públicos del servidor (cada caso agrupa los reportes de uno o más vecinos)
let visibleCategories = new Set(CATEGORIES.map((c) => c.id));
let searchText = '';
let showExamples = false;
let mainMap;
let clusterLayer;
let wizardMap;
let wizardMarker;
let draft = null; // borrador del asistente
let step = 0;
let view = 'map';
let busy = false; // evita dobles envíos
let lastFocus;
let reverseTimer;

// ---------- Estructura de la página ----------
$('#app').innerHTML = `
  <div class="topline"><span>${icon('map-pin', 13)} CONCHALÍ, SANTIAGO</span><span>UN MAPA HECHO ENTRE VECINOS ${icon('heart', 12)}</span></div>
  <header class="header">
    <button class="brand-button" data-nav="map" aria-label="AFM, ir al mapa">${brand()}</button>
    <nav class="desktop-nav" aria-label="Navegación principal">
      <button class="nav-link active" data-nav="map">${icon('map', 17)} Mapa ciudadano</button>
      <button class="nav-link" data-nav="reports">Mis reportes <span id="my-count">0</span></button>
      <button class="nav-link" data-info="about">¿Qué es AFM?</button>
    </nav>
    <div class="header-actions"><button class="button orange small" data-new>${icon('plus', 17)} HACER UN REPORTE</button><button class="icon-button menu-button" data-menu aria-label="Abrir menú">${icon('menu', 24)}</button></div>
  </header>
  <main id="main-content">
    <section class="map-view" id="map-view">
      <section class="hero">
        <div class="hero-copy"><div class="eyebrow"><span class="live-dot"></span> NUESTRA COMUNA. NUESTRA VOZ.</div><h1>Lo que vemos.<br><span>Lo que falta.</span></h1><p>Tu mirada ayuda a hacer visibles los problemas<br class="desktop-break"> que vivimos todos los días en Conchalí.</p><button class="button orange" data-new>${icon('plus', 17)} HACER UN REPORTE</button></div>
        <div class="hero-art"><div class="art-ring ring-one"></div><div class="art-ring ring-two"></div><img class="hero-logo" src="/afm-logo.jpg" alt="AFM — Aquí falta la muni"><span class="art-cross cross-one" aria-hidden="true">+</span><span class="art-cross cross-two" aria-hidden="true">+</span><span class="art-coordinate">33°23′ S &nbsp; 70°40′ O</span></div>
        <div class="hero-community"><span class="community-number" id="citizen-count">0</span><strong class="counter-label">REPORTES<br>CIUDADANOS</strong><div class="community-line"></div><span class="community-note">Cada reporte suma una mirada.<br><span id="counter-note">Publicados en el mapa de AFM.</span></span></div>
      </section>
      <div class="hazard-line"></div>
      <section class="map-intro"><div><span class="eyebrow">NUESTROS BARRIOS, NUESTRAS PRIORIDADES</span><h2>Cada barrio ve una parte de la comuna</h2><p>Marca lo que pasa cerca tuyo. Entre todos hacemos visible lo que falta en Conchalí.</p></div><a href="#map-section">MAPA CIUDADANO ${icon('arrow-right', 19)}</a></section>
      <section id="map-section" class="workspace">
        <aside class="sidebar">
          <div class="sidebar-heading"><div><span class="eyebrow muted">EL BARRIO, EN EL MAPA</span><h2>¿Qué está pasando?</h2></div>${icon('arrow-up-right', 25)}</div>
          <label class="search-field">${icon('search', 18)}<input id="report-search" placeholder="Buscar por problema" aria-label="Buscar reportes por problema o categoría"><kbd>/</kbd></label>
          <div class="filter-heading"><span>Filtrar por categoría</span><button id="clear-filter">Limpiar búsqueda</button></div>
          <div class="filter-actions"><button id="show-all">Mostrar todas</button><button id="hide-all">Ocultar todas</button></div>
          <div id="category-filters" class="category-filters"></div>
          <div class="sidebar-bottom"><span class="mini-sign">${icon('hard-hat', 23)}</span><div><strong>Tu mirada hace la diferencia.</strong><p>Si lo ves, ponlo en el mapa.</p></div></div>
          <button class="button orange full" data-new>${icon('plus', 17)} HACER UN REPORTE</button>
        </aside>
        <div class="map-panel">
          <div class="map-toolbar"><div><span class="live-dot"></span><strong>MAPA CIUDADANO</strong><span class="toolbar-location"> / Conchalí</span></div><button class="map-layer" id="toggle-examples" aria-pressed="false">${icon('layers', 16)} Ver ejemplos <span class="toggle-dot"></span></button></div>
          <div class="map-canvas-wrap"><div id="map" aria-label="Mapa de reportes de Conchalí"></div><div class="map-summary">${icon('map-pin', 17)} <strong id="visible-count">0</strong> <span id="visible-label">reportes</span></div><button class="locate-map icon-button" id="locate-main" aria-label="Centrar mapa en mi ubicación">${icon('locate', 21)}</button><button class="mobile-filter button black small" id="mobile-filter">${icon('filter', 17)} Filtros</button><div class="map-empty" id="map-empty" hidden>No hay reportes con estos filtros.<button class="text-button" id="reset-search">Ver todos</button></div><div class="map-load-error" id="map-load-error" hidden>No se pudo cargar el mapa base. Revisa tu conexión a internet.</div></div>
          <div class="map-caption"><span><i class="legend-square"></i> Reporte por categoría <i class="legend-cluster"></i> Reportes agrupados</span><span id="map-mode-note"></span></div>
        </div>
      </section>
      <section class="recent-section"><div class="section-title"><div><span class="eyebrow muted">CADA PUNTO TIENE UNA HISTORIA</span><h2>REPORTES RECIENTES</h2></div><span class="outline-pill">ÚLTIMOS INGRESADOS</span></div><div id="recent-reports" class="recent-grid"></div></section>
      <section class="participate"><div class="participate-icon">${icon('map-pin', 34)}</div><div><h2>Que lo que falta, se vea.</h2><p>Una foto, una ubicación y tu voz. Reportar toma solo unos minutos.</p></div><button class="button orange" data-new>${icon('plus', 17)} HACER UN REPORTE</button></section>
    </section>
    <section id="reports-view" class="page-view" hidden></section>
  </main>
  <footer class="footer"><div>${brand()}<span class="footer-place">CONCHALÍ<br><small>NUESTRA COMUNA, NUESTRA VOZ</small></span></div><p>Una herramienta ciudadana para mirar nuestro barrio.<br><span>Herramienta ciudadana independiente. Sin envío a la municipalidad.</span></p><button class="text-button" data-info="privacy">Términos y privacidad ${icon('arrow-up-right', 15)}</button></footer>
  <nav class="bottom-nav" aria-label="Navegación móvil"><button class="active" data-nav="map">${icon('map', 21)}Mapa</button><button data-nav="reports">${icon('reports', 21)}Mis reportes</button><button data-info="about">${icon('info', 21)}Información</button><button data-info="profile">${icon('user', 21)}Perfil</button></nav>
  <dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;

const dialog = $('#dialog');

// ---------- Diálogos ----------
function openDialog(html, className = '') {
  clearTimeout(reverseTimer);
  if (!dialog.open) lastFocus = document.activeElement;
  if (wizardMap) {
    wizardMap.remove();
    wizardMap = null;
  }
  dialog.className = className;
  dialog.innerHTML = html;
  if (!dialog.open) {
    dialog.showModal();
    document.body.classList.add('modal-open');
  }
  dialog.scrollTop = 0;
  $('[data-close]', dialog)?.addEventListener('click', closeDialog);
}

function closeDialog() {
  if (busy) return;
  if (wizardMap) {
    wizardMap.remove();
    wizardMap = null;
  }
  dialog.close();
  document.body.classList.remove('modal-open');
  lastFocus?.focus({ preventScroll: true });
}

dialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  if (draft && dialog.classList.contains('wizard')) confirmExit();
  else closeDialog();
});

const dialogHeader = (title, eyebrow = '') =>
  `<div class="dialog-header"><div>${eyebrow ? `<span class="eyebrow muted">${eyebrow}</span>` : ''}<h2 id="dialog-title">${title}</h2></div><button class="icon-button" data-close aria-label="Cerrar">${icon('x', 23)}</button></div>`;

// ---------- Datos visibles ----------
const allReports = () => [...cases, ...(showExamples ? DEMO_REPORTS : [])];
/** Reportes de los vecinos dentro de un caso (los ejemplos tienen uno solo). */
const caseReports = (c) =>
  c.reports || [{ id: c.id, description: c.description, createdAt: c.createdAt, photos: c.photos || [] }];
const caseCount = (c) => c.reportCount || 1;
const totalReports = () => cases.reduce((n, c) => n + caseCount(c), 0);
const findCase = (reportId) => cases.find((c) => caseReports(c).some((r) => r.id === reportId));

async function reloadCases() {
  cases = await api.listReports();
  refresh();
  if (view === 'reports') renderMyReports();
}

function filteredReports() {
  const q = fold(searchText);
  return allReports().filter(
    (r) =>
      visibleCategories.has(r.category) &&
      fold(`${r.detail} ${categoryById(r.category).name}`).includes(q),
  );
}

const recentReports = () => cases.slice(0, 6); // la API los entrega del más reciente al más antiguo

function renderFilters() {
  const focused = document.activeElement?.dataset.category;
  $('#category-filters').innerHTML = CATEGORIES.map(
    (c) =>
      `<label class="filter-item ${visibleCategories.has(c.id) ? 'selected' : ''}"><input type="checkbox" data-category="${c.id}" ${visibleCategories.has(c.id) ? 'checked' : ''}><span class="filter-icon">${icon(c.icon, 18)}</span><span>${c.name}</span><span class="filter-count">${allReports().filter((r) => r.category === c.id).length}</span></label>`,
  ).join('');
  if (focused) $(`[data-category="${focused}"]`)?.focus({ preventScroll: true });
}

// ---------- Mapa principal ----------
function boundaryLayer(fillOpacity) {
  return L.geoJSON(BOUNDARY, {
    style: { color: '#fd6a02', weight: 2.5, fillColor: '#fd6a02', fillOpacity },
    interactive: false,
    attribution: 'Límite: SUBDERE / DPA 2023',
  });
}

function initMainMap() {
  mainMap = L.map('map', { zoomControl: false, scrollWheelZoom: false, zoomSnap: 0.25 }).setView(CENTER, 14);
  const tiles = L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(mainMap);
  tiles.on('tileerror', () => ($('#map-load-error').hidden = false));
  tiles.on('tileload', () => ($('#map-load-error').hidden = true));
  L.control.zoom({ position: 'bottomright' }).addTo(mainMap);
  boundaryLayer(0.025).addTo(mainMap);
  clusterLayer = L.markerClusterGroup({
    maxClusterRadius: 42,
    showCoverageOnHover: false,
    iconCreateFunction: (cluster) =>
      L.divIcon({ className: 'cluster-icon', html: `<span>${cluster.getChildCount()}</span>`, iconSize: [42, 42] }),
  }).addTo(mainMap);
  refresh();
  // Tocar un lugar vacío del mapa abre «Nuevo reporte» con ese punto ya marcado.
  // Si el toque solo cerró una vista previa abierta, no se abre el formulario.
  let popupClosedAt = 0;
  mainMap.on('popupclose', () => (popupClosedAt = Date.now()));
  mainMap.on('click', (e) => {
    if (Date.now() - popupClosedAt < 400) return;
    const { lat, lng } = e.latlng;
    if (!isInsideConchali(lat, lng)) return toast(OUTSIDE_MESSAGE);
    startWizard('', { lat, lng });
  });
  requestAnimationFrame(() => {
    mainMap.invalidateSize();
    mainMap.fitBounds(BOUNDS, { padding: [25, 25] });
  });
  new ResizeObserver(() => mainMap.invalidateSize()).observe($('#map'));
}

/** Vuelve a dibujar marcadores, contadores, filtros y reportes recientes. */
function refresh() {
  if (!clusterLayer) return;
  clusterLayer.clearLayers();
  const visible = filteredReports();
  for (const r of visible) {
    const marker = L.marker([r.lat, r.lng], {
      icon: L.divIcon({
        className: 'report-marker',
        html: roadSign(categoryById(r.category).icon, r.demo ? '' : 'local-sign'),
        iconSize: [42, 42],
        iconAnchor: [21, 21],
      }),
      title: `${r.detail} · ${r.demo ? 'Ejemplo' : 'Reporte ciudadano'}`,
      alt: r.detail,
    });
    marker.bindPopup(previewHtml(r), { className: 'report-popup', minWidth: 235, maxWidth: 280, autoPanPadding: [20, 65] });
    clusterLayer.addLayer(marker);
  }
  const demoCount = visible.filter((r) => r.demo).length;
  $('#visible-count').textContent = visible.length;
  $('#visible-label').textContent =
    demoCount === visible.length && demoCount
      ? 'reportes de ejemplo'
      : `reportes${demoCount ? ` · ${demoCount} de ejemplo` : ''}`;
  $('#map-empty').hidden = visible.length !== 0;
  $('#my-count').textContent = mine.myReports().length;
  $('#citizen-count').textContent = totalReports().toLocaleString('es-CL');
  $('#map-mode-note').innerHTML = `${icon('info', 14)} ${showExamples ? 'Ejemplos activados · No son reclamos reales' : 'Toca el mapa para reportar en ese lugar'}`;
  renderFilters();
  renderRecent();
}

/** Primera foto disponible del caso. */
const photoUrl = (c) => caseReports(c).flatMap((r) => r.photos || [])[0]?.url;
const neighborsLine = (c) =>
  caseCount(c) > 1 ? `<p class="case-count">${icon('user', 14)} ${caseCount(c)} vecinos lo reportaron</p>` : '';

function previewHtml(r) {
  const cat = categoryById(r.category);
  return `<article class="report-preview"><span class="preview-category">${icon(cat.icon, 15)} ${esc(cat.name)}</span><h3>${esc(r.detail)}</h3>${photoUrl(r) ? `<img src="${esc(photoUrl(r))}" alt="Fotografía del problema reportado">` : `<div class="preview-no-photo">${icon('camera', 26)} Ejemplo sin fotografía</div>`}${neighborsLine(r)}${r.demo ? '<span class="preview-demo">REPORTE DE EJEMPLO</span>' : ''}<button class="preview-open" data-report="${esc(r.id)}">VER REPORTE ${icon('arrow-right', 17)}</button></article>`;
}

function cardHtml(r) {
  const cat = categoryById(r.category);
  return `<button class="report-card" data-report="${esc(r.id)}">${roadSign(cat.icon)}<span class="report-card-body"><span class="report-card-meta">${esc(cat.name)}<span>${r.demo ? 'EJEMPLO' : caseCount(r) > 1 ? `${caseCount(r)} VECINOS` : 'CIUDADANO'}</span></span><strong>${esc(r.detail)}</strong></span>${photoUrl(r) ? `<img class="report-thumbnail" src="${esc(photoUrl(r))}" alt="Fotografía del problema" loading="lazy">` : icon('arrow-up-right', 19)}</button>`;
}

function renderRecent() {
  $('#recent-reports').innerHTML =
    recentReports().map(cardHtml).join('') ||
    `<div class="recent-empty">${icon('map-pin', 28)}<div><strong>Aún no hay reportes ingresados.</strong><p>Lo que pasa en tu barrio puede ser el primer punto en el mapa.</p></div><button class="button orange small" data-new>${icon('plus', 17)} HACER UN REPORTE</button></div>`;
}

// ---------- Vistas ----------
function showView(name) {
  view = name;
  $('#map-view').hidden = name !== 'map';
  $('#reports-view').hidden = name !== 'reports';
  $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  if (name === 'reports') renderMyReports();
  else setTimeout(() => mainMap.invalidateSize(), 30);
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderMyReports() {
  const entries = mine.myReports().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const items = entries.map((entry) => {
    const c = findCase(entry.id);
    if (c)
      return `<div class="my-report">${cardHtml(c)}<div class="my-report-footer"><span>${esc(entry.id)} · ${formatDate(entry.createdAt)}</span><span class="status-pill">${icon('check', 13)} Publicado</span></div></div>`;
    return `<div class="my-report"><div class="report-card" aria-disabled="true">${roadSign('circle-alert')}<span class="report-card-body"><strong>Reporte no disponible</strong><span class="report-address">Fue eliminado por moderación o ya no existe.</span></span></div><div class="my-report-footer"><span>${esc(entry.id)} · ${formatDate(entry.createdAt)}</span><button class="text-button" data-forget="${esc(entry.id)}">Quitar de la lista</button></div></div>`;
  });
  $('#reports-view').innerHTML =
    `<div class="section-title"><div><span class="eyebrow muted">TU APORTE A CONCHALÍ</span><h1>Mis reportes<span class="orange-text">.</span></h1><p class="muted">Los reportes que hiciste desde este navegador.</p></div><button class="button orange" data-new>${icon('plus', 17)} HACER UN REPORTE</button></div><div class="local-notice">${icon('info', 19)} Este navegador recuerda tus reportes para que puedas consultarlos o eliminarlos. Tus datos de contacto no son públicos y no se envían a la municipalidad.</div>${
      items.length
        ? `<div class="my-reports-list">${items.join('')}</div>`
        : `<div class="empty-state"><span class="empty-icon">${icon('reports', 42)}</span><h2>Tu primer reporte empieza aquí.</h2><p>Ayúdanos a ver lo que falta en tu barrio.<br>Los reportes que crees aparecerán en este espacio.</p><button class="button orange" data-new>${icon('plus', 17)} HACER UN REPORTE</button></div>`
    }`;
  $$('[data-forget]').forEach(
    (b) =>
      (b.onclick = () => {
        mine.forget(b.dataset.forget);
        refresh();
        renderMyReports();
      }),
  );
}

// ---------- Detalle de un reporte ----------
function reportBlock(c, r, many) {
  const own = !c.demo && mine.isMine(r.id);
  return `<section class="case-report">${many && own ? `<p class="muted case-report-date">${icon('user', 14)} <strong>Tu reporte</strong></p>` : ''}<div class="report-photos">${(r.photos || []).map((p, i) => `<img src="${esc(p.url)}" alt="Fotografía ${i + 1} del problema reportado">`).join('')}</div>${c.demo ? '' : `<div class="case-report-actions"><button class="text-button content-flag-button" data-flag="${esc(r.id)}">&#9873; Reportar contenido</button>${own ? `<button class="text-button danger" data-delete-own="${esc(r.id)}">Eliminar mi reporte</button>` : ''}</div>`}</section>`;
}

function openReport(c) {
  const cat = categoryById(c.category);
  const list = caseReports(c);
  const many = list.length > 1;
  openDialog(
    `${dialogHeader(c.demo ? 'Reporte de ejemplo' : 'Detalle del reporte')}<div class="dialog-body report-detail"><div class="report-detail-title">${roadSign(cat.icon)}<div><span class="muted">${esc(cat.name)}</span><h3>${esc(c.detail)}</h3></div></div>${many ? `<p class="case-count">${icon('user', 16)} <strong>${list.length} vecinos</strong> reportaron este problema</p>` : ''}${list.filter((r) => (r.photos || []).length || mine.isMine(r.id)).map((r) => reportBlock(c, r, many)).join('')}<div class="local-notice">${icon('info', 20)} ${c.demo ? 'Datos ficticios para mostrar cómo funciona AFM. No es un reclamo real.' : 'Reporte ciudadano publicado en AFM. No se ha enviado a la municipalidad.'}</div><div class="detail-actions"><button class="button orange" id="see-location">${icon('map', 17)} Ver ubicación</button></div></div>`,
    'light-dialog',
  );
  $$('[data-flag]', dialog).forEach((b) => (b.onclick = () => openFlagForm(c, b.dataset.flag)));
  $$('[data-delete-own]', dialog).forEach((b) => (b.onclick = () => confirmDelete(c, b.dataset.deleteOwn)));
  $('#see-location').onclick = () => {
    closeDialog();
    showView('map');
    if (!filteredReports().some((x) => x.id === c.id)) {
      visibleCategories.add(c.category);
      searchText = '';
      $('#report-search').value = '';
      refresh();
    }
    mainMap.setView([c.lat, c.lng], 17);
    $('#map-section').scrollIntoView({ behavior: 'smooth' });
  };
}

function confirmDelete(c, reportId) {
  openDialog(
    `${dialogHeader('¿Eliminar tu reporte?')}<div class="dialog-body"><p>Se eliminarán del mapa tu reporte, sus fotos y tus datos de contacto. Esta acción no se puede deshacer.</p><div class="detail-actions"><button class="button outline" id="keep-report">Conservar</button><button class="button orange" id="confirm-delete">Eliminar reporte</button></div></div>`,
    'light-dialog',
  );
  $('#keep-report').onclick = () => openReport(c);
  $('#confirm-delete').onclick = async () => {
    const btn = $('#confirm-delete');
    btn.disabled = true;
    try {
      await api.deleteOwnReport(reportId, mine.tokenFor(reportId));
      mine.forget(reportId);
      closeDialog();
      await reloadCases().catch(() => {
        cases = cases
          .map((x) => ({ ...x, reports: caseReports(x).filter((r) => r.id !== reportId) }))
          .filter((x) => x.reports.length);
        refresh();
      });
      if (view === 'reports') renderMyReports();
      toast('Reporte eliminado.');
    } catch {
      btn.disabled = false;
      toast('No se pudo eliminar el reporte. Inténtalo otra vez.');
    }
  };
}

// ---------- Textos informativos ----------
function legalBody(key) {
  if (key === 'faq') {
    const lines = LEGAL.faq;
    return `<div class="faq-list">${lines.reduce((html, line, i) => (/^\d+\. /.test(line) ? html + `<details><summary>${esc(line.replace(/^\d+\. /, ''))}</summary><p>${esc(lines[i + 1])}</p></details>` : html), '')}</div>`;
  }
  const lines =
    key === 'rules'
      ? LEGAL.privacy.slice(LEGAL.privacy.indexOf('Normas de uso'), LEGAL.privacy.indexOf('Aceptación'))
      : LEGAL[key] || [];
  return lines
    .filter((line) => line !== 'Ver mis reportes →')
    .map((line) =>
      line === 'contacto@afmconchali.cl'
        ? `<p><a class="contact-email" href="mailto:contacto@afmconchali.cl">${line}</a></p>`
        : LEGAL_HEADINGS.has(line) || /^\d+\. /.test(line)
          ? `<h3${line === 'Normas de uso' ? ' id="usage-rules"' : ''}>${esc(line)}</h3>`
          : `<p>${esc(line)}</p>`,
    )
    .join('');
}

function legalContent(key) {
  if (!(key in LEGAL_TITLES)) key = 'about';
  let body = legalBody(key);
  if (key === 'about') body = `<div class="info-brand">${brand()}</div>` + body;
  if (key === 'categories')
    body = `<div class="info-categories">${CATEGORIES.map((c) => `<div>${icon(c.icon, 24)}<section><h3>${c.name}</h3><ul>${c.details.map((d) => `<li>${d}</li>`).join('')}</ul></section></div>`).join('')}</div><button class="button orange full" data-new>HACER UN REPORTE ${icon('arrow-right', 18)}</button>`;
  if (key === 'profile')
    body += `<button class="button orange full" id="profile-reports">Ver mis reportes ${icon('arrow-right', 18)}</button>`;
  if (key !== 'categories' && key !== 'contact')
    body += `<aside class="local-notice">${icon('info', 18)}<span>${SERVICE_NOTICE}${key === 'privacy' ? PRIVACY_EXTRA : ''}</span></aside>`;
  return [LEGAL_TITLES[key], body];
}

function openInfo(key) {
  const [title, body] = legalContent(key);
  openDialog(`${dialogHeader(title)}<div class="dialog-body prose">${body}</div>`, 'light-dialog');
  if (key === 'profile')
    $('#profile-reports').onclick = () => {
      closeDialog();
      showView('reports');
    };
}

/** Términos abiertos desde el asistente: un segundo diálogo encima, sin perder el borrador. */
function openLegalOverlay(key) {
  const [title, body] = legalContent(key);
  const overlay = document.createElement('dialog');
  overlay.className = 'legal-dialog';
  overlay.setAttribute('aria-labelledby', 'legal-title');
  overlay.innerHTML = `<div class="dialog-header"><h2 id="legal-title">${title}</h2><button class="icon-button" aria-label="Volver al reporte" id="close-legal">${icon('x', 22)}</button></div><div class="dialog-body prose">${body}<button class="button orange full" id="return-to-report">Volver al reporte ${icon('arrow-right', 18)}</button></div>`;
  document.body.append(overlay);
  overlay.addEventListener('close', () => overlay.remove(), { once: true });
  $('#close-legal', overlay).onclick = () => overlay.close();
  $('#return-to-report', overlay).onclick = () => overlay.close();
  overlay.showModal();
}

// ---------- Denunciar contenido ----------
function openFlagForm(c, reportId) {
  openDialog(
    `${dialogHeader('Reportar contenido', esc(reportId))}<form class="dialog-body" id="content-flag-form"><p>Indica por qué consideras que este reporte incumple las normas de uso de AFM.</p><fieldset class="flag-reasons"><legend>Motivo del aviso</legend>${FLAG_REASONS.map((reason, i) => `<label class="radio-option"><input type="radio" name="flag-reason" value="${i}" required><span>${reason}</span></label>`).join('')}</fieldset><label class="field-label" for="flag-note">Información adicional <span>(opcional)</span></label><textarea class="dark-input" id="flag-note" maxlength="500" rows="3" placeholder="Cuéntanos qué debemos revisar…"></textarea><div class="local-notice">${icon('info', 18)} Tu aviso llegará al equipo de moderación de AFM.</div><p class="form-error" id="flag-error" role="alert" hidden></p><div class="detail-actions"><button class="button outline" id="cancel-flag" type="button">Volver al reporte</button><button class="button orange" type="submit">Enviar aviso ${icon('check', 18)}</button></div></form>`,
    'light-dialog',
  );
  $('#cancel-flag').onclick = () => openReport(c);
  $('#content-flag-form').onsubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    const choice = $('input[name="flag-reason"]:checked');
    if (!choice || !FLAG_REASONS[Number(choice.value)]) return;
    const reason = FLAG_REASONS[Number(choice.value)];
    const submit = $('#content-flag-form button[type="submit"]');
    busy = true;
    submit.disabled = true;
    try {
      await api.flagReport(reportId, { reason, note: $('#flag-note').value.trim().slice(0, 500) });
      busy = false;
      openDialog(
        `${dialogHeader('Aviso enviado')}<div class="dialog-body"><p>Motivo: <strong>${esc(reason)}</strong></p><p>El aviso sobre el reporte <strong>${esc(reportId)}</strong> fue enviado al equipo de moderación de AFM.</p><button class="button orange full" id="flag-done">Volver al reporte ${icon('arrow-right', 18)}</button></div>`,
        'light-dialog',
      );
      $('#flag-done').onclick = () => openReport(c);
    } catch {
      busy = false;
      submit.disabled = false;
      $('#flag-error').hidden = false;
      $('#flag-error').textContent = 'No pudimos enviar el aviso. Inténtalo nuevamente.';
    }
  };
}

// ---------- Menú móvil ----------
function openMenu() {
  const items = [
    ['map', 'Inicio / Mapa', 'nav:map'],
    ['reports', 'Mis reportes', 'nav:reports'],
    ['info', '¿Qué es AFM?', 'about'],
    ['layers', 'Categorías y ejemplos', 'categories'],
    ['circle-alert', 'Preguntas frecuentes', 'faq'],
    ['lock', 'Términos y privacidad', 'privacy'],
    ['mail', 'Contacto', 'contact'],
  ];
  openDialog(
    `<div class="dialog-header">${brand()}<h2 id="dialog-title" class="sr-only">Menú principal</h2><button class="icon-button" data-close aria-label="Cerrar menú">${icon('x', 24)}</button></div><div class="menu-list">${items.map(([ic, label, action]) => `<button data-menu-action="${action}">${icon(ic, 21)}${label}${icon('chevron-right', 17)}</button>`).join('')}</div><div class="menu-footer">CONCHALÍ<span>NUESTRA COMUNA, NUESTRA VOZ</span></div>`,
    'menu-dialog',
  );
  $$('[data-menu-action]', dialog).forEach(
    (b) =>
      (b.onclick = () => {
        const action = b.dataset.menuAction;
        if (action.startsWith('nav:')) {
          closeDialog();
          showView(action.slice(4));
        } else openInfo(action);
      }),
  );
}

// ---------- Asistente para crear un reporte ----------
function startWizard(category = '', location = null) {
  draft = {
    category,
    detail: '',
    location,
    addressParts: { street: '', number: '', neighborhood: '' },
    addressEdited: false,
    description: '',
    photos: [], // [{ name, file, url }]
    firstName: '',
    lastName: '',
    phone: '',
    relation: '',
    sector: '',
    consent: false,
  };
  step = 0;
  renderWizard();
  if (location) prefillAddress(draft);
}

/** Con el punto ya marcado desde el mapa, busca su dirección para el paso 3 (sin pisar lo que se escriba). */
async function prefillAddress(d) {
  try {
    const parts = partsFromNominatim(await reverseGeocode(d.location.lat, d.location.lng));
    if (draft !== d || d.addressEdited || d.addressParts.street) return;
    d.addressParts = parts;
    if (step === 2 && wizardMap) {
      $$('[data-address-part]', dialog).forEach((input) => (input.value = parts[input.dataset.addressPart] || ''));
      $('#selected-point').textContent = formatAddress(parts);
    }
  } catch {
    /* sin dirección: el vecino puede escribirla en el paso 3 */
  }
}

function discardDraft() {
  draft?.photos.forEach((p) => URL.revokeObjectURL(p.url));
  draft = null;
}

function confirmExit() {
  if (busy) return;
  openDialog(
    `${dialogHeader('¿Salir del reporte?')}<div class="dialog-body"><p>Los datos de este reporte todavía no están guardados.</p><div class="detail-actions"><button class="button outline" id="continue-draft">Seguir editando</button><button class="button orange" id="discard-draft">Descartar</button></div></div>`,
    'light-dialog',
  );
  $('#continue-draft').onclick = renderWizard;
  $('#discard-draft').onclick = () => {
    discardDraft();
    closeDialog();
  };
}

const textField = (field, label, placeholder, autocomplete) =>
  `<div><label class="field-label" for="${field}">${label} <span class="required">*</span></label><input id="${field}" data-field="${field}" class="dark-input" maxlength="80" autocomplete="${autocomplete}" placeholder="${placeholder}" value="${esc(draft[field])}"></div>`;

const selectField = (field, label, options) =>
  `<label class="field-label" for="${field}">${label} <span class="required">*</span></label><select id="${field}" data-field="${field}" class="dark-input"><option value="">Selecciona una opción</option>${options.map((o) => `<option ${draft[field] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;

function stepHtml() {
  const cat = categoryById(draft.category);
  if (step === 0)
    return `<span class="eyebrow">PASO 01 / 05</span><h3>¿Qué problema quieres reportar?</h3><p class="step-subtitle">Selecciona la categoría que mejor representa el problema que quieres mostrar.</p><div class="category-grid">${CATEGORIES.map((c) => `<button class="category-tile ${draft.category === c.id ? 'chosen' : ''}" data-pick="${c.id}" aria-pressed="${draft.category === c.id}">${roadSign(c.icon)}<span>${c.name}</span>${draft.category === c.id ? `<span class="selected-check">${icon('check', 13)}</span>` : ''}</button>`).join('')}</div>`;
  if (step === 1)
    return `<span class="eyebrow">PASO 02 / 05</span><h3>Cuéntanos un poco más.</h3><p class="step-subtitle">Elige el detalle que mejor describe el problema.</p><div class="selected-category">${icon(cat.icon, 24)}${cat.name}</div>${draft.category === 'seguridad' ? '<p class="step-subtitle">Este formulario registra problemas del espacio público. No es un canal de atención de emergencias.</p>' : ''}<div class="detail-options">${cat.details.map((d) => `<label class="radio-option"><input type="radio" name="detail" value="${esc(d)}" ${draft.detail === d ? 'checked' : ''}><span>${d}</span></label>`).join('')}</div>`;
  if (step === 2)
    return `<span class="eyebrow">PASO 03 / 05</span><h3>¿Dónde ocurre?</h3><p class="step-subtitle">Toca el mapa o busca una dirección en Conchalí.</p>
    <form id="address-search" class="address-search"><label class="sr-only" for="address-query">Buscar dirección en Conchalí</label>${icon('search', 19)}<input id="address-query" placeholder="Ej. Av. Independencia 5775" autocomplete="off"><button type="submit" aria-label="Buscar dirección">${icon('arrow-right', 20)}</button></form>
    <p id="search-status" class="search-status" role="status"></p><div id="address-results"></div>
    <div class="wizard-map-wrap"><div id="location-map" aria-label="Selecciona la ubicación del problema"></div><button class="icon-button" id="locate-wizard" aria-label="Usar mi ubicación">${icon('locate', 21)}</button><button class="button black small" id="select-map-center">${icon('map-pin', 16)} Usar centro del mapa</button></div>
    <div class="location-selected">${icon('map-pin', 23)}<div><span>Punto seleccionado</span><strong id="selected-point">${draft.location ? esc(formatAddress(draft)) : 'Aún no has marcado una ubicación'}</strong></div></div>
    <p class="field-help" id="reverse-status" role="status">Puedes completar o corregir la dirección sin mover el punto.</p>
    <div class="address-fields"><div><label class="field-label" for="location-street">Calle o avenida</label><input class="dark-input" id="location-street" data-address-part="street" maxlength="120" placeholder="Av. Independencia" value="${esc(draft.addressParts.street)}"></div><div><label class="field-label" for="location-number">Número</label><input class="dark-input" id="location-number" data-address-part="number" maxlength="20" placeholder="5775" value="${esc(draft.addressParts.number)}"></div></div>
    <label class="field-label" for="location-sector">Sector, población o barrio <span>(opcional)</span></label><input class="dark-input" id="location-sector" data-address-part="neighborhood" maxlength="100" placeholder="El Cortijo" value="${esc(draft.addressParts.neighborhood)}">
    <p class="field-help">La línea naranja muestra el límite comunal. Solo se pueden registrar reportes dentro de Conchalí.</p>`;
  if (step === 3)
    return `<span class="eyebrow">PASO 04 / 05</span><h3>Una imagen lo hace visible.</h3><p class="step-subtitle">Agrega 1 o 2 fotos del problema.<br>Las fotos ayudan a mostrar mejor lo que está pasando.</p><p class="field-help photo-help">JPG, PNG, WebP o HEIC. Las fotos se reducen automáticamente antes de enviarse.</p><div class="photo-grid">${[0, 1].map((i) => (draft.photos[i] ? `<div class="photo-preview"><img src="${draft.photos[i].url}" alt="Fotografía ${i + 1} adjunta"><button class="icon-button" data-remove-photo="${i}" aria-label="Eliminar fotografía ${i + 1}">${icon('x', 17)}</button><span>Foto ${i + 1}</span></div>` : `<label class="photo-upload">${icon('camera', 32)}<strong>Agregar foto</strong><span>${i + 1} de 2</span><input type="file" accept="${INPUT_TYPES.join(',')}" aria-label="Agregar fotografía ${i + 1}" data-photo="${i}"></label>`)).join('')}</div><label class="field-label" for="description">¿Qué está pasando? <span class="required">*</span></label><textarea id="description" class="dark-input" rows="4" maxlength="500" placeholder="Describe lo que ocurre y cómo afecta a tu barrio…">${esc(draft.description)}</textarea><span class="char-count"><span id="char-count">${draft.description.length}</span> / 500</span><p class="field-help">Evita incluir datos personales de otras personas en el texto y las fotos.</p>`;
  return `<span class="eyebrow">PASO 05 / 05</span><h3>Tu voz tiene nombre.</h3><p class="step-subtitle">Completa tus datos para acompañar este reporte.</p><div class="field-row">${textField('firstName', 'Nombre', 'Tu nombre', 'given-name')}${textField('lastName', 'Apellido', 'Tu apellido', 'family-name')}</div><label class="field-label" for="phone">WhatsApp <span class="required">*</span></label><div class="phone-input"><span>+56</span><input id="phone" data-field="phone" type="tel" inputmode="tel" maxlength="12" autocomplete="tel-national" placeholder="9 1234 5678" value="${esc(draft.phone)}"></div>${selectField('relation', '¿Cuál es tu relación con Conchalí?', RELATIONS)}${selectField('sector', '¿Qué relación tienes con este sector?', SECTORS)}<div class="consent"><input type="checkbox" id="consent" aria-labelledby="consent-label" ${draft.consent ? 'checked' : ''}><div id="consent-label">Declaro conocer y aceptar los <button type="button" class="inline-link" data-legal="privacy">Términos y privacidad</button> y las <button type="button" class="inline-link" data-legal="rules">normas de uso de AFM</button>, y que este reporte no contiene insultos, amenazas, llamados a la violencia, expresiones de odio ni datos personales innecesarios de terceros.</div></div><div class="wizard-notice">${icon('lock', 18)}<span>Tu nombre, apellido y WhatsApp no se publican: solo los ve el equipo de moderación de AFM. No se envían a la municipalidad.</span></div>`;
}

function renderWizard() {
  const labels = ['Categoría', 'Detalle', 'Ubicación', 'Fotos', 'Datos'];
  openDialog(
    `<div class="wizard-heading"><span>${brand()}</span><h2 id="dialog-title">Nuevo reporte</h2><button class="icon-button" id="close-wizard" aria-label="Cerrar reporte">${icon('x', 23)}</button></div><ol class="stepper" aria-label="Pasos del reporte">${labels.map((label, i) => `<li class="${i === step ? 'current' : i < step ? 'complete' : ''}" ${i === step ? 'aria-current="step"' : ''}><span>${i < step ? icon('check', 14) : i + 1}</span><small>${label}</small></li>`).join('')}</ol><div class="wizard-body">${stepHtml()}<p class="form-error" id="form-error" role="alert" hidden></p></div><div class="wizard-footer"><button class="back-button" id="wizard-back">${icon('arrow-left', 19)} ${step ? 'Volver' : 'Cancelar'}</button><button class="button orange" id="wizard-next">${step === 4 ? 'Enviar reporte' : 'Siguiente'} ${icon(step === 4 ? 'check' : 'arrow-right', 18)}</button></div>`,
    'wizard',
  );
  $('#close-wizard').onclick = confirmExit;
  $('#wizard-back').onclick = () => {
    if (busy) return;
    if (step) {
      step--;
      renderWizard();
    } else confirmExit();
  };
  $('#wizard-next').onclick = async () => {
    if (busy) return;
    const error = validateStep(step, draft);
    if (error) return showFormError(error);
    if (step < 4) {
      step++;
      renderWizard();
    } else await submitReport();
  };
  $$('[data-pick]', dialog).forEach(
    (b) =>
      (b.onclick = () => {
        if (draft.category !== b.dataset.pick) draft.detail = '';
        draft.category = b.dataset.pick;
        renderWizard();
      }),
  );
  $$('input[name="detail"]', dialog).forEach(
    (input) =>
      (input.onchange = () => {
        draft.detail = input.value;
        $('#form-error').hidden = true;
      }),
  );
  $$('[data-field]', dialog).forEach((input) => (input.oninput = () => (draft[input.dataset.field] = input.value)));
  if (step === 2) initWizardMap();
  if (step === 3) {
    $('#description').oninput = (e) => {
      draft.description = e.target.value;
      $('#char-count').textContent = draft.description.length;
    };
    $$('[data-photo]', dialog).forEach((input) => (input.onchange = () => addPhoto(input)));
    $$('[data-remove-photo]', dialog).forEach(
      (b) =>
        (b.onclick = () => {
          const [removed] = draft.photos.splice(Number(b.dataset.removePhoto), 1);
          URL.revokeObjectURL(removed.url);
          renderWizard();
        }),
    );
  }
  if (step === 4) $('#consent').onchange = (e) => (draft.consent = e.target.checked);
  $('.wizard-body', dialog).scrollTop = 0;
}

function showFormError(message) {
  const el = $('#form-error');
  el.hidden = false;
  el.textContent = message;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function initWizardMap() {
  wizardMap = L.map('location-map', {
    zoomControl: true,
    zoomAnimation: false,
    fadeAnimation: false,
    markerZoomAnimation: false,
  }).setView(draft.location ? [draft.location.lat, draft.location.lng] : CENTER, 14);
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(wizardMap);
  boundaryLayer(0.035).addTo(wizardMap);
  wizardMarker = null;
  if (draft.location) setPoint(draft.location.lat, draft.location.lng, draft.addressParts);
  wizardMap.on('click', (e) => setPoint(e.latlng.lat, e.latlng.lng));
  $('#select-map-center').onclick = () => {
    const c = wizardMap.getCenter();
    setPoint(c.lat, c.lng);
  };
  $('#locate-wizard').onclick = () => locate(wizardMap, true);
  $('#address-search').onsubmit = onAddressSearch;
  $$('[data-address-part]', dialog).forEach(
    (input) =>
      (input.oninput = () => {
        draft.addressEdited = true;
        draft.addressParts[input.dataset.addressPart] = input.value;
        if (draft.location) $('#selected-point').textContent = formatAddress(draft.addressParts);
        $('#reverse-status').textContent = 'Dirección ingresada manualmente. El punto seleccionado se conserva.';
      }),
  );
  setTimeout(() => wizardMap?.invalidateSize(), 80);
}

/** Marca el punto del reporte. Si no vienen las partes de la dirección, se buscan en Nominatim. */
function setPoint(lat, lng, parts = null) {
  if (!isInsideConchali(lat, lng)) return showFormError(OUTSIDE_MESSAGE);
  draft.location = { lat, lng };
  draft.addressParts = parts || { street: '', number: '', neighborhood: '' };
  draft.addressEdited = false;
  if (wizardMarker) wizardMarker.setLatLng([lat, lng]);
  else
    wizardMarker = L.marker([lat, lng], {
      draggable: true,
      icon: L.divIcon({ className: 'location-pin', html: icon('map-pin', 38), iconSize: [38, 38], iconAnchor: [19, 36] }),
    })
      .addTo(wizardMap)
      .on('dragend', (e) => {
        const p = e.target.getLatLng();
        if (isInsideConchali(p.lat, p.lng)) setPoint(p.lat, p.lng);
        else {
          e.target.setLatLng([draft.location.lat, draft.location.lng]);
          showFormError(OUTSIDE_MESSAGE);
        }
      });
  $('#selected-point').textContent = formatAddress(draft.addressParts);
  $$('[data-address-part]', dialog).forEach((input) => (input.value = draft.addressParts[input.dataset.addressPart] || ''));
  $('#form-error').hidden = true;
  if (!parts) lookupAddress(lat, lng);
}

function lookupAddress(lat, lng) {
  clearTimeout(reverseTimer);
  const point = draft.location;
  $('#reverse-status').textContent = 'Buscando la dirección del punto…';
  reverseTimer = setTimeout(async () => {
    const stillHere = () => wizardMap && step === 2 && draft?.location === point;
    try {
      const result = await reverseGeocode(lat, lng);
      if (!stillHere() || draft.addressEdited) return;
      draft.addressParts = partsFromNominatim(result);
      $$('[data-address-part]', dialog).forEach((input) => (input.value = draft.addressParts[input.dataset.addressPart] || ''));
      $('#selected-point').textContent = formatAddress(draft.addressParts);
      $('#reverse-status').textContent = 'Dirección aproximada. Revísala y corrígela si es necesario.';
    } catch {
      if (stillHere())
        $('#reverse-status').textContent =
          'No encontramos la dirección. Puedes completarla manualmente; el punto seleccionado se conserva.';
    }
  }, 600);
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
    if (!status.isConnected) return;
    status.textContent = found.length
      ? 'Selecciona una dirección:'
      : 'No encontramos esa dirección. Puedes marcar el lugar directamente en el mapa.';
    results.innerHTML = found
      .map((r, i) => `<button type="button" data-address="${i}">${icon('map-pin', 15)}${esc(formatAddress(partsFromNominatim(r)))}</button>`)
      .join('');
    $$('[data-address]', results).forEach(
      (b) =>
        (b.onclick = () => {
          const r = found[Number(b.dataset.address)];
          const lat = Number(r.lat);
          const lng = Number(r.lon);
          if (!isInsideConchali(lat, lng)) return showFormError(OUTSIDE_MESSAGE);
          setPoint(lat, lng, partsFromNominatim(r));
          wizardMap.setView([lat, lng], 17);
          results.innerHTML = '';
          status.textContent = 'Dirección seleccionada. Puedes ajustar el punto.';
        }),
    );
  } catch {
    if (status.isConnected) status.textContent = 'La búsqueda no está disponible. Marca el punto directamente en el mapa.';
  } finally {
    button.disabled = false;
  }
}

function locate(map, forWizard = false) {
  if (!navigator.geolocation) return toast('Tu navegador no permite obtener la ubicación.');
  toast('Buscando tu ubicación…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (forWizard && (!wizardMap || step !== 2 || !dialog.open)) return;
      const { latitude: lat, longitude: lng } = pos.coords;
      if (!isInsideConchali(lat, lng)) return forWizard ? showFormError(OUTSIDE_MESSAGE) : toast(OUTSIDE_MESSAGE);
      map.setView([lat, lng], 16);
      if (forWizard) setPoint(lat, lng);
      toast('Mapa centrado en tu ubicación.');
    },
    () => toast('No pudimos obtener tu ubicación. Puedes seleccionar el lugar en el mapa.'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
}

async function addPhoto(input) {
  if (busy) return;
  const file = input.files[0];
  if (!file) return;
  if (file.type && !INPUT_TYPES.includes(file.type)) {
    input.value = '';
    return showFormError('Usa una foto JPG, PNG, WebP o HEIC.');
  }
  if (file.size > MAX_ORIGINAL_BYTES) {
    input.value = '';
    return showFormError('La fotografía supera los 15 MB. Elige una más pequeña.');
  }
  busy = true;
  $('#wizard-next').disabled = true;
  try {
    const { blob, url } = await reducePhoto(file);
    draft.photos.push({ name: file.name, file: blob, url });
    busy = false;
    renderWizard();
  } catch {
    busy = false;
    $('#wizard-next').disabled = false;
    input.value = '';
    showFormError('No se pudo leer la fotografía. Intenta con otra imagen.');
  }
}

async function submitReport() {
  for (let i = 0; i < 5; i++) {
    const error = validateStep(i, draft);
    if (error) {
      step = i;
      renderWizard();
      return showFormError(error);
    }
  }
  busy = true;
  const next = $('#wizard-next');
  next.disabled = true;
  $('#wizard-back').disabled = true;
  try {
    const photoKeys = [];
    for (const [i, photo] of draft.photos.entries()) {
      next.textContent = `Subiendo foto ${i + 1} de ${draft.photos.length}…`;
      photoKeys.push(await api.uploadPhoto(photo.file));
    }
    next.textContent = 'Enviando…';
    const contact = {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      phone: draft.phone.replace(/\s/g, ''),
      relation: draft.relation,
      sector: draft.sector,
    };
    const { report, deleteToken } = await api.createReport({
      category: draft.category,
      detail: draft.detail,
      lat: draft.location.lat,
      lng: draft.location.lng,
      addressParts: { ...draft.addressParts },
      description: draft.description.trim(),
      photoKeys,
      contact,
      consent: true,
      termsVersion: TERMS_VERSION,
    });
    mine.remember({ id: report.id, deleteToken, createdAt: report.createdAt });
    const summary = { ...report, category: draft.category, detail: draft.detail, addressParts: { ...draft.addressParts } };
    discardDraft();
    busy = false;
    await reloadCases().catch(() => refresh());
    showSuccess(summary);
  } catch (err) {
    busy = false;
    next.disabled = false;
    $('#wizard-back').disabled = false;
    next.innerHTML = `Enviar reporte ${icon('check', 18)}`;
    showFormError(
      err instanceof api.ApiError && err.status && err.status < 500
        ? err.message
        : 'No pudimos enviar el reporte. Revisa tu conexión a internet e inténtalo otra vez.',
    );
  }
}

function showSuccess(r) {
  openDialog(
    `<div class="success-body"><span class="success-check">${icon('check', 55)}</span><span class="eyebrow">GRACIAS POR SUMAR TU VOZ</span><h2 id="dialog-title">¡Reporte publicado!</h2><p>Lo que viste ya tiene un lugar en el mapa ciudadano.</p><div class="success-summary"><strong>${esc(r.id)}</strong><span>${icon('clock', 16)} ${formatDate(r.createdAt)}</span><span>${icon('map-pin', 16)} ${esc(formatAddress(r))}</span><span>${icon(categoryById(r.category).icon, 16)} ${esc(r.detail)}</span></div><div class="wizard-notice">${icon('info', 19)}<span>No se ha enviado a la municipalidad y no implica la solución del problema.</span></div><button class="button orange full" id="another-report">Hacer otro reporte ${icon('plus', 18)}</button><button class="button outline full" id="success-reports">Ver mis reportes ${icon('arrow-right', 18)}</button><button class="text-button" id="success-map">Volver al mapa</button></div>`,
    'wizard success-dialog',
  );
  $('#another-report').onclick = () => startWizard();
  $('#success-reports').onclick = () => {
    closeDialog();
    showView('reports');
  };
  $('#success-map').onclick = () => {
    closeDialog();
    showView('map');
  };
}

// ---------- Eventos globales ----------
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-new]')) return startWizard();
  const nav = e.target.closest('[data-nav]');
  if (nav) return showView(nav.dataset.nav);
  const info = e.target.closest('[data-info]');
  if (info) return openInfo(info.dataset.info);
  const legal = e.target.closest('[data-legal]');
  if (legal) return openLegalOverlay(legal.dataset.legal);
  if (e.target.closest('[data-menu]')) return openMenu();
  const card = e.target.closest('[data-report]');
  if (card) {
    const r = [...cases, ...DEMO_REPORTS].find((x) => x.id === card.dataset.report);
    if (r) openReport(r);
  }
});

$('#report-search').oninput = (e) => {
  searchText = e.target.value;
  refresh();
};
$('#clear-filter').onclick = () => {
  searchText = '';
  $('#report-search').value = '';
  refresh();
};
$('#reset-search').onclick = () => {
  visibleCategories = new Set(CATEGORIES.map((c) => c.id));
  searchText = '';
  $('#report-search').value = '';
  refresh();
};
$('#show-all').onclick = () => {
  visibleCategories = new Set(CATEGORIES.map((c) => c.id));
  refresh();
};
$('#hide-all').onclick = () => {
  visibleCategories.clear();
  refresh();
};
$('#category-filters').onchange = (e) => {
  const box = e.target.closest('[data-category]');
  if (!box) return;
  if (box.checked) visibleCategories.add(box.dataset.category);
  else visibleCategories.delete(box.dataset.category);
  refresh();
};
$('#toggle-examples').onclick = () => {
  showExamples = !showExamples;
  $('#toggle-examples').setAttribute('aria-pressed', showExamples);
  refresh();
};
$('#locate-main').onclick = () => locate(mainMap);
$('#mobile-filter').onclick = () => {
  const sidebar = $('.sidebar');
  sidebar.classList.toggle('mobile-open');
  $('#mobile-filter').setAttribute('aria-expanded', sidebar.classList.contains('mobile-open'));
  if (sidebar.classList.contains('mobile-open')) sidebar.scrollIntoView({ behavior: 'smooth', block: 'start' });
};
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !dialog.open && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    if (view !== 'map') showView('map');
    $('.sidebar').classList.add('mobile-open');
    $('#report-search').focus();
  }
});

// ---------- Inicio ----------
initMainMap();
try {
  cases = await api.listReports();
  refresh();
} catch {
  toast('No se pudieron cargar los reportes. Puedes explorar los ejemplos mientras tanto.');
}
