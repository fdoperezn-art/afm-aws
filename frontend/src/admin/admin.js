// Panel de moderación de AFM. Solo para el equipo de moderación (usuarios de Amazon Cognito).
import { Amplify } from 'aws-amplify';
import {
  confirmSignIn, fetchAuthSession, getCurrentUser, signIn, signOut,
} from 'aws-amplify/auth';
import '../styles.css';
import './admin.css';

import { categoryById } from '../../../shared/rules.js';
import * as api from '../lib/api.js';
import { downloadExcel } from './export.js';
import { formatAddress } from '../lib/address.js';
import { $, $$, brand, esc, fold, formatDateTime, toast } from '../lib/dom.js';
import { icon, roadSign } from '../lib/icons.js';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    },
  },
});

let tab = 'resumen';
let tickets = [];
let flags = [];
let visits = [];
let filterText = '';

const app = $('#app');

async function idToken() {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error('Sesión expirada');
  return token;
}

function shell(content) {
  app.innerHTML = `<header class="header admin-header"><a class="brand-button" href="/" aria-label="Ir al mapa">${brand()}</a><span class="admin-badge">${icon('lock', 15)} MODERACIÓN</span><div class="header-actions" id="admin-actions"></div></header><main class="admin-main">${content}</main>`;
}

// ---------- Inicio de sesión ----------
function renderLogin(message = '') {
  shell(`<section class="admin-card"><span class="eyebrow">ACCESO RESTRINGIDO</span><h1>Panel de moderación</h1><p class="muted">Solo para el equipo de AFM. Las cuentas las crea un administrador.</p>
    <form id="login-form" class="admin-form"><label class="field-label" for="email">Correo</label><input class="dark-input" id="email" type="email" autocomplete="username" required>
    <label class="field-label" for="password">Contraseña</label><input class="dark-input" id="password" type="password" autocomplete="current-password" required>
    <p class="form-error" id="login-error" role="alert" ${message ? '' : 'hidden'}>${esc(message)}</p>
    <button class="button orange full" type="submit">Iniciar sesión ${icon('arrow-right', 18)}</button></form></section>`);
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    await runStep(() => signIn({ username: $('#email').value.trim(), password: $('#password').value }), '#login-error');
  };
}

/** Ejecuta un paso de inicio de sesión y muestra el siguiente que pida Cognito. */
async function runStep(action, errorSel) {
  const button = $('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await action();
    await handleNextStep(result.nextStep);
  } catch (err) {
    button.disabled = false;
    const el = $(errorSel);
    el.hidden = false;
    el.textContent = loginErrorMessage(err);
  }
}

function loginErrorMessage(err) {
  if (err?.name === 'NotAuthorizedException') return 'Correo o contraseña incorrectos.';
  if (err?.name === 'CodeMismatchException') return 'El código no es válido. Revisa tu app de autenticación.';
  if (err?.name === 'InvalidPasswordException')
    return 'La contraseña debe tener al menos 12 caracteres, con mayúsculas, minúsculas, números y símbolos.';
  if (err?.name === 'UserAlreadyAuthenticatedException') return 'Ya hay una sesión iniciada. Recarga la página.';
  return err?.message || 'No se pudo iniciar sesión.';
}

async function handleNextStep(next) {
  switch (next.signInStep) {
    case 'DONE':
      return loadDashboard();
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
      return renderForm(
        'Crea tu contraseña',
        'Es tu primer inicio de sesión. Elige una contraseña nueva (mínimo 12 caracteres, con mayúsculas, minúsculas, números y símbolos).',
        '<label class="field-label" for="value">Nueva contraseña</label><input class="dark-input" id="value" type="password" autocomplete="new-password" required>',
      );
    case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': {
      const uri = next.totpSetupDetails.getSetupUri('AFM Moderación').toString();
      return renderForm(
        'Activa la verificación en dos pasos',
        'Agrega AFM a tu app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…) con esta clave y escribe el código de 6 dígitos.',
        `<p class="totp-secret"><code>${esc(next.totpSetupDetails.sharedSecret)}</code></p><p class="field-help"><a href="${esc(uri)}">Abrir en mi app de autenticación</a> (desde el celular)</p><label class="field-label" for="value">Código</label><input class="dark-input" id="value" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>`,
      );
    }
    case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
      return runStepNoForm(() => confirmSignIn({ challengeResponse: 'TOTP' }));
    case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
      return renderForm(
        'Código de verificación',
        'Escribe el código de 6 dígitos de tu app de autenticación.',
        '<label class="field-label" for="value">Código</label><input class="dark-input" id="value" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>',
      );
    default:
      return renderLogin(`Paso de inicio de sesión no soportado: ${next.signInStep}`);
  }
}

