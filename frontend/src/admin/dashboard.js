// Tablero («Resumen») del panel de moderación. Todo se calcula en el navegador con los datos ya cargados:
// sin servicios ni costos adicionales. Una sola serie por gráfico → un solo color (naranja AFM validado
// para fondo oscuro: #f0620a, contraste ≥ 3:1 y luminosidad dentro de la banda para modo oscuro).
import L from 'leaflet';
import { BOUNDARY } from '../../../shared/boundary.js';
import { BOUNDS } from '../../../shared/geo.js';
import { RELATIONS, SECTORS, categoryById } from '../../../shared/rules.js';
import { formatAddress } from '../lib/address.js';
import { esc } from '../lib/dom.js';
import { icon } from '../lib/icons.js';

const RANGES = [
  { id: '7', label: 'Últimos 7 días', days: 7 },
  { id: '30', label: 'Últimos 30 días', days: 30 },
  { id: '90', label: 'Últimos 90 días', days: 90 },
  { id: 'all', label: 'Todo', days: null },
];
const DAY = 86400000;
const fmt = new Intl.NumberFormat('es-CL');
const pct = (n, total) => (total ? `${Math.round((n / total) * 100)} %` : '0 %');
let rangeId = '30';
let map;

// ---------- Datos ----------
function startOf(range) {
  if (!range.days) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return new Date(d.getTime() - (range.days - 1) * DAY);
}

function sliceData(tickets, flags, range) {
  const from = startOf(range);
  const inRange = (iso) => !from || new Date(iso) >= from;
  const reports = tickets.flatMap((t) => t.reports.filter((r) => inRange(r.createdAt)).map((r) => ({ ...r, ticketId: t.id })));
  const byTicket = new Map();
  for (const r of reports) byTicket.set(r.ticketId, (byTicket.get(r.ticketId) || 0) + 1);
  const cases = tickets
    .filter((t) => byTicket.has(t.id))
    .map((t) => ({ ...t, inRange: byTicket.get(t.id) }));
  // Periodo anterior de igual duración, para comparar.
  let previous = null;
  if (from) {
    const prevFrom = new Date(from.getTime() - range.days * DAY);
    previous = tickets.flatMap((t) => t.reports).filter((r) => {
      const d = new Date(r.createdAt);
      return d >= prevFrom && d < from;
    }).length;
  }
  return { from, reports, cases, flags: flags.filter((f) => inRange(f.createdAt)), previous };
}

function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k) m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
}

// ---------- Piezas ----------
function tile(label, value, note = '') {
  return `<div class="dash-tile"><span class="dash-tile-label">${label}</span><strong class="dash-tile-value">${value}</strong>${note ? `<span class="dash-tile-note">${note}</span>` : ''}</div>`;
}

function deltaNote(current, previous, range) {
  if (previous == null) return '';
  const diff = current - previous;
  if (!previous && !current) return `Sin cambios vs ${range.days} días anteriores`;
  const sign = diff > 0 ? '▲ +' : diff < 0 ? '▼ ' : '';
  return `${sign}${fmt.format(diff)} vs ${range.days} días anteriores`;
}

/** Barras horizontales ordenadas: valor al final de cada barra, detalle en el tooltip. */
function barList(rows, total, { emptyText = 'Sin datos en este periodo.', tipNote = 'de los reportes' } = {}) {
  if (!rows.length) return `<p class="dash-empty">${emptyText}</p>`;
  const max = Math.max(...rows.map((r) => r.value));
  return `<ol class="dash-bars">${rows
    .map(
      (r) =>
        `<li tabindex="0" data-tip-title="${esc(r.label)}" data-tip-value="${fmt.format(r.value)} · ${pct(r.value, total)} ${tipNote}"><span class="dash-bar-label">${r.icon ? icon(r.icon, 15) : ''}<span>${esc(r.label)}</span></span><span class="dash-bar-track"><span class="dash-bar" style="width:calc((100% - 40px) * ${Math.max(0.02, r.value / max).toFixed(4)})"></span><span class="dash-bar-value">${fmt.format(r.value)}</span></span></li>`,
    )
    .join('')}</ol>`;
}

/** Columnas en el tiempo: por día (≤ 31 días), por semana o por mes. */
function timeBins(reports, from) {
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const first = from || (reports.length ? new Date(Math.min(...reports.map((r) => new Date(r.createdAt)))) : end);
  first.setHours(0, 0, 0, 0);
  const spanDays = Math.round((end - first) / DAY) + 1;
  const unit = spanDays <= 31 ? 'day' : spanDays <= 26 * 7 ? 'week' : 'month';
  const keyOf = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    if (unit === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // lunes
    if (unit === 'month') x.setDate(1);
    return x.getTime();
  };
  const bins = new Map();
  for (let t = keyOf(first); t <= end.getTime(); ) {
    bins.set(t, 0);
    const n = new Date(t);
    if (unit === 'day') n.setDate(n.getDate() + 1);
    else if (unit === 'week') n.setDate(n.getDate() + 7);
    else n.setMonth(n.getMonth() + 1);
    t = n.getTime();
  }
  for (const r of reports) {
    const k = keyOf(r.createdAt);
    if (bins.has(k)) bins.set(k, bins.get(k) + 1);
  }
  const label = (t) => {
    const d = new Date(t);
    if (unit === 'month') return d.toLocaleDateString('es-CL', { month: 'short', year: 'numeric' });
    const s = d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short' });
    return unit === 'week' ? `Semana del ${s}` : s;
  };
  return { unit, bins: [...bins.entries()].map(([t, value]) => ({ t, value, label: label(t) })) };
}

