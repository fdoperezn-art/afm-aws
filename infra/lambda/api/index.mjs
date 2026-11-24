// API REST de AFM (detrás de API Gateway). Una sola función con un enrutador simple.
//
// Modelo (tabla única de DynamoDB):
//   Reporte  PK=REPORT#AFM-XXXXXXXX  SK=META            GSI1PK=REPORT  GSI1SK=<fecha>#<id>
//   Aviso    PK=REPORT#AFM-XXXXXXXX  SK=FLAG#AVISO-...  GSI1PK=FLAG    GSI1SK=<fecha>#<id>
//   Ticket   PK=TICKET#T-0001        SK=META            GSI1PK=TICKET  GSI1SK=<fecha>#<id>
//   Contador PK=COUNTER              SK=TICKET          (numeración correlativa de tickets)
// Cada reporte pertenece a un ticket (atributo ticketId). Un ticket = un caso; varios vecinos pueden
// reportar el mismo caso. El número de ticket es interno: solo lo ve el equipo de moderación.
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import jpeg from 'jpeg-js';

import {
  DUP_AUTO_MAX_METERS, DUP_HASH_MAX_DISTANCE, DUP_SUGGEST_MAX_METERS, FLAG_REASONS, MAX_PHOTO_BYTES, MAX_PHOTOS,
  TERMS_VERSION, UPLOAD_TYPE, distanceMeters, validateReport,
} from '../../../shared/rules.js';
import { normalizeVisit, validateVisit } from '../../../shared/visits.js';

const { TABLE_NAME, BUCKET_NAME, ALLOWED_ORIGINS = '', ADMIN_GROUP = 'moderadores', TEAM_CODE_PARAM = '/afm/equipo/codigo' } = process.env;
const ssm = new SSMClient({});
const origins = ALLOWED_ORIGINS.split(',').filter(Boolean);
const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const UPLOAD_KEY_RE = /^uploads\/[0-9a-f-]{36}\.jpg$/;
const REPORT_ID_RE = /^AFM-[0-9A-F]{8}$/;
const FLAG_ID_RE = /^AVISO-[0-9A-F]{8}$/;
const TICKET_ID_RE = /^T-\d{4,}$/;
const PHOTO_URL_TTL = 3600; // segundos
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Utilidades ----------
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const byDate = (a, b) => a.createdAt.localeCompare(b.createdAt);

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  return origin && origins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

function parseBody(event) {
  if (!event.body) throw new HttpError(400, 'Falta el contenido de la solicitud.');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY) throw new HttpError(413, 'La solicitud es demasiado grande.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'El contenido no es JSON válido.');
  }
}

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await db.send(new QueryCommand({ ...params, ExclusiveStartKey }));
    items.push(...page.Items);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

const queryType = (type) =>
  queryAll({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :t',
    ExpressionAttributeValues: { ':t': type },
  });

async function batchDelete(keys) {
  for (let i = 0; i < keys.length; i += 25) {
    await db.send(
      new BatchWriteCommand({
        RequestItems: { [TABLE_NAME]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
      }),
    );
  }
}

// ---------- Huellas de fotos (detección de duplicados) ----------
/**
 * Huella perceptual dHash de 64 bits: la imagen se reduce a 9×8 en escala de grises y cada bit indica
 * si un punto es más claro que su vecino. Sobrevive a reenvíos por WhatsApp, recompresión y cambios de tamaño.
 * lowDetail = imagen casi uniforme (p. ej. muy oscura): su huella no es confiable para unir casos.
 */
function perceptualHash(buffer) {
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 768 });
  const W = 9;
  const H = 8;
  const sum = new Float64Array(W * H);
  const count = new Uint32Array(W * H);
  const { width, height, data } = img;
  for (let y = 0; y < height; y++) {
    const cy = Math.min(H - 1, Math.floor((y * H) / height));
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const cell = cy * W + Math.min(W - 1, Math.floor((x * W) / width));
      sum[cell] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      count[cell]++;
    }
  }
  const avg = Array.from(sum, (s, i) => s / count[i]);
  let bits = 0n;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) bits = (bits << 1n) | (avg[y * W + x] < avg[y * W + x + 1] ? 1n : 0n);
  }
  return { dhash: bits.toString(16).padStart(16, '0'), lowDetail: Math.max(...avg) - Math.min(...avg) < 12 };
}