async function runStepNoForm(action) {
  const result = await action();
  await handleNextStep(result.nextStep);
}

function renderForm(title, text, fields) {
  shell(`<section class="admin-card"><span class="eyebrow">ACCESO RESTRINGIDO</span><h1>${title}</h1><p class="muted">${text}</p><form id="step-form" class="admin-form">${fields}<p class="form-error" id="step-error" role="alert" hidden></p><button class="button orange full" type="submit">Continuar ${icon('arrow-right', 18)}</button></form><button class="text-button" id="restart">Volver a empezar</button></section>`);
  $('#value').focus();
  $('#restart').onclick = async () => {
    await signOut().catch(() => {});
    renderLogin();
  };
  $('#step-form').onsubmit = async (e) => {
    e.preventDefault();
    await runStep(() => confirmSignIn({ challengeResponse: $('#value').value.trim() }), '#step-error');
  };
}

// ---------- Panel ----------
const DUP_LABELS = {
  'foto-identica': 'Unido automáticamente: misma foto',
  'foto-similar': 'Unido automáticamente: foto casi idéntica',
  manual: 'Unido por moderación',
};

async function loadDashboard() {
  shell('<p class="muted admin-loading">Cargando…</p>');
  try {
    const token = await idToken();
    [tickets, flags, visits] = await Promise.all([api.admin.tickets(token), api.admin.flags(token), api.admin.visits(token)]);
    renderDashboard();
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 401) {
      await signOut().catch(() => {});
      return renderLogin('Tu sesión expiró. Inicia sesión nuevamente.');
    }
    shell(`<section class="admin-card"><h1>No se pudo cargar el panel</h1><p class="muted">${esc(err.message)}</p><button class="button orange" id="retry">Reintentar</button></section>`);
    $('#retry').onclick = loadDashboard;
  }
}

const ticketOfReport = (reportId) => tickets.find((t) => t.reports.some((r) => r.id === reportId));

function matchesFilter(t) {
  const q = fold(filterText.trim());
  if (!q) return true;
  return fold(`${t.id} ${t.detail} ${categoryById(t.category).name} ${formatAddress(t)} ${t.reports.map((r) => r.id).join(' ')}`).includes(q);
}

function renderDashboard() {
  const openFlags = flags.filter((f) => f.status === 'open');
  const reportCount = tickets.reduce((n, t) => n + t.reportCount, 0);
  const suggested = tickets.filter((t) => t.suggestions.length).length;
  shell(`<div class="section-title"><div><span class="eyebrow muted">EQUIPO AFM</span><h1>Moderación<span class="orange-text">.</span></h1><p class="muted">${tickets.length} tickets · ${reportCount} reportes de vecinos${suggested ? ` · <strong class="orange-text">${suggested} con posibles duplicados</strong>` : ''}</p></div></div>
    <div class="admin-tabs" role="tablist"><button role="tab" data-tab="resumen" aria-selected="${tab === 'resumen'}">${icon('layers', 16)} Resumen</button><button role="tab" data-tab="tickets" aria-selected="${tab === 'tickets'}">${icon('reports', 16)} Tickets <span>${tickets.length}</span></button><button role="tab" data-tab="flags" aria-selected="${tab === 'flags'}">${icon('flag', 16)} Avisos abiertos <span>${openFlags.length}</span></button><button role="tab" data-tab="history" aria-selected="${tab === 'history'}">${icon('check', 16)} Avisos resueltos <span>${flags.length - openFlags.length}</span></button><button role="tab" data-tab="visits" aria-selected="${tab === 'visits'}">${icon('map-pin', 16)} Visita a terreno <span>${visits.length}</span></button></div>
    ${tab === 'tickets' || tab === 'visits' ? `<label class="search-field admin-search">${icon('search', 18)}<input id="ticket-filter" placeholder="${tab === 'visits' ? 'Buscar por nombre, cargo, dirección o compromiso' : 'Buscar por ticket (T-0042), calle o problema'}" value="${esc(filterText)}"></label>` : ''}
    <div id="admin-content"></div>`);
  $('#admin-actions').innerHTML = `<button class="button orange small" id="export-excel">${icon('download', 16)} Descargar Excel</button><button class="button outline small" id="reload">${icon('refresh', 16)} Actualizar</button><button class="button black small" id="logout">${icon('log-out', 16)} Salir</button>`;
  $('#reload').onclick = loadDashboard;
  $('#export-excel').onclick = async () => {
    const btn = $('#export-excel');
    btn.disabled = true;
    try {
      await downloadExcel(tickets, flags, visits);
      toast('Excel descargado. Contiene datos personales: guárdalo en un lugar seguro.');
    } catch {
      toast('No se pudo generar el Excel. Inténtalo otra vez.');
    } finally {
      btn.disabled = false;
    }
  };
  $('#logout').onclick = async () => {
    await signOut();
    renderLogin();
  };
  $$('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        if (tab !== b.dataset.tab) filterText = '';
        tab = b.dataset.tab;
        renderDashboard();
      }),
  );
  renderContent();
  const filter = $('#ticket-filter');
  if (filter)
    filter.oninput = () => {
      filterText = filter.value;
      renderContent();
    };
}

