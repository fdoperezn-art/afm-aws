// Cliente de la API REST de AFM (API Gateway + Lambda).
const API_URL = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** Llamada genérica. `token` es el ID token de Cognito para las rutas de moderación. */
export async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  if (!API_URL) throw new ApiError('Falta configurar VITE_API_URL.', 0);
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: token } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.message || 'No se pudo conectar con AFM.', res.status);
  return data;
}

// --- Rutas públicas ---
/** Casos públicos: cada uno agrupa los reportes de uno o más vecinos sobre el mismo problema. */
export const listReports = () => request('/reports').then((d) => d.cases);

/** Sube una foto directo a S3 con una URL firmada y devuelve su clave temporal. */
export async function uploadPhoto(file) {
  const { key, url, fields } = await request('/uploads', {
    method: 'POST',
    body: { contentType: file.type, size: file.size },
  });
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', file); // el archivo debe ir al final
  const res = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new ApiError('No se pudo subir la fotografía.', res.status);
  return key;
}

export const createReport = (report) => request('/reports', { method: 'POST', body: report });

export const deleteOwnReport = (id, deleteToken) =>
  request(`/reports/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-Delete-Token': deleteToken } });

export const flagReport = (id, flag) =>
  request(`/reports/${encodeURIComponent(id)}/flags`, { method: 'POST', body: flag });

// --- Rutas de moderación (requieren sesión de Cognito) ---
export const admin = {
  tickets: (token) => request('/admin/tickets', { token }).then((d) => d.tickets),
  flags: (token) => request('/admin/flags', { token }).then((d) => d.flags),
  deleteReport: (token, id) => request(`/admin/reports/${encodeURIComponent(id)}`, { method: 'DELETE', token }),
  detachReport: (token, id) =>
    request(`/admin/reports/${encodeURIComponent(id)}/detach`, { method: 'POST', token }),
  mergeTicket: (token, from, into) =>
    request(`/admin/tickets/${encodeURIComponent(from)}/merge`, { method: 'POST', token, body: { into } }),
  resolveFlag: (token, reportId, flagId) =>
    request(`/admin/reports/${encodeURIComponent(reportId)}/flags/${encodeURIComponent(flagId)}`, {
      method: 'PATCH',
      token,
      body: { status: 'resolved' },
    }),
};