function hammingDistance(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/** Compara las fotos de dos reportes. Devuelve { exact, distance } de su par más parecido. */
function comparePhotos(hashesA = [], hashesB = []) {
  let best = { exact: false, distance: 64, reliable: false };
  for (const a of hashesA) {
    for (const b of hashesB) {
      if (a.sha256 === b.sha256) return { exact: true, distance: 0, reliable: true };
      const distance = hammingDistance(a.dhash, b.dhash);
      if (distance < best.distance) best = { exact: false, distance, reliable: !a.lowDetail && !b.lowDetail };
    }
  }
  return best;
}

const isSamePhoto = (cmp, meters) =>
  cmp.exact || (cmp.reliable && cmp.distance <= DUP_HASH_MAX_DISTANCE && meters <= DUP_AUTO_MAX_METERS);

// ---------- Vistas ----------
const photoUrls = (keys = []) =>
  Promise.all(
    keys.map(async (key) => ({
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: PHOTO_URL_TTL }),
    })),
  );

const publicReport = async (r) => ({
  id: r.id,
  description: r.description,
  createdAt: r.createdAt,
  photos: await photoUrls(r.photoKeys),
});

const adminReport = async (r) => ({
  ...(await publicReport(r)),
  category: r.category,
  detail: r.detail,
  lat: r.lat,
  lng: r.lng,
  address: r.address,
  addressParts: r.addressParts,
  contact: r.contact,
  flagCount: r.flagCount || 0,
  dupReason: r.dupReason,
  dupOf: r.dupOf,
  ticketChangedBy: r.ticketChangedBy,
});

/** Agrupa reportes por ticket. El primer reporte del caso define su categoría y ubicación. */
function groupByTicket(reports) {
  const groups = new Map();
  for (const r of [...reports].sort(byDate)) {
    if (!groups.has(r.ticketId)) groups.set(r.ticketId, []);
    groups.get(r.ticketId).push(r);
  }
  return [...groups.entries()].map(([ticketId, list]) => ({ ticketId, primary: list[0], reports: list }));
}

/** Caso público: se identifica por su primer reporte (el número de ticket no se publica). */
async function publicCase({ primary, reports }) {
  return {
    id: primary.id,
    category: primary.category,
    detail: primary.detail,
    lat: primary.lat,
    lng: primary.lng,
    address: primary.address,
    addressParts: primary.addressParts,
    createdAt: primary.createdAt,
    updatedAt: reports.at(-1).createdAt,
    reportCount: reports.length,
    reports: await Promise.all(reports.map(publicReport)),
  };
}

const reportKey = (id) => ({ PK: `REPORT#${id}`, SK: 'META' });

async function getReport(id) {
  if (!REPORT_ID_RE.test(id || '')) throw new HttpError(404, 'El reporte no existe.');
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: reportKey(id) }));
  if (!Item) throw new HttpError(404, 'El reporte no existe.');
  return Item;
}

/** Crea un ticket nuevo con el siguiente número correlativo. */
async function newTicket(reportId, createdAt) {
  const { Attributes } = await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: 'COUNTER', SK: 'TICKET' },
      UpdateExpression: 'ADD #v :one',
      ExpressionAttributeNames: { '#v': 'value' },
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  const id = `T-${String(Attributes.value).padStart(4, '0')}`;
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `TICKET#${id}`, SK: 'META', GSI1PK: 'TICKET', GSI1SK: `${createdAt}#${id}`, type: 'ticket',
        id, createdAt, firstReportId: reportId,
      },
    }),
  );
  return id;
}

