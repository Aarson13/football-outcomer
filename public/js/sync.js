/**
 * sync.js — where the prediction log lives.
 *
 * Two interchangeable targets, both pull-before-write so the stored copy is the source of truth:
 *
 *   CloudSync   the site's own Cloudflare D1 database (the default). A "space" is a 12-character
 *               id plus a 32-character key; the key is the only credential, the server keeps only
 *               its SHA-256, and `rev` makes every write conditional.
 *   GithubSync  one JSON file in a repository you own, through the Contents API. Every save is a
 *               commit, so git history doubles as an audit trail and an undo button.
 *
 * Nothing is cached on the device beyond the space key (and the GitHub token, if you tick the
 * box). If a write fails the entry stays in memory, flagged unsaved, and the chip turns red.
 */

const SPACE_KEY = 'fo.space.v1';
const GITHUB_KEY = 'fo.github.v1';

export const emptyDoc = () => ({
  app: 'football-outcomer',
  version: 1,
  updatedAt: new Date().toISOString(),
  entries: [],
});

export function loadSpace() {
  try {
    return JSON.parse(localStorage.getItem(SPACE_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveSpace(space) {
  if (space) localStorage.setItem(SPACE_KEY, JSON.stringify(space));
  else localStorage.removeItem(SPACE_KEY);
}

export function loadGithubConfig() {
  try {
    return JSON.parse(localStorage.getItem(GITHUB_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveGithubConfig(config) {
  if (config) localStorage.setItem(GITHUB_KEY, JSON.stringify(config));
  else localStorage.removeItem(GITHUB_KEY);
}

/** Union two documents by entry id; a resolved result or the newer edit wins. */
export function mergeDocs(a, b) {
  const left = a?.entries ?? [];
  const right = b?.entries ?? [];
  const byId = new Map();
  for (const entry of [...left, ...right]) {
    if (!entry?.id) continue;
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    const pick = (entry.result && !existing.result) ||
      (!(existing.result && !entry.result) &&
        String(entry.updatedAt ?? entry.createdAt ?? '') > String(existing.updatedAt ?? existing.createdAt ?? ''))
      ? entry
      : existing;
    byId.set(entry.id, pick);
  }
  const entries = [...byId.values()].sort((x, y) =>
    String(y.createdAt ?? '').localeCompare(String(x.createdAt ?? '')),
  );
  const newer = String(a?.updatedAt ?? '') > String(b?.updatedAt ?? '') ? a : b;
  return {
    ...emptyDoc(),
    ...(a?.settings ? { settings: a.settings } : {}),
    ...(newer ?? {}),
    entries,
    updatedAt: new Date().toISOString(),
  };
}

class Conflict extends Error {
  constructor(remote, rev) {
    super('conflict');
    this.remote = remote;
    this.rev = rev;
  }
}

/* ------------------------------------------------------------------ Cloudflare D1 */

export class CloudSync {
  constructor(space) {
    this.space = space;
    this.kind = 'cloud';
  }

  static async claim() {
    const res = await fetch('/api/spaces', { method: 'POST' });
    if (!res.ok) throw new Error(`could not claim a space (${res.status})`);
    const body = await res.json();
    const space = { spaceId: body.spaceId, key: body.key };
    saveSpace(space);
    return new CloudSync(space);
  }

  headers() {
    return { 'x-space-id': this.space.spaceId, 'x-space-key': this.space.key };
  }

  async pull() {
    const res = await fetch('/api/doc', { headers: this.headers() });
    if (res.status === 404) {
      // Space is gone from the database; start a fresh one rather than writing into the void.
      throw new Error('space-not-found');
    }
    if (res.status === 403) throw new Error('This device’s space key was rejected. Check Settings.');
    if (!res.ok) throw new Error(`pull failed (${res.status})`);
    const body = await res.json();
    return { doc: body.doc ?? null, rev: body.rev ?? 0 };
  }

  async push(doc, rev) {
    const res = await fetch('/api/doc', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({ rev, doc }),
    });
    if (res.status === 409) {
      const body = await res.json();
      throw new Conflict(body.doc, body.rev);
    }
    if (res.status === 413) throw new Error('The document is too large for the sync service.');
    if (!res.ok) throw new Error(`save failed (${res.status})`);
    const body = await res.json();
    return { rev: body.rev };
  }

  label() {
    return `Cloudflare DB · space ${this.space.spaceId}`;
  }
}

/* ------------------------------------------------------------------ GitHub file */

const utf8ToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => {
    binary += String.fromCharCode(b);
  });
  return btoa(binary);
};

const base64ToUtf8 = (b64) => {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

export class GithubSync {
  constructor(config) {
    this.config = config;
    this.kind = 'github';
  }

  api(path) {
    const { owner, repo } = this.config;
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  }

  headers() {
    return {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${this.config.token}`,
      'x-github-api-version': '2022-11-28',
    };
  }

  async errorFor(res, action) {
    if (res.status === 401) return new Error('GitHub rejected the token (401). Check the token and its Contents permission.');
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      if (/rate limit/i.test(body.message ?? '')) return new Error('GitHub rate limit reached; syncing pauses until it resets.');
      return new Error('GitHub refused the request (403). The token needs Contents: read and write on this repository.');
    }
    if (res.status === 404) return new Error(`Repository or file not found while trying to ${action}.`);
    return new Error(`GitHub ${action} failed (${res.status}).`);
  }

  async pull() {
    const branch = this.config.branch || 'main';
    const res = await fetch(`${this.api(this.config.path)}?ref=${encodeURIComponent(branch)}`, { headers: this.headers() });
    if (res.status === 404) return { doc: null, rev: null }; // first run
    if (!res.ok) throw await this.errorFor(res, 'read');
    const body = await res.json();
    let text;
    if (body.content) text = base64ToUtf8(body.content);
    else if (body.download_url) {
      const raw = await fetch(body.download_url);
      if (!raw.ok) throw new Error('The file is too large to read through the API.');
      text = await raw.text();
    } else text = '{}';
    try {
      return { doc: JSON.parse(text), rev: body.sha };
    } catch {
      throw new Error('That file is not valid JSON, so it was left untouched.');
    }
  }

  async push(doc, rev) {
    const branch = this.config.branch || 'main';
    const res = await fetch(this.api(this.config.path), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify({
        message: 'Update prediction log',
        content: utf8ToBase64(JSON.stringify(doc, null, 2)),
        branch,
        ...(rev ? { sha: rev } : {}),
      }),
    });
    if (res.status === 409) {
      const failBody = await res.json().catch(() => ({}));
      const latest = await this.pull().catch(() => ({ doc: null, rev: null }));
      throw new Conflict(latest.doc, latest.rev, failBody.message);
    }
    if (!res.ok) throw await this.errorFor(res, 'write');
    const body = await res.json();
    return { rev: body.content?.sha };
  }

  label() {
    return `GitHub · ${this.config.owner}/${this.config.repo}/${this.config.path}`;
  }

  static valid(config) {
    return Boolean(
      config && config.owner && config.repo && config.path && config.token &&
      /^[\w.-]+$/.test(config.owner) && /^[\w.-]+$/.test(config.repo),
    );
  }
}

/* ------------------------------------------------------------------ shared behaviour */

/**
 * Read the stored document, apply a change, write it back. On a lost race the winner's document
 * is merged in and the change retried once — never a silent overwrite.
 */
export async function commit(backend, localDoc, mutate) {
  const attempt = async (retry) => {
    const remote = await backend.pull();
    const base = mergeDocs(remote.doc, localDoc);
    const next = mutate(base);
    next.updatedAt = new Date().toISOString();
    try {
      const { rev } = await backend.push(next, remote.rev);
      return { doc: next, rev, remote: false };
    } catch (err) {
      if (err instanceof Conflict && retry) {
        const merged = mergeDocs(err.remote, next);
        const second = mutate(merged);
        second.updatedAt = new Date().toISOString();
        const { rev } = await backend.push(second, err.rev);
        return { doc: second, rev, remote: true };
      }
      throw err;
    }
  };
  return attempt(true);
}

/** Pull for display, without changing anything. */
export async function refresh(backend, localDoc) {
  const remote = await backend.pull();
  return mergeDocs(remote.doc, localDoc);
}
