// API REST de AFM (detrás de API Gateway). Una sola función con un enrutador simple.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  CopyObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

import {
  FLAG_REASONS, MAX_PHOTO_BYTES, MAX_PHOTOS, PHOTO_TYPES, TERMS_VERSION, validateReport,
} from '../../../shared/rules.js';

const { TABLE_NAME, BUCKET_NAME, ALLOWED_ORIGINS = '', ADMIN_GROUP = 'moderadores' } = process.env;
const origins = ALLOWED_ORIGINS.split(',').filter(Boolean);
const s3 = new S3Client({});
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const UPLOAD_KEY_RE = /^uploads\/[0-9a-f-]{36}\.(jpg|png|webp)$/;
const REPORT_ID_RE = /^AFM-[0-9A-F]{8}$/;
const FLAG_ID_RE = /^AVISO-[0-9A-F]{8}$/;
const PHOTO_URL_TTL = 3600; // segundos
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Utilidades ----------
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const str = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  return origin && origins.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
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

const photoUrls = (keys = []) =>
  Promise.all(
    keys.map(async (key) => ({
      url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: key }), { expiresIn: PHOTO_URL_TTL }),
    })),
  );

/** Vista pública: sin datos de contacto ni token. */
async function publicView(item) {
  return {
    id: item.id,
    category: item.category,
    detail: item.detail,
    lat: item.lat,
    lng: item.lng,
    address: item.address,
    addressParts: item.addressParts,
    description: item.description,
    createdAt: item.createdAt,
    photos: await photoUrls(item.photoKeys),
  };
}

async function adminView(item) {
  return { ...(await publicView(item)), contact: item.contact, flagCount: item.flagCount || 0 };
}

const reportKey = (id) => ({ PK: `REPORT#${id}`, SK: 'META' });

async function getReport(id) {
  if (!REPORT_ID_RE.test(id || '')) throw new HttpError(404, 'El reporte no existe.');
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: reportKey(id) }));
  if (!Item) throw new HttpError(404, 'El reporte no existe.');
  return Item;
}

/** Borra el reporte, sus avisos y sus fotos. */
async function deleteReportCompletely(report) {
  const items = await queryAll({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: { ':pk': `REPORT#${report.id}` },
    ProjectionExpression: 'PK, SK',
  });
  for (let i = 0; i < items.length; i += 25) {
    await db.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: items.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: { PK: k.PK, SK: k.SK } } })),
        },
      }),
    );
  }
  if (report.photoKeys?.length) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: report.photoKeys.map((Key) => ({ Key })) },
      }),
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
async function listReports() {
  const items = await queryAll({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :t',
    ExpressionAttributeValues: { ':t': 'REPORT' },
    ScanIndexForward: false,
  });
  return { reports: await Promise.all(items.map(publicView)) };
}

async function createUpload(event) {
  const { contentType, size } = parseBody(event);
  if (!PHOTO_TYPES.includes(contentType)) throw new HttpError(400, 'Usa una foto JPG, PNG o WebP.');
  if (!Number.isInteger(size) || size < 1 || size > MAX_PHOTO_BYTES)
    throw new HttpError(400, 'La fotografía supera los 5 MB. Elige una más pequeña.');
  const key = `uploads/${randomUUID()}.${EXT[contentType]}`;
  const { url, fields } = await createPresignedPost(s3, {
    Bucket: BUCKET_NAME,
    Key: key,
    Conditions: [
      ['content-length-range', 1, MAX_PHOTO_BYTES],
      ['eq', '$Content-Type', contentType],
    ],
    Fields: { 'Content-Type': contentType },
    Expires: 300,
  });
  return { key, url, fields };
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

  // Verifica que las fotos se hayan subido de verdad y cumplan los límites.
  for (const key of photoKeys) {
    const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: key })).catch(() => null);
    if (!head || head.ContentLength > MAX_PHOTO_BYTES || !PHOTO_TYPES.includes(head.ContentType))
      throw new HttpError(400, 'Las fotografías no son válidas. Vuelve a subirlas.');
  }

  const id = `AFM-${shortId()}`;
  const now = new Date().toISOString();
  const finalKeys = photoKeys.map((key, i) => `reports/${id}/${i + 1}.${key.split('.').pop()}`);
  for (const [i, key] of photoKeys.entries()) {
    await s3.send(
      new CopyObjectCommand({ Bucket: BUCKET_NAME, CopySource: `${BUCKET_NAME}/${key}`, Key: finalKeys[i] }),
    );
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
    category: draft.category,
    detail: draft.detail,
    lat: Math.round(draft.location.lat * 1e6) / 1e6,
    lng: Math.round(draft.location.lng * 1e6) / 1e6,
    addressParts,
    address: [[addressParts.street, addressParts.number].filter(Boolean).join(' '), addressParts.neighborhood]
      .filter(Boolean)
      .join(', '),
    description: draft.description.trim(),
    photoKeys: finalKeys,
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
  await db.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE_NAME, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } },
      ],
    }),
  );
  return { status: 201, body: { report: await publicView(item), deleteToken } };
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
async function adminListReports() {
  const items = await queryAll({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :t',
    ExpressionAttributeValues: { ':t': 'REPORT' },
    ScanIndexForward: false,
  });
  return { reports: await Promise.all(items.map(adminView)) };
}

const flagView = ({ id, reportId, reason, note, createdAt, status, resolvedAt, resolvedBy }) => ({
  id, reportId, reason, note, createdAt, status, resolvedAt, resolvedBy,
});

async function adminListFlags() {
  const items = await queryAll({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :t',
    ExpressionAttributeValues: { ':t': 'FLAG' },
    ScanIndexForward: false,
  });
  return { flags: items.map(flagView) };
}

async function adminDeleteReport(id) {
  await deleteReportCompletely(await getReport(id));
  return { status: 204 };
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

// ---------- Enrutador ----------
async function route(event) {
  const method = event.httpMethod;
  const parts = (event.path || '').split('/').filter(Boolean).map(decodeURIComponent);
  const is = (m, len) => method === m && parts.length === len;

  if (parts[0] === 'reports') {
    if (is('GET', 1)) return listReports();
    if (is('POST', 1)) return createReport(event);
    if (is('DELETE', 2)) return deleteOwnReport(event, parts[1]);
    if (is('POST', 3) && parts[2] === 'flags') return createFlag(event, parts[1]);
  }
  if (parts[0] === 'uploads' && is('POST', 1)) return createUpload(event);
  if (parts[0] === 'admin') {
    const moderator = requireModerator(event);
    if (parts[1] === 'reports') {
      if (is('GET', 2)) return adminListReports();
      if (is('DELETE', 3)) return adminDeleteReport(parts[2]);
      if (is('PATCH', 5) && parts[3] === 'flags') return adminResolveFlag(event, parts[2], parts[4], moderator);
    }
    if (parts[1] === 'flags' && is('GET', 2)) return adminListFlags();
  }
  throw new HttpError(404, 'Ruta no encontrada.');
}

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