/** Borra el reporte, sus avisos y sus fotos. Si el ticket queda sin reportes, deja de mostrarse. */
async function deleteReportCompletely(report) {
  const items = await queryAll({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `REPORT#${report.id}` },
    ProjectionExpression: 'PK, SK',
  });
  await batchDelete(items.map(({ PK, SK }) => ({ PK, SK })));
  if (report.photoKeys?.length) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: BUCKET_NAME, Delete: { Objects: report.photoKeys.map((Key) => ({ Key })) } }),
    );
  }
}

function requireModerator(event) {
  const claims = event.requestContext?.authorizer?.claims || {};
  const groups = String(claims['cognito:groups'] || '').split(/[,\s]+/).filter(Boolean);
  if (!claims.sub || !groups.includes(ADMIN_GROUP)) throw new HttpError(403, 'No tienes permisos de moderación.');
  return claims.email || claims.sub;
}

// ---------- Rutas públicas ----------
async function listCases() {
  const groups = groupByTicket(await queryType('REPORT'));
  const cases = await Promise.all(groups.map(publicCase));
  return { cases: cases.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

async function createUpload(event) {
  const { contentType, size } = parseBody(event);
  if (contentType !== UPLOAD_TYPE) throw new HttpError(400, 'La fotografía debe enviarse en formato JPEG.');
  if (!Number.isInteger(size) || size < 1 || size > MAX_PHOTO_BYTES)
    throw new HttpError(400, 'La fotografía es demasiado grande. Elige otra.');
  const key = `uploads/${randomUUID()}.jpg`;
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: BUCKET_NAME,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_PHOTO_BYTES],
      ['eq', '$Content-Type', UPLOAD_TYPE],
    ],
    Fields: { 'Content-Type': UPLOAD_TYPE },
    Expires: 300,
  });
  return { key, url, fields };
}

/** Lee una foto subida y calcula sus huellas. Falla si no es un JPEG válido. */
async function inspectUpload(key) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key })).catch(() => null);
  if (!obj || obj.ContentLength > MAX_PHOTO_BYTES || obj.ContentType !== UPLOAD_TYPE)
    throw new HttpError(400, 'Las fotografías no son válidas. Vuelve a subirlas.');
  const buffer = Buffer.from(await obj.Body.transformToByteArray());
  try {
    return { sha256: sha256(buffer), ...perceptualHash(buffer) };
  } catch {
    throw new HttpError(400, 'No pudimos leer una de las fotografías. Intenta con otra imagen.');
  }
}