async function renderContent() {
  const content = $('#admin-content');
  if (tab === 'resumen') {
    content.innerHTML = '<p class="muted admin-loading">Cargando resumen…</p>';
    const { renderDashboard: renderSummary } = await import('./dashboard.js');
    renderSummary(content, { tickets, flags }, {
      onOpenTicket: (id) => {
        tab = 'tickets';
        filterText = id;
        renderDashboard();
      },
    });
    return;
  }
  if (tab === 'visits') return renderVisits(content);
  if (tab === 'tickets') {
    const list = tickets.filter(matchesFilter);
    content.innerHTML = list.length
      ? list.map(ticketCard).join('')
      : empty(tickets.length ? 'Ningún ticket coincide con la búsqueda.' : 'Aún no hay reportes.');
  } else {
    const list = tab === 'flags' ? flags.filter((f) => f.status === 'open') : flags.filter((f) => f.status !== 'open');
    content.innerHTML = list.length
      ? list.map(flagCard).join('')
      : empty(tab === 'flags' ? 'No hay avisos pendientes.' : 'No hay avisos resueltos.');
  }
  $$('[data-delete]', content).forEach((b) => (b.onclick = () => deleteReport(b.dataset.delete)));
  $$('[data-detach]', content).forEach((b) => (b.onclick = () => detachReport(b.dataset.detach)));
  $$('[data-resolve]', content).forEach((b) => (b.onclick = () => resolveFlag(b.dataset.report, b.dataset.resolve)));
  $$('[data-merge-into]', content).forEach(
    (b) => (b.onclick = () => mergeTicket(b.dataset.mergeFrom, b.dataset.mergeInto)),
  );
  $$('form[data-merge-form]', content).forEach(
    (form) =>
      (form.onsubmit = (e) => {
        e.preventDefault();
        mergeTicket(form.dataset.mergeForm, $('input', form).value);
      }),
  );
}

const empty = (text) => `<div class="admin-empty">${icon('check', 28)}<p>${text}</p></div>`;
const mapLink = (p) =>
  `<a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}" target="_blank" rel="noopener">ver en mapa</a>`;

function ticketCard(t) {
  const cat = categoryById(t.category);
  const many = t.reports.length > 1;
  return `<article class="admin-ticket" id="ticket-${esc(t.id)}"><header class="admin-ticket-head">${roadSign(cat.icon, 'local-sign')}<div><span class="ticket-number">${esc(t.id)}</span><h3>${esc(t.detail)}</h3><p class="muted">${esc(cat.name)} · ${icon('map-pin', 13)} ${esc(formatAddress(t))} ${mapLink(t)}</p><p class="muted">${t.reportCount} reporte${t.reportCount > 1 ? 's' : ''} · último ${formatDateTime(t.updatedAt)}</p></div></header>
    ${t.suggestions.length ? `<div class="admin-suggestions">${t.suggestions.map((s) => `<div>${icon('circle-alert', 16)} <span>Posible duplicado de <a href="#ticket-${esc(s.ticketId)}"><strong>${esc(s.ticketId)}</strong></a> — ${esc(s.reason)} (${s.meters} m)</span><button class="button outline small" data-merge-from="${esc(t.id)}" data-merge-into="${esc(s.ticketId)}">Unir a ${esc(s.ticketId)}</button></div>`).join('')}</div>` : ''}
    <form class="admin-merge" data-merge-form="${esc(t.id)}"><label for="merge-${esc(t.id)}">Marcar como duplicado de</label><input class="dark-input" id="merge-${esc(t.id)}" placeholder="T-0000" pattern="[Tt]-\\d{4,}" required><button class="button black small" type="submit">Unir</button></form>
    ${t.reports.map((r) => reportCard(r, { canDetach: many })).join('')}</article>`;
}

