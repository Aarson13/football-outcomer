/**
 * worker/api.js — the sync service behind the app, as platform-free as possible so it runs on
 * Cloudflare Pages Functions and can be exercised locally with the D1 binding Miniflare provides.
 *
 * Model, deliberately the smallest one that can be trusted with a season of predictions:
 *
 *   POST /api/spaces          claim a space → { spaceId, key }. The key is returned once and only
 *                             its SHA-256 is stored, so the server cannot read a space back out.
 *   GET  /api/doc             read the document. Requires the key.
 *   PUT  /api/doc             write it, conditional on the revision the client read.
 *
 * A write that names a stale revision answers 409 with the winning document attached, so two
 * devices can never silently clobber each other: the loser merges and retries once.
 *
 * CORS is same-origin only. The app is served from the same Pages project as this route, so a
 * foreign Origin is somebody else's page trying to spend a visitor's key.
 */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

const MAX_DOC_BYTES = 1_000_000; // a prediction log never approaches this; a mistake should fail loudly

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });

const fail = (status, error, extra = {}) => json({ error, ...extra }, status);

function randomToken(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashKey(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS spaces (
         id TEXT PRIMARY KEY,
         key_hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS docs (
         space_id TEXT PRIMARY KEY,
         rev INTEGER NOT NULL,
         doc TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    ),
  ]);
  schemaReady = true;
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin navigations and curl carry no Origin
  try {
    const url = new URL(request.url);
    const o = new URL(origin);
    if (o.host === url.host) return true;
    // Local development: the Vite/wrangler dev server and the worker listen on different ports.
    const local = (h) => ['localhost', '127.0.0.1', '[::1]'].includes(h);
    return local(o.hostname) && local(url.hostname);
  } catch {
    return false;
  }
}

function creds(request) {
  const spaceId = request.headers.get('x-space-id');
  const key = request.headers.get('x-space-key');
  if (!spaceId || !key) return null;
  return { spaceId, key };
}

async function authorize(db, request) {
  const c = creds(request);
  if (!c) return { error: fail(401, 'missing-credentials', { message: 'This device has no space key yet.' }) };
  const row = await db
    .prepare('SELECT id, key_hash FROM spaces WHERE id = ?')
    .bind(c.spaceId)
    .first();
  if (!row) return { error: fail(404, 'unknown-space', { message: 'That space does not exist.' }) };
  const hash = await hashKey(c.key);
  if (hash.length !== row.key_hash.length) return { error: fail(403, 'bad-key') };
  let diff = 0;
  for (let i = 0; i < hash.length; i += 1) diff |= hash.charCodeAt(i) ^ row.key_hash.charCodeAt(i);
  if (diff !== 0) return { error: fail(403, 'bad-key', { message: 'The space key is wrong.' }) };
  return { spaceId: c.spaceId };
}

export async function handleApi(request, env) {
  const db = env?.DB;
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '');

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET,PUT,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,x-space-id,x-space-key',
        'access-control-max-age': '86400',
      },
    });
  }

  if (!sameOrigin(request)) return fail(403, 'origin', { message: 'Cross-origin writes are refused.' });

  if (route === 'health') {
    return json({ ok: true, db: Boolean(db), time: new Date().toISOString() });
  }

  if (!db) {
    return fail(503, 'no-database', {
      message: 'The D1 binding (DB) is not attached to this deployment.',
    });
  }

  await ensureSchema(db);

  if (route === 'spaces' && request.method === 'POST') {
    const id = randomToken(6); // 12 hex chars
    const key = randomToken(16); // 32 hex chars
    const now = new Date().toISOString();
    await db
      .prepare('INSERT INTO spaces (id, key_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(id, await hashKey(key), now, now)
      .run();
    return json({ spaceId: id, key, rev: 0 }, 201);
  }

  if (route === 'doc') {
    const auth = await authorize(db, request);
    if (auth.error) return auth.error;

    if (request.method === 'GET') {
      const row = await db
        .prepare('SELECT rev, doc, updated_at FROM docs WHERE space_id = ?')
        .bind(auth.spaceId)
        .first();
      if (!row) return json({ rev: 0, doc: null, updatedAt: null });
      return json({ rev: row.rev, doc: JSON.parse(row.doc), updatedAt: row.updated_at });
    }

    if (request.method === 'PUT') {
      let body;
      try {
        body = await request.json();
      } catch {
        return fail(400, 'bad-json');
      }
      const doc = body?.doc;
      const baseRev = Number.isInteger(body?.rev) ? body.rev : 0;
      if (!doc || typeof doc !== 'object') return fail(400, 'bad-doc');
      const text = JSON.stringify(doc);
      if (text.length > MAX_DOC_BYTES) return fail(413, 'too-large');

      const current = await db
        .prepare('SELECT rev, doc FROM docs WHERE space_id = ?')
        .bind(auth.spaceId)
        .first();
      const currentRev = current?.rev ?? 0;
      if (baseRev !== currentRev) {
        return json(
          {
            error: 'conflict',
            message: 'Another device wrote first.',
            rev: currentRev,
            doc: current ? JSON.parse(current.doc) : null,
          },
          409,
        );
      }

      const nextRev = currentRev + 1;
      const now = new Date().toISOString();
      if (current) {
        await db
          .prepare('UPDATE docs SET rev = ?, doc = ?, updated_at = ? WHERE space_id = ? AND rev = ?')
          .bind(nextRev, text, now, auth.spaceId, currentRev)
          .run();
      } else {
        await db
          .prepare('INSERT INTO docs (space_id, rev, doc, updated_at) VALUES (?, ?, ?, ?)')
          .bind(auth.spaceId, nextRev, text, now)
          .run();
      }
      await db
        .prepare('UPDATE spaces SET updated_at = ? WHERE id = ?')
        .bind(now, auth.spaceId)
        .run();
      return json({ rev: nextRev, updatedAt: now });
    }
  }

  return fail(404, 'not-found', { message: `No route for ${request.method} /api/${route}` });
}