async function createReport(event) {
  const body = parseBody(event);
  const contact = body.contact || {};
  const photoKeys = Array.isArray(body.photoKeys) ? body.photoKeys : [];
  const draft = {
    category: body.category,
    detail: body.detail,
    location: { lat: Number(body.lat), lng: Number(body.lng) },
    description: typeof body.description === 'string' ? body.description : '',
    photos: photoKeys,
    firstName: contact.firstName,
    lastName: contact.lastName,
    phone: contact.phone,
    relation: contact.relation,
    sector: contact.sector,
    consent: body.consent === true,
  };
  const error = validateReport(draft);
  if (error) throw new HttpError(400, error);
  if (new Set(photoKeys).size !== photoKeys.length || photoKeys.length > MAX_PHOTOS || !photoKeys.every((k) => UPLOAD_KEY_RE.test(k)))
    throw new HttpError(400, 'Las fotografías no son válidas. Vuelve a subirlas.');

  // Huellas calculadas en el servidor (no se confía en las que pudiera mandar el teléfono).
  const photoHashes = [];
  for (const key of photoKeys) photoHashes.push(await inspectUpload(key));

  const id = `AFM-${shortId()}`;
  const now = new Date().toISOString();
  const location = {
    lat: Math.round(draft.location.lat * 1e6) / 1e6,
    lng: Math.round(draft.location.lng * 1e6) / 1e6,
  };

  // ¿Es la misma foto de un caso ya registrado? → se suma a ese ticket.
  let match = null;
  for (const other of await queryType('REPORT')) {
    const cmp = comparePhotos(photoHashes, other.photoHashes);
    if (!isSamePhoto(cmp, distanceMeters(location, other))) continue;
    const score = cmp.exact ? -1 : cmp.distance;
    if (!match || score < match.score) match = { score, report: other, reason: cmp.exact ? 'foto-identica' : 'foto-similar' };
  }
  const ticketId = match ? match.report.ticketId : await newTicket(id, now);

  const finalKeys = photoKeys.map((_, i) => `reports/${id}/${i + 1}.jpg`);
  for (const [i, key] of photoKeys.entries()) {
    await s3.send(new CopyObjectCommand({ Bucket: BUCKET_NAME, CopySource: `${BUCKET_NAME}/${key}`, Key: finalKeys[i] }));
  }
  await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET_NAME, Delete: { Objects: photoKeys.map((Key) => ({ Key })) } }));

  const addressParts = {
    street: str(body.addressParts?.street, 120),
    number: str(body.addressParts?.number, 20),
    neighborhood: str(body.addressParts?.neighborhood, 100),
  };
  const deleteToken = randomBytes(32).toString('base64url');
  const item = {
    ...reportKey(id),
    GSI1PK: 'REPORT',
    GSI1SK: `${now}#${id}`,
    type: 'report',
    id,
    ticketId,
    dupReason: match?.reason,
    dupOf: match?.report.id,
    category: draft.category,
    detail: draft.detail,
    ...location,
    addressParts,
    address: [[addressParts.street, addressParts.number].filter(Boolean).join(' '), addressParts.neighborhood]
      .filter(Boolean)
      .join(', '),
    description: draft.description.trim(),
    photoKeys: finalKeys,
    photoHashes,
    createdAt: now,
    flagCount: 0,
    deleteTokenHash: sha256(deleteToken),
    contact: {
      firstName: str(contact.firstName, 80),
      lastName: str(contact.lastName, 80),
      phone: `+56${String(contact.phone).replace(/\s/g, '')}`,
      relation: contact.relation,
      sector: contact.sector,
      consentAt: now,
      termsVersion: TERMS_VERSION,
    },
  };
  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
  // Al vecino no se le informa si su reporte se unió a un caso existente.
  return { status: 201, body: { report: await publicReport(item), deleteToken } };
}

async function deleteOwnReport(event, id) {
  const report = await getReport(id);
  const token = event.headers?.['x-delete-token'] || event.headers?.['X-Delete-Token'] || '';
  const a = Buffer.from(sha256(token), 'hex');
  const b = Buffer.from(report.deleteTokenHash || '', 'hex');
  if (!token || a.length !== b.length || !timingSafeEqual(a, b))
    throw new HttpError(403, 'No puedes eliminar este reporte desde este navegador.');
  await deleteReportCompletely(report);
  return { status: 204 };
}

async function createFlag(event, reportId) {
  const body = parseBody(event);
  if (!FLAG_REASONS.includes(body.reason)) throw new HttpError(400, 'Selecciona un motivo válido.');
  await getReport(reportId);
  const flag = {
    PK: `REPORT#${reportId}`,
    SK: `FLAG#AVISO-${shortId()}`,
    GSI1PK: 'FLAG',
    type: 'flag',
    reportId,
    reason: body.reason,
    note: str(body.note, 500),
    createdAt: new Date().toISOString(),
    status: 'open',
  };
  flag.id = flag.SK.slice(5);
  flag.GSI1SK = `${flag.createdAt}#${flag.id}`;
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: flag, ConditionExpression: 'attribute_not_exists(PK)' } },
        {
          Update: {
            TableName: TABLE_NAME,
            Key: reportKey(reportId),
            UpdateExpression: 'ADD flagCount :one',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
      ],
    }),
  );
  return { status: 201, body: { flag: { id: flag.id, reportId, reason: flag.reason, createdAt: flag.createdAt } } };
}