function reportCard(r, { canDetach = false } = {}) {
  const c = r.contact || {};
  const dup = DUP_LABELS[r.dupReason];
  return `<div class="admin-report"><div class="admin-report-body"><span class="muted"><strong>${esc(r.id)}</strong> · ${formatDateTime(r.createdAt)}</span>${dup ? `<p class="dup-badge">${icon('layers', 13)} ${dup}${r.dupOf ? ` (con ${esc(r.dupOf)})` : ''}${r.dupReason === 'manual' && r.ticketChangedBy ? ` · ${esc(r.ticketChangedBy)}` : ''}</p>` : ''}<p class="description">${esc(r.description)}</p><div class="admin-photos">${(r.photos || []).map((p, i) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="Foto ${i + 1}" loading="lazy"></a>`).join('')}</div><dl class="admin-contact"><div><dt>Nombre</dt><dd>${esc(c.firstName)} ${esc(c.lastName)}</dd></div><div><dt>WhatsApp</dt><dd>${esc(c.phone)}</dd></div><div><dt>Relación</dt><dd>${esc(c.relation)} · ${esc(c.sector)}</dd></div><div><dt>Ubicación indicada</dt><dd>${esc(formatAddress(r))} ${mapLink(r)}</dd></div><div><dt>Aceptó términos</dt><dd>${c.consentAt ? formatDateTime(c.consentAt) : '—'} (v${esc(c.termsVersion)})</dd></div></dl>${r.flagCount ? `<p class="admin-flag-count">${icon('flag', 14)} ${r.flagCount} aviso(s) de contenido</p>` : ''}<div class="detail-actions">${canDetach ? `<button class="button outline small" data-detach="${esc(r.id)}">Separar en ticket nuevo</button>` : ''}<button class="text-button danger" data-delete="${esc(r.id)}">Eliminar reporte</button></div></div></div>`;
}

function flagCard(f) {
  const t = ticketOfReport(f.reportId);
  const r = t?.reports.find((x) => x.id === f.reportId);
  return `<article class="admin-flag"><div class="admin-flag-head"><span class="status-pill">${icon('flag', 13)} ${esc(f.reason)}</span><span class="muted">${t ? `<strong>${esc(t.id)}</strong> · ` : ''}${esc(f.id)} · ${formatDateTime(f.createdAt)}</span></div>${f.note ? `<p class="admin-note">“${esc(f.note)}”</p>` : ''}${r ? reportCard(r) : '<p class="muted">El reporte ya no existe.</p>'}${f.status === 'open' ? `<div class="detail-actions"><button class="button outline small" data-resolve="${esc(f.id)}" data-report="${esc(f.reportId)}">${icon('check', 16)} Mantener reporte y cerrar aviso</button></div>` : `<p class="muted">Resuelto ${f.resolvedAt ? formatDateTime(f.resolvedAt) : ''} ${f.resolvedBy ? `por ${esc(f.resolvedBy)}` : ''}</p>`}</article>`;
}

async function deleteReport(id) {
  if (!confirm(`¿Eliminar el reporte ${id}? Se borrarán sus fotos, datos de contacto y avisos. No se puede deshacer.`)) return;
  try {
    await api.admin.deleteReport(await idToken(), id);
    toast('Reporte eliminado.');
    await loadDashboard();
  } catch (err) {
    toast(`No se pudo eliminar: ${err.message}`);
  }
}

async function detachReport(id) {
  if (!confirm(`¿Separar el reporte ${id} en un ticket nuevo? Úsalo cuando se unió por error a otro caso.`)) return;
  try {
    const { ticketId } = await api.admin.detachReport(await idToken(), id);
    toast(`El reporte quedó en el ticket nuevo ${ticketId}.`);
    await loadDashboard();
  } catch (err) {
    toast(`No se pudo separar: ${err.message}`);
  }
}

async function mergeTicket(from, intoRaw) {
  const into = String(intoRaw || '').trim().toUpperCase();
  if (!/^T-\d{4,}$/.test(into)) return toast('Escribe un número de ticket válido, por ejemplo T-0042.');
  if (into === from) return toast('No puedes unir un ticket consigo mismo.');
  if (!confirm(`¿Marcar ${from} como duplicado de ${into}? Todos los reportes de ${from} pasarán a ${into}.`)) return;
  try {
    const res = await api.admin.mergeTicket(await idToken(), from, into);
    toast(`${from} unido a ${into} (${res.reports} reporte${res.reports > 1 ? 's' : ''}).`);
    await loadDashboard();
  } catch (err) {
    toast(`No se pudo unir: ${err.message}`);
  }
}

async function resolveFlag(reportId, flagId) {
  try {
    const updated = await api.admin.resolveFlag(await idToken(), reportId, flagId);
    flags = flags.map((f) => (f.id === flagId ? updated.flag : f));
    renderDashboard();
    toast('Aviso cerrado.');
  } catch (err) {
    toast(`No se pudo cerrar el aviso: ${err.message}`);
  }
}


// ---------- Visitas a terreno ----------
function matchesVisit(v) {
  const q = fold(filterText.trim());
  if (!q) return true;
  return fold(`${v.id} ${v.firstName} ${v.lastNames} ${v.role} ${v.address} ${v.commitment} ${v.registeredBy || ''}`).includes(q);
}

const visitDateText = (d) => d.split('-').reverse().join('-');

function visitCard(v) {
  const map = v.location
    ? ` · <a href="https://www.openstreetmap.org/?mlat=${v.location.lat}&mlon=${v.location.lng}#map=18/${v.location.lat}/${v.location.lng}" target="_blank" rel="noopener">ver en mapa</a>`
    : '';
  return `<article class="admin-report visit-card">${icon('map-pin', 22)}<div class="admin-report-body"><span class="muted"><strong>${esc(v.id)}</strong> · Visita del ${visitDateText(v.visitDate)}${v.registeredBy ? ` · registrada por ${esc(v.registeredBy)}` : ''}</span><h3>${esc(v.firstName)} ${esc(v.lastNames)}</h3><p class="muted">${esc(v.role)}</p><dl class="admin-contact"><div><dt>Teléfono</dt><dd>${esc(v.phone)}</dd></div><div><dt>Dirección</dt><dd>${esc(v.address)}${map}</dd></div></dl><p class="visit-commitment"><strong>Compromiso:</strong> ${esc(v.commitment)}</p><div class="detail-actions"><button class="text-button danger" data-delete-visit="${esc(v.id)}">Eliminar registro</button></div></div></article>`;
}

function renderVisits(content) {
  const list = visits.filter(matchesVisit);
  const withPoint = visits.filter((v) => v.location).length;
  content.innerHTML = `<p class="muted">${visits.length} visita${visits.length === 1 ? '' : 's'} registrada${visits.length === 1 ? '' : 's'} · ${withPoint} con punto en el mapa. El equipo las registra en <strong>/equipo</strong> con el código compartido.</p>${
    list.length ? list.map(visitCard).join('') : empty(visits.length ? 'Ninguna visita coincide con la búsqueda.' : 'Aún no hay visitas registradas.')
  }`;
  $$('[data-delete-visit]', content).forEach((b) => (b.onclick = () => deleteVisit(b.dataset.deleteVisit)));
}

async function deleteVisit(id) {
  if (!confirm(`¿Eliminar el registro de visita ${id}? No se puede deshacer.`)) return;
  try {
    await api.admin.deleteVisit(await idToken(), id);
    visits = visits.filter((v) => v.id !== id);
    toast('Registro eliminado.');
    renderDashboard();
  } catch (err) {
    toast(`No se pudo eliminar: ${err.message}`);
  }
}

// ---------- Inicio ----------
try {
  await getCurrentUser();
  await loadDashboard();
} catch {
  renderLogin();
}
