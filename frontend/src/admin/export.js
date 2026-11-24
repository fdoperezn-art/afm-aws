// Exportación a Excel (.xlsx) del panel de moderación. Se genera en el navegador con los datos ya cargados:
// no pasa por ningún servidor. Contiene datos personales: tratar el archivo con cuidado.
import { categoryById } from '../../../shared/rules.js';
import { formatAddress } from '../lib/address.js';

const DUP_TEXT = {
  'foto-identica': 'Automática: misma foto',
  'foto-similar': 'Automática: foto casi idéntica',
  manual: 'Manual (moderación)',
};

/** Excel guarda las fechas sin zona horaria: se ajustan para que se vean en la hora local (Chile). */
function localDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000);
}

const text = (value) => ({ type: String, value: value == null ? '' : String(value) });
const num = (value) => (Number.isFinite(value) ? { type: Number, value } : null);
const date = (iso) => (iso ? { type: Date, value: localDate(iso), format: 'dd/mm/yyyy hh:mm' } : null);
const header = (titles) => titles.map((t) => ({ value: t, fontWeight: 'bold', backgroundColor: '#FDE2CC' }));
const mapUrl = (p) => `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}`;

function reportsSheet(tickets) {
  const rows = [
    header([
      'Ticket', 'Reporte', 'Fecha', 'Categoría', 'Detalle', 'Dirección', 'Sector', 'Latitud', 'Longitud',
      'Descripción', 'Nombre', 'Apellido', 'WhatsApp', 'Relación con Conchalí', 'Relación con el sector',
      'Unión al ticket', 'Avisos de contenido', 'Fotos', 'Aceptó términos', 'Versión términos', 'Mapa',
    ]),
  ];
  for (const t of tickets) {
    for (const r of t.reports) {
      const c = r.contact || {};
      rows.push([
        text(t.id),
        text(r.id),
        date(r.createdAt),
        text(categoryById(r.category).name),
        text(r.detail),
        text(formatAddress(r)),
        text(r.addressParts?.neighborhood),
        num(r.lat),
        num(r.lng),
        text(r.description),
        text(c.firstName),
        text(c.lastName),
        text(c.phone),
        text(c.relation),
        text(c.sector),
        text(DUP_TEXT[r.dupReason] || 'Reporte original'),
        num(r.flagCount || 0),
        num((r.photos || []).length),
        date(c.consentAt),
        text(c.termsVersion),
        text(mapUrl(r)),
      ]);
    }
  }
  return {
    sheet: 'Reportes',
    data: rows,
    stickyRowsCount: 1,
    columns: [10, 14, 17, 22, 30, 30, 18, 11, 11, 60, 16, 16, 14, 20, 22, 26, 10, 7, 17, 12, 50].map((width) => ({ width })),
  };
}

function ticketsSheet(tickets) {
  const rows = [
    header(['Ticket', 'Categoría', 'Detalle', 'Dirección', 'N° de reportes', 'Primer reporte', 'Último reporte', 'Posibles duplicados', 'Mapa']),
  ];
  for (const t of tickets) {
    rows.push([
      text(t.id),
      text(categoryById(t.category).name),
      text(t.detail),
      text(formatAddress(t)),
      num(t.reportCount),
      date(t.createdAt),
      date(t.updatedAt),
      text(t.suggestions.map((s) => `${s.ticketId} (${s.reason}, ${s.meters} m)`).join('; ')),
      text(mapUrl(t)),
    ]);
  }
  return {
    sheet: 'Tickets',
    data: rows,
    stickyRowsCount: 1,
    columns: [10, 22, 30, 30, 14, 17, 17, 45, 50].map((width) => ({ width })),
  };
}

function flagsSheet(flags, tickets) {
  const ticketOf = (reportId) => tickets.find((t) => t.reports.some((r) => r.id === reportId))?.id || '(eliminado)';
  const rows = [header(['Aviso', 'Ticket', 'Reporte', 'Motivo', 'Nota', 'Fecha', 'Estado', 'Resuelto por', 'Fecha resolución'])];
  for (const f of flags) {
    rows.push([
      text(f.id),
      text(ticketOf(f.reportId)),
      text(f.reportId),
      text(f.reason),
      text(f.note),
      date(f.createdAt),
      text(f.status === 'open' ? 'Abierto' : 'Resuelto'),
      text(f.resolvedBy),
      date(f.resolvedAt),
    ]);
  }
  return {
    sheet: 'Avisos',
    data: rows,
    stickyRowsCount: 1,
    columns: [16, 10, 14, 34, 50, 17, 10, 28, 17].map((width) => ({ width })),
  };
}

function visitsSheet(visits = []) {
  const rows = [header(['Visita', 'Fecha de visita', 'Nombre', 'Apellidos', 'Teléfono', 'Dirección', 'Cargo', 'Compromiso', 'Registrado por', 'Latitud', 'Longitud', 'Ingresada'])];
  for (const v of visits) {
    rows.push([
      text(v.id),
      { type: Date, value: new Date(`${v.visitDate}T00:00:00Z`), format: 'dd/mm/yyyy' },
      text(v.firstName),
      text(v.lastNames),
      text(v.phone),
      text(v.address),
      text(v.role),
      text(v.commitment),
      text(v.registeredBy),
      num(v.location?.lat),
      num(v.location?.lng),
      date(v.createdAt),
    ]);
  }
  return {
    sheet: 'Visitas',
    data: rows,
    stickyRowsCount: 1,
    columns: [12, 14, 16, 22, 14, 34, 26, 70, 20, 11, 11, 17].map((width) => ({ width })),
  };
}

/** Genera y descarga el Excel con tickets, reportes, avisos y visitas a terreno. */
export async function downloadExcel(tickets, flags, visits = []) {
  // La librería se carga solo al exportar, para no hacer más lento el panel.
  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const stamp = new Date().toLocaleString('sv-SE').slice(0, 16).replace(' ', '_').replace(':', 'h');
  await writeExcelFile([reportsSheet(tickets), ticketsSheet(tickets), flagsSheet(flags, tickets), visitsSheet(visits)], {
    fontFamily: 'Calibri',
    fontSize: 11,
  }).toFile(`AFM_reportes_${stamp}.xlsx`);
}