// ---------- Rutas de moderación ----------
/** Sugerencias de «posible duplicado» entre tickets distintos (el moderador decide). */
function suggestionsFor(group, groups) {
  const out = [];
  for (const other of groups) {
    if (other.ticketId === group.ticketId) continue;
    let best = null;
    for (const a of group.reports) {
      for (const b of other.reports) {
        const meters = distanceMeters(a, b);
        const cmp = comparePhotos(a.photoHashes, b.photoHashes);
        let reason = null;
        if (cmp.exact || (cmp.reliable && cmp.distance <= DUP_HASH_MAX_DISTANCE)) reason = 'foto parecida';
        else if (a.category === b.category && meters <= DUP_SUGGEST_MAX_METERS) reason = 'misma categoría y lugar cercano';
        if (reason && (!best || meters < best.meters)) best = { ticketId: other.ticketId, reason, meters: Math.round(meters) };
      }
    }
    if (best) out.push(best);
  }
  return out.sort((a, b) => a.meters - b.meters);
}

async function adminListTickets() {
  const groups = groupByTicket(await queryType('REPORT'));
  const tickets = await Promise.all(
    groups.map(async (g) => ({
      id: g.ticketId,
      category: g.primary.category,
      detail: g.primary.detail,
      lat: g.primary.lat,
      lng: g.primary.lng,
      address: g.primary.address,
      addressParts: g.primary.addressParts,
      createdAt: g.primary.createdAt,
      updatedAt: g.reports.at(-1).createdAt,
      reportCount: g.reports.length,
      reports: await Promise.all(g.reports.map(adminReport)),
      suggestions: suggestionsFor(g, groups),
    })),
  );
  return { tickets: tickets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
}

const flagView = ({ id, reportId, reason, note, createdAt, status, resolvedAt, resolvedBy }) => ({
  id, reportId, reason, note, createdAt, status, resolvedAt, resolvedBy,
});

async function adminListFlags() {
  const items = await queryType('FLAG');
  return { flags: items.sort(byDate).reverse().map(flagView) };
}

async function adminDeleteReport(id) {
  await deleteReportCompletely(await getReport(id));
  return { status: 204 };
}

/** Une el ticket `from` dentro de `into`: todos sus reportes pasan al otro caso. */
async function adminMergeTicket(event, from, moderator) {
  const into = String(parseBody(event).into || '').trim().toUpperCase();
  if (!TICKET_ID_RE.test(from) || !TICKET_ID_RE.test(into)) throw new HttpError(400, 'Número de ticket no válido (ej. T-0042).');
  if (from === into) throw new HttpError(400, 'No puedes unir un ticket consigo mismo.');
  const reports = await queryType('REPORT');
  const moving = reports.filter((r) => r.ticketId === from);
  if (!moving.length) throw new HttpError(404, `El ticket ${from} no existe o no tiene reportes.`);
  if (!reports.some((r) => r.ticketId === into)) throw new HttpError(404, `El ticket ${into} no existe o no tiene reportes.`);
  const now = new Date().toISOString();
  for (const r of moving) {
    await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: reportKey(r.id),
        UpdateExpression: 'SET ticketId = :into, dupReason = :manual, ticketChangedBy = :by, ticketChangedAt = :at REMOVE dupOf',
        ConditionExpression: 'ticketId = :from',
        ExpressionAttributeValues: { ':into': into, ':from': from, ':manual': 'manual', ':by': moderator, ':at': now },
      }),
    );
  }
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TICKET#${from}`, SK: 'META' },
      UpdateExpression: 'SET mergedInto = :into, mergedBy = :by, mergedAt = :at',
      ExpressionAttributeValues: { ':into': into, ':by': moderator, ':at': now },
    }),
  );
  return { merged: from, into, reports: moving.length };
}

/** Saca un reporte de su ticket y lo deja como caso nuevo (para corregir una unión equivocada). */
async function adminDetachReport(id, moderator) {
  const report = await getReport(id);
  const now = new Date().toISOString();
  const ticketId = await newTicket(id, now);
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: reportKey(id),
      UpdateExpression: 'SET ticketId = :t, ticketChangedBy = :by, ticketChangedAt = :at REMOVE dupReason, dupOf',
      ExpressionAttributeValues: { ':t': ticketId, ':by': moderator, ':at': now },
    }),
  );
  return { report: report.id, ticketId };
}