function niceMax(v) {
  if (v <= 4) return Math.max(1, v);
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v);
}

function columns({ unit, bins }) {
  const max = Math.max(0, ...bins.map((b) => b.value));
  if (!max) return '<p class="dash-empty">Sin reportes en este periodo.</p>';
  const top = niceMax(max);
  const ticks = top <= 4 ? Array.from({ length: top + 1 }, (_, i) => i) : [0, top / 2, top];
  const every = Math.ceil(bins.length / 8); // etiquetas del eje x, sin amontonar
  const unitText = { day: 'por día', week: 'por semana', month: 'por mes' }[unit];
  return `<p class="dash-sub">Reportes ${unitText}</p><div class="dash-cols" style="--n:${bins.length}">
    <div class="dash-cols-grid">${ticks.map((t) => `<span style="bottom:${(t / top) * 100}%"><em>${fmt.format(t)}</em></span>`).join('')}</div>
    <div class="dash-cols-plot">${bins
      .map(
        (b) =>
          `<div class="dash-col" tabindex="0" data-tip-title="${esc(b.label)}" data-tip-value="${fmt.format(b.value)} reporte${b.value === 1 ? '' : 's'}"><span class="dash-col-bar" style="height:${(b.value / top) * 100}%"></span></div>`,
      )
      .join('')}</div>
    <div class="dash-cols-x">${bins.map((b, i) => `<span>${i % every === 0 ? esc(unit === 'week' ? b.label.replace('Semana del ', '') : b.label) : ''}</span>`).join('')}</div>
  </div>
  <table class="sr-only"><caption>Reportes ${unitText}</caption><tbody>${bins.map((b) => `<tr><th>${esc(b.label)}</th><td>${b.value}</td></tr>`).join('')}</tbody></table>`;
}

function card(title, body, extraClass = '') {
  return `<section class="dash-card ${extraClass}"><h3>${title}</h3>${body}</section>`;
}

