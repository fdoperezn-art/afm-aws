// Panel de moderación de AFM. Solo para el equipo de moderación (usuarios de Amazon Cognito).
import { Amplify } from 'aws-amplify';
import {
  confirmSignIn, fetchAuthSession, getCurrentUser, signIn, signOut,
} from 'aws-amplify/auth';
import '../styles.css';
import './admin.css';

import { categoryById } from '../../../shared/rules.js';
import * as api from '../lib/api.js';
import { formatAddress } from '../lib/address.js';
import { $, $$, brand, esc, formatDateTime, toast } from '../lib/dom.js';
import { icon, roadSign } from '../lib/icons.js';

Amplify.configure({
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_USER_POOL_ID,
      userPoolClientId: import.meta.env.VITE_USER_POOL_CLIENT_ID,
    },
  },
});

let tab = 'flags';
let reports = [];
let flags = [];

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
async function loadDashboard() {
  shell('<p class="muted admin-loading">Cargando…</p>');
  try {
    const token = await idToken();
    [reports, flags] = await Promise.all([api.admin.reports(token), api.admin.flags(token)]);
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

function renderDashboard() {
  const openFlags = flags.filter((f) => f.status === 'open');
  shell(`<div class="section-title"><div><span class="eyebrow muted">EQUIPO AFM</span><h1>Moderación<span class="orange-text">.</span></h1></div></div>
    <div class="admin-tabs" role="tablist"><button role="tab" data-tab="flags" aria-selected="${tab === 'flags'}">${icon('flag', 16)} Avisos abiertos <span>${openFlags.length}</span></button><button role="tab" data-tab="reports" aria-selected="${tab === 'reports'}">${icon('reports', 16)} Reportes <span>${reports.length}</span></button><button role="tab" data-tab="history" aria-selected="${tab === 'history'}">${icon('check', 16)} Avisos resueltos <span>${flags.length - openFlags.length}</span></button></div>
    <div id="admin-content"></div>`);
  $('#admin-actions').innerHTML = `<button class="button outline small" id="reload">${icon('refresh', 16)} Actualizar</button><button class="button black small" id="logout">${icon('log-out', 16)} Salir</button>`;
  $('#reload').onclick = loadDashboard;
  $('#logout').onclick = async () => {
    await signOut();
    renderLogin();
  };
  $$('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        tab = b.dataset.tab;
        renderDashboard();
      }),
  );
  const content = $('#admin-content');
  if (tab === 'reports') content.innerHTML = reports.length ? reports.map(reportCard).join('') : empty('Aún no hay reportes.');
  else {
    const list = tab === 'flags' ? openFlags : flags.filter((f) => f.status !== 'open');
    content.innerHTML = list.length ? list.map(flagCard).join('') : empty(tab === 'flags' ? 'No hay avisos pendientes.' : 'No hay avisos resueltos.');
  }
  $$('[data-delete]').forEach((b) => (b.onclick = () => deleteReport(b.dataset.delete)));
  $$('[data-resolve]').forEach((b) => (b.onclick = () => resolveFlag(b.dataset.report, b.dataset.resolve)));
}

const empty = (text) => `<div class="admin-empty">${icon('check', 28)}<p>${text}</p></div>`;

function reportCard(r, { compact = false } = {}) {
  const cat = categoryById(r.category);
  const c = r.contact || {};
  return `<article class="admin-report">${roadSign(cat.icon, 'local-sign')}<div class="admin-report-body"><span class="muted">${esc(cat.name)} · <strong>${esc(r.id)}</strong> · ${formatDateTime(r.createdAt)}</span><h3>${esc(r.detail)}</h3><p>${icon('map-pin', 14)} ${esc(formatAddress(r))} <a href="https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=18/${r.lat}/${r.lng}" target="_blank" rel="noopener">ver en mapa</a></p><p class="description">${esc(r.description)}</p>${compact ? '' : `<div class="admin-photos">${(r.photos || []).map((p, i) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="Foto ${i + 1}" loading="lazy"></a>`).join('')}</div>`}<dl class="admin-contact"><div><dt>Nombre</dt><dd>${esc(c.firstName)} ${esc(c.lastName)}</dd></div><div><dt>WhatsApp</dt><dd>${esc(c.phone)}</dd></div><div><dt>Relación</dt><dd>${esc(c.relation)} · ${esc(c.sector)}</dd></div><div><dt>Aceptó términos</dt><dd>${c.consentAt ? formatDateTime(c.consentAt) : '—'} (v${esc(c.termsVersion)})</dd></div></dl>${r.flagCount ? `<p class="admin-flag-count">${icon('flag', 14)} ${r.flagCount} aviso(s)</p>` : ''}<div class="detail-actions"><button class="text-button danger" data-delete="${esc(r.id)}">Eliminar reporte</button></div></div></article>`;
}

function flagCard(f) {
  const r = reports.find((x) => x.id === f.reportId);
  return `<article class="admin-flag"><div class="admin-flag-head"><span class="status-pill">${icon('flag', 13)} ${esc(f.reason)}</span><span class="muted">${esc(f.id)} · ${formatDateTime(f.createdAt)}</span></div>${f.note ? `<p class="admin-note">“${esc(f.note)}”</p>` : ''}${r ? reportCard(r, { compact: false }) : '<p class="muted">El reporte ya no existe.</p>'}${f.status === 'open' ? `<div class="detail-actions"><button class="button outline small" data-resolve="${esc(f.id)}" data-report="${esc(f.reportId)}">${icon('check', 16)} Mantener reporte y cerrar aviso</button></div>` : `<p class="muted">Resuelto ${f.resolvedAt ? formatDateTime(f.resolvedAt) : ''} ${f.resolvedBy ? `por ${esc(f.resolvedBy)}` : ''}</p>`}</article>`;
}

async function deleteReport(id) {
  if (!confirm(`¿Eliminar el reporte ${id}? Se borrarán sus fotos, datos de contacto y avisos. No se puede deshacer.`)) return;
  try {
    await api.admin.deleteReport(await idToken(), id);
    reports = reports.filter((r) => r.id !== id);
    flags = flags.filter((f) => f.reportId !== id);
    renderDashboard();
    toast('Reporte eliminado.');
  } catch (err) {
    toast(`No se pudo eliminar: ${err.message}`);
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

// ---------- Inicio ----------
try {
  await getCurrentUser();
  await loadDashboard();
} catch {
  renderLogin();
}