async function adminResolveFlag(event, reportId, flagId, moderator) {
  const body = parseBody(event);
  if (body.status !== 'resolved') throw new HttpError(400, 'Estado no válido.');
  if (!REPORT_ID_RE.test(reportId) || !FLAG_ID_RE.test(flagId)) throw new HttpError(404, 'El aviso no existe.');
  try {
    const { Attributes } = await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `REPORT#${reportId}`, SK: `FLAG#${flagId}` },
        UpdateExpression: 'SET #s = :s, resolvedAt = :at, resolvedBy = :by',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':s': 'resolved', ':at': new Date().toISOString(), ':by': moderator },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return { flag: flagView(Attributes) };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') throw new HttpError(404, 'El aviso no existe.');
    throw err;
  }
}


// ---------- Visitas a terreno (/equipo) ----------
// El equipo usa un código compartido. Solo se guarda su huella scrypt en Parameter Store
// (parámetro TEAM_CODE_PARAM, formato "scrypt$N$sal$huella"); el código nunca está en el código fuente.
const VISIT_ID_RE = /^V-[0-9A-F]{8}$/;
let teamHashCache = { value: null, at: 0 };

async function teamCodeHash() {
  if (Date.now() - teamHashCache.at < 5 * 60 * 1000) return teamHashCache.value;
  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({ Name: TEAM_CODE_PARAM }));
    teamHashCache = { value: Parameter?.Value || null, at: Date.now() };
  } catch (err) {
    if (err.name !== 'ParameterNotFound') throw err;
    teamHashCache = { value: null, at: Date.now() };
  }
  return teamHashCache.value;
}

// Límite propio contra intentos de adivinar el código (el throttling de API Gateway es solo aproximado):
// máximo TEAM_MAX_FAILS fallos por IP en una ventana de 10 minutos. Los contadores expiran solos (TTL).
const TEAM_MAX_FAILS = 10;
const TEAM_WINDOW_MS = 10 * 60 * 1000;

function failKey(event) {
  const ip = event.requestContext?.identity?.sourceIp || 'desconocida';
  const windowStart = Math.floor(Date.now() / TEAM_WINDOW_MS) * TEAM_WINDOW_MS;
  return { key: { PK: `RATELIMIT#team#${ip}`, SK: String(windowStart) }, expiresAt: Math.floor((windowStart + 2 * TEAM_WINDOW_MS) / 1000) };
}

async function requireTeamCode(event) {
  const { key, expiresAt } = failKey(event);
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: key }));
  if ((Item?.fails || 0) >= TEAM_MAX_FAILS)
    throw new HttpError(429, 'Demasiados intentos fallidos. Espera 10 minutos e inténtalo de nuevo.');

  const code = String(event.headers?.['x-team-code'] || event.headers?.['X-Team-Code'] || '').trim().toUpperCase();
  const stored = await teamCodeHash();
  if (!stored) throw new HttpError(503, 'El formulario del equipo aún no está habilitado.');
  const [algo, n, salt, hash] = stored.split('$');
  let ok = false;
  if (algo === 'scrypt' && code && code.length <= 64) {
    const expected = Buffer.from(hash, 'base64');
    const actual = scryptSync(code, Buffer.from(salt, 'base64'), expected.length, { N: Number(n) });
    ok = timingSafeEqual(actual, expected);
  }
  if (!ok) {
    await db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: key,
        UpdateExpression: 'ADD fails :one SET expiresAt = :exp',
        ExpressionAttributeValues: { ':one': 1, ':exp': expiresAt },
      }),
    );
    throw new HttpError(401, 'Código del equipo incorrecto.');
  }
}

async function teamCheck(event) {
  await requireTeamCode(event);
  return { ok: true };
}