// ---------- Render ----------
export function renderDashboard(container, { tickets, flags }, { onOpenTicket }) {
  const range = RANGES.find((r) => r.id === rangeId);
  const d = sliceData(tickets, flags, range);
  const total = d.reports.length;
  const auto = d.reports.filter((r) => r.dupReason === 'foto-identica' || r.dupReason === 'foto-similar').length;
  const manual = d.reports.filter((r) => r.dupReason === 'manual').length;
  const openFlags = d.flags.filter((f) => f.status === 'open').length;

  const byCategory = countBy(d.reports, (r) => r.category).map(([id, value]) => ({
    label: categoryById(id).name,
    icon: categoryById(id).icon,
    value,
  }));
  const byDetail = countBy(d.reports, (r) => `${r.detail}`).slice(0, 10).map(([label, value]) => ({ label, value }));
  const sectors = countBy(d.reports, (r) => (r.addressParts?.neighborhood || '').trim());
  const noSector = total - sectors.reduce((n, [, v]) => n + v, 0);
  const byRelation = RELATIONS.map((label) => ({ label, value: d.reports.filter((r) => r.contact?.relation === label).length }))
    .filter((r) => r.value)
    .sort((a, b) => b.value - a.value);
  const bySector = SECTORS.map((label) => ({ label, value: d.reports.filter((r) => r.contact?.sector === label).length }))
    .filter((r) => r.value)
    .sort((a, b) => b.value - a.value);
  const topCases = [...d.cases].sort((a, b) => b.inRange - a.inRange || b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);

  container.innerHTML = `
    <div class="dash-filters" role="group" aria-label="Periodo">${RANGES.map((r) => `<button type="button" data-range="${r.id}" aria-pressed="${r.id === rangeId}">${r.id === rangeId ? icon('check', 14) : ''}${r.label}</button>`).join('')}</div>
    <div class="dash-kpis">
      ${tile('Reportes de vecinos', fmt.format(total), deltaNote(total, d.previous, range))}
      ${tile('Casos (tickets)', fmt.format(d.cases.length), `${fmt.format(d.cases.filter((c) => c.inRange > 1).length)} con más de un vecino`)}
      ${tile('Vecinos por caso', d.cases.length ? (total / d.cases.length).toLocaleString('es-CL', { maximumFractionDigits: 1 }) : '0', 'promedio')}
      ${tile('Duplicados unidos', fmt.format(auto + manual), `${fmt.format(auto)} automáticos · ${fmt.format(manual)} por moderación`)}
      ${tile('Avisos de contenido abiertos', fmt.format(openFlags), `${fmt.format(d.flags.length)} recibidos en el periodo`)}
    </div>
    <div class="dash-grid">
      ${card('Reportes en el tiempo', columns(timeBins(d.reports, d.from)), 'dash-wide')}
      ${card('Reportes por categoría', barList(byCategory, total))}
      ${card('Temas más reportados', barList(byDetail, total))}
      ${card('Dónde están los casos', `<p class="dash-sub">Círculos más grandes = más vecinos reportaron el mismo caso. Toca uno para abrir su ticket.</p><div id="dash-map" aria-label="Mapa de casos"></div>`, 'dash-wide')}
      ${card('Sectores con más reportes', barList(sectors.slice(0, 10).map(([label, value]) => ({ label, value })), total, { emptyText: 'Los vecinos aún no indicaron sectores.' }) + (noSector ? `<p class="dash-sub">${fmt.format(noSector)} reporte${noSector === 1 ? '' : 's'} sin sector indicado.</p>` : ''))}
      ${card('Relación de los vecinos', `<p class="dash-sub">Con Conchalí</p>${barList(byRelation, total)}<p class="dash-sub">Con el sector reportado</p>${barList(bySector, total)}`)}
      ${card('Casos con más vecinos', topCases.length ? `<table class="dash-table"><thead><tr><th>Ticket</th><th>Problema</th><th>Dirección</th><th class="num">Vecinos</th></tr></thead><tbody>${topCases.map((c) => `<tr><td><button type="button" class="text-button" data-open-ticket="${esc(c.id)}">${esc(c.id)}</button></td><td>${esc(c.detail)}<span class="muted"> · ${esc(categoryById(c.category).name)}</span></td><td>${esc(formatAddress(c))}</td><td class="num">${fmt.format(c.inRange)}</td></tr>`).join('')}</tbody></table>` : '<p class="dash-empty">Sin casos en este periodo.</p>', 'dash-wide')}
    </div>
    <p class="dash-sub">Datos calculados en tu navegador con la información del panel. Usa «Actualizar» para incluir los reportes más recientes.</p>
    <div class="dash-tip" role="tooltip" hidden><strong></strong><span></span></div>`;

  container.querySelectorAll('[data-range]').forEach(
    (b) =>
      (b.onclick = () => {
        rangeId = b.dataset.range;
        renderDashboard(container, { tickets, flags }, { onOpenTicket });
      }),
  );
  container.querySelectorAll('[data-open-ticket]').forEach((b) => (b.onclick = () => onOpenTicket(b.dataset.openTicket)));
  bindTooltips(container);
  drawMap(d.cases, onOpenTicket);
}

function bindTooltips(container) {
  const tip = container.querySelector('.dash-tip');
  const show = (el) => {
    tip.querySelector('strong').textContent = el.dataset.tipValue; // el valor primero
    tip.querySelector('span').textContent = el.dataset.tipTitle;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - t.width - 8, Math.max(8, r.left + r.width / 2 - t.width / 2))}px`;
    tip.style.top = `${Math.max(8, r.top - t.height - 8)}px`;
  };
  const hide = () => (tip.hidden = true);
  container.querySelectorAll('[data-tip-title]').forEach((el) => {
    el.addEventListener('pointerenter', () => show(el));
    el.addEventListener('focus', () => show(el));
    el.addEventListener('pointerleave', hide);
    el.addEventListener('blur', hide);
  });
  window.addEventListener('scroll', hide, { passive: true, once: true });
}

function drawMap(cases, onOpenTicket) {
  if (map) {
    map.remove();
    map = null;
  }
  const el = document.getElementById('dash-map');
  if (!el) return;
  map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25 });
  map.fitBounds(BOUNDS, { padding: [12, 12] }); // la vista debe existir antes de dibujar capas
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(map);
  L.geoJSON(BOUNDARY, { style: { color: '#fd6a02', weight: 2, fillOpacity: 0.02 }, interactive: false }).addTo(map);
  for (const c of [...cases].sort((a, b) => a.inRange - b.inRange)) {
    const marker = L.circleMarker([c.lat, c.lng], {
      radius: 6 + 4 * Math.sqrt(c.inRange - 1),
      color: '#161513', // anillo del color de la superficie
      weight: 2,
      fillColor: '#f0620a',
      fillOpacity: 0.75,
    }).addTo(map);
    const label = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `${c.inRange} vecino${c.inRange === 1 ? '' : 's'}`;
    label.append(strong, document.createTextNode(` · ${c.id} · ${c.detail}`));
    marker.bindTooltip(label, { direction: 'top', offset: [0, -6] });
    marker.on('click', () => onOpenTicket(c.id));
  }
  setTimeout(() => {
    map?.invalidateSize();
    map?.fitBounds(BOUNDS, { padding: [12, 12] });
  }, 50);
}