async function createVisit(event) {
  await requireTeamCode(event);
  const body = parseBody(event);
  const draft = {
    firstName: body.firstName,
    lastNames: body.lastNames,
    phone: body.phone,
    address: body.address,
    role: body.role,
    commitment: body.commitment,
    visitDate: body.visitDate,
    registeredBy: body.registeredBy,
    location: body.location && body.location.lat != null ? { lat: Number(body.location.lat), lng: Number(body.location.lng) } : null,
  };
  // Margen de un día por diferencias de zona horaria entre el teléfono y el servidor.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const error = validateVisit(draft, { today: tomorrow });
  if (error) throw new HttpError(400, error);
  const visit = normalizeVisit(draft);
  const id = `V-${shortId()}`;
  const createdAt = new Date().toISOString();
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `VISIT#${id}`, SK: 'META', GSI1PK: 'VISIT', GSI1SK: `${visit.visitDate}#${createdAt}#${id}`, type: 'visit',
        id, ...visit, createdAt,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  return { status: 201, body: { visit: { id, visitDate: visit.visitDate, createdAt } } };
}

const visitView = ({ id, firstName, lastNames, phone, address, role, commitment, visitDate, registeredBy, location, createdAt }) => ({
  id, firstName, lastNames, phone, address, role, commitment, visitDate, registeredBy, location, createdAt,
});

async function adminListVisits() {
  const items = await queryType('VISIT');
  return { visits: items.map(visitView).sort((a, b) => b.visitDate.localeCompare(a.visitDate) || b.createdAt.localeCompare(a.createdAt)) };
}

async function adminDeleteVisit(id) {
  if (!VISIT_ID_RE.test(id || '')) throw new HttpError(404, 'La visita no existe.');
  try {
    await db.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { PK: `VISIT#${id}`, SK: 'META' }, ConditionExpression: 'attribute_exists(PK)' }),
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') throw new HttpError(404, 'La visita no existe.');
    throw err;
  }
  return { status: 204 };
}

// ---------- Enrutador ----------
async function route(event) {
  const method = event.httpMethod;
  const parts = (event.path || '').split('/').filter(Boolean).map(decodeURIComponent);
  const is = (m, len) => method === m && parts.length === len;

  if (parts[0] === 'reports') {
    if (is('GET', 1)) return listCases();
    if (is('POST', 1)) return createReport(event);
    if (is('DELETE', 2)) return deleteOwnReport(event, parts[1]);
    if (is('POST', 3) && parts[2] === 'flags') return createFlag(event, parts[1]);
  }
  if (parts[0] === 'uploads' && is('POST', 1)) return createUpload(event);
  if (parts[0] === 'team') {
    if (is('POST', 2) && parts[1] === 'check') return teamCheck(event);
    if (is('POST', 2) && parts[1] === 'visits') return createVisit(event);
  }
  if (parts[0] === 'admin') {
    const moderator = requireModerator(event);
    if (parts[1] === 'tickets') {
      if (is('GET', 2)) return adminListTickets();
      if (is('POST', 4) && parts[3] === 'merge') return adminMergeTicket(event, parts[2], moderator);
    }
    if (parts[1] === 'reports') {
      if (is('DELETE', 3)) return adminDeleteReport(parts[2]);
      if (is('POST', 4) && parts[3] === 'detach') return adminDetachReport(parts[2], moderator);
      if (is('PATCH', 5) && parts[3] === 'flags') return adminResolveFlag(event, parts[2], parts[4], moderator);
    }
    if (parts[1] === 'flags' && is('GET', 2)) return adminListFlags();
    if (parts[1] === 'visits') {
      if (is('GET', 2)) return adminListVisits();
      if (is('DELETE', 3)) return adminDeleteVisit(parts[2]);
    }
  }
  throw new HttpError(404, 'Ruta no encontrada.');
}

/** Solo para pruebas locales. */
export const _test = { perceptualHash, hammingDistance, comparePhotos, isSamePhoto };

export async function handler(event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(event) };
  try {
    const result = await route(event);
    const status = result?.status || 200;
    const body = result?.status ? result.body : result;
    return { statusCode: status, headers, body: status === 204 ? '' : JSON.stringify(body) };
  } catch (err) {
    if (err instanceof HttpError) {
      return { statusCode: err.status, headers, body: JSON.stringify({ message: err.message }) };
    }
    console.error(JSON.stringify({ level: 'error', message: err.message, name: err.name, path: event.path }));
    return { statusCode: 500, headers, body: JSON.stringify({ message: 'Error interno. Inténtalo más tarde.' }) };
  }
}
