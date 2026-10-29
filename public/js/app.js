/**
 * app.js — the page. One state object, plain render functions, and no framework.
 *
 * The document (the prediction log) lives in the sync target, never in the device: every save
 * pulls, applies the change to what came back, and pushes. The in-memory copy is only a cache for
 * rendering, which is why a failed write is shouted about instead of swallowed.
 */
import { predict, scorePrediction, MODEL_VERSION } from './model.js';
import {
  CloudSync,
  GithubSync,
  commit,
  emptyDoc,
  loadGithubConfig,
  loadSpace,
  mergeDocs,
  refresh,
  saveGithubConfig,
  saveSpace,
} from './sync.js';

const $ = (sel) => document.querySelector(sel);
const PICK_LABEL = { home: 'Home win', draw: 'Draw', away: 'Away win' };

const state = {
  dataset: null,
  bucket: null,
  prediction: null,
  doc: emptyDoc(),
  backend: null,
  busy: false,
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)}%`;
const signed = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}`;
const isoDay = (date) => (date ? String(date).slice(0, 10) : '');

let toastTimer;
function toast(message, bad = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), bad ? 6000 : 2600);
}

function setChip(kind, text) {
  const chip = $('#syncChip');
  chip.className = `chip ${kind}`;
  $('#syncText').textContent = text;
}

/* ------------------------------------------------------------------ data load */

async function loadDataset() {
  const res = await fetch('./data/dataset.json');
  if (!res.ok) throw new Error(`dataset ${res.status}`);
  state.dataset = await res.json();
}

function renderComps() {
  const comps = state.dataset.competitions;
  $('#comps').innerHTML = comps
    .map(
      (c) =>
        `<button class="comp" role="tab" data-comp="${escapeHtml(c.key)}" aria-selected="${c.key === state.bucket.key}">${escapeHtml(c.label)}</button>`,
    )
    .join('');
}

function selectBucket(key) {
  state.bucket = state.dataset.competitions.find((c) => c.key === key) ?? state.dataset.competitions[0];
  state.prediction = null;
  renderComps();
  renderTeams();
  renderResult();
  const meta = state.dataset.meta;
  $('#dataSource').textContent = `${state.bucket.label} · ${state.bucket.matches.length} matches · ${state.bucket.league.deepMatches} with event data · ${state.bucket.seasons.slice(-2).join(', ')} · StatsBomb via Hudl, fetched ${isoDay(meta.fetchedAt)}`;
  $('#pickHint').textContent = state.bucket.note;
}

function renderTeams() {
  const teams = [...state.bucket.teams].sort((a, b) => a.name.localeCompare(b.name));
  const options = teams.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  const home = $('#homeTeam');
  const away = $('#awayTeam');
  const previousHome = home.value;
  const previousAway = away.value;
  home.innerHTML = options;
  away.innerHTML = options;

  const has = (id) => teams.some((t) => String(t.id) === String(id));
  if (has(previousHome)) home.value = previousHome;
  if (has(previousAway)) away.value = previousAway;
  if (home.value === away.value) {
    const other = teams.find((t) => String(t.id) !== home.value);
    if (other) away.value = other.id;
  }
}

/* ------------------------------------------------------------------ prediction */

function runPrediction() {
  const homeId = Number($('#homeTeam').value);
  const awayId = Number($('#awayTeam').value);
  if (!homeId || !awayId) return;
  if (homeId === awayId) {
    toast('Pick two different teams.', true);
    return;
  }
  state.prediction = predict(state.bucket, homeId, awayId);
  renderResult();
  const card = $('#result');
  if (window.matchMedia('(max-width: 860px)').matches) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* Bar widths are handed to CSSOM after render rather than written as inline style attributes,
 * which the page's Content-Security-Policy (style-src 'self') would refuse. */
function applyBars(scope) {
  scope.querySelectorAll('[data-width]').forEach((el) => {
    el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.width))).toFixed(1)}%`;
  });
}

function probRow(label, value, cls) {
  return `<div class="prob prob-${cls}">
    <span class="prob-label">${label}</span>
    <span class="prob-bar"><i data-width="${Math.max(1, value * 100).toFixed(1)}"></i></span>
    <strong>${pct(value)}</strong>
  </div>`;
}

function factorRow(factor) {
  const effect = factor.effect;
  const width = Math.min(50, Math.abs(effect) * 100 * 6);
  return `<div class="factor">
    <span class="factor-name">${escapeHtml(factor.label)}<span class="factor-detail">${escapeHtml(factor.detail)}</span></span>
    <span class="factor-track"><i class="${effect >= 0 ? 'pos' : 'neg'}" data-width="${width.toFixed(1)}"></i></span>
    <span class="factor-effect">${signed(effect)}</span>
  </div>`;
}

function teamColumn(side, team) {
  const m = team.metrics;
  const profile = state.prediction.profiles[side];
  const chips = (m.form ?? []).map((r) => `<span class="form-chip ${r}">${r}</span>`).join('');
  const tags = [
    ...profile.strengths.map((s) => `<span class="tag good">${escapeHtml(s.label)} <span class="tag-detail">${escapeHtml(s.detail)}</span></span>`),
    ...profile.weaknesses.map((s) => `<span class="tag bad">${escapeHtml(s.label)} <span class="tag-detail">${escapeHtml(s.detail)}</span></span>`),
  ].join('');
  return `<div class="team-col">
    <h3>${escapeHtml(team.name)} <span>Elo ${m.elo}</span></h3>
    <div class="form-chips">${chips || '<span class="muted">no recent matches</span>'}</div>
    <div>${tags || '<span class="muted">mid-table across the board</span>'}</div>
  </div>`;
}

function renderResult() {
  const p = state.prediction;
  const container = $('#result');
  if (!p) {
    container.innerHTML = `<div class="card placeholder"><p class="muted">No prediction yet. Choose two teams and press <strong>Predict outcome</strong>.</p></div>`;
    return;
  }

  const h = p.home.metrics;
  const a = p.away.metrics;
  const stat = (label, left, right) =>
    `<tr><th>${label}</th><td>${left}</td><td>${right}</td></tr>`;

  const h2hRows = p.h2h.matches
    .slice(0, 5)
    .map(
      (m) =>
        `<tr><td>${escapeHtml(m.homeId === p.home.id ? p.home.name : p.away.name)}</td><td>${m.homeGoals}–${m.awayGoals}</td><td>${escapeHtml(m.homeId === p.home.id ? p.away.name : p.home.name)}</td><td>${escapeHtml(isoDay(m.date))}</td></tr>`,
    )
    .join('');

  container.innerHTML = `
    <div class="card">
      <div class="verdict">
        <div class="verdict-pick"><small>Model leans</small>${PICK_LABEL[p.pick]}</div>
        <div class="confidence"><strong>${Math.round(p.confidence * 100)}%</strong>confidence
          <div class="confidence-bar"><i data-width="${Math.round(p.confidence * 100)}"></i></div>
        </div>
      </div>
      <div class="probs">
        ${probRow(escapeHtml(p.home.name), p.probabilities.home, 'home')}
        ${probRow('Draw', p.probabilities.draw, 'draw')}
        ${probRow(escapeHtml(p.away.name), p.probabilities.away, 'away')}
      </div>
      <div class="market-grid">
        <div class="market"><span>Most likely score</span><strong>${p.scoreline.home}–${p.scoreline.away}</strong></div>
        <div class="market"><span>Expected goals</span><strong>${p.expectedGoals.home.toFixed(2)} – ${p.expectedGoals.away.toFixed(2)}</strong></div>
        <div class="market"><span>Over 2.5 goals</span><strong>${pct(p.over25)}</strong></div>
        <div class="market"><span>Both teams score</span><strong>${pct(p.btts)}</strong></div>
      </div>
      <div class="card-actions">
        <button class="primary small" type="button" data-act="save">Save to log</button>
        <button class="ghost small" type="button" data-act="again">Predict again</button>
      </div>
    </div>

    <div class="card">
      <h2>What moved the number</h2>
      <p class="sub">
        Each row switches one factor off and shows the change in home-win probability.
      </p>
      <div class="factors">${p.factors.map(factorRow).join('')}</div>
    </div>

    <div class="card">
      <h2>Form, strength and weaknesses</h2>
      <div class="teams spaced">
        ${teamColumn('home', p.home)}
        ${teamColumn('away', p.away)}
      </div>
      <table class="stat-table spaced">
        <thead><tr><th>Per game</th><th>${escapeHtml(p.home.name)}</th><th>${escapeHtml(p.away.name)}</th></tr></thead>
        <tbody>
          ${stat('Goals for', h.goalsFor.toFixed(2), a.goalsFor.toFixed(2))}
          ${stat('Goals against', h.goalsAgainst.toFixed(2), a.goalsAgainst.toFixed(2))}
          ${stat('xG for', h.xgFor.toFixed(2), a.xgFor.toFixed(2))}
          ${stat('xG against', h.xgAgainst.toFixed(2), a.xgAgainst.toFixed(2))}
          ${stat('Possession', h.possession == null ? '—' : `${h.possession.toFixed(1)}%`, a.possession == null ? '—' : `${a.possession.toFixed(1)}%`)}
          ${stat('Shots', h.shots == null ? '—' : h.shots.toFixed(1), a.shots == null ? '—' : a.shots.toFixed(1))}
          ${stat('Pass accuracy', h.passAccuracy == null ? '—' : `${h.passAccuracy}%`, a.passAccuracy == null ? '—' : `${a.passAccuracy}%`)}
          ${stat('Home record', `${h.home.wins}W-${h.home.draws}D-${h.home.losses}L`, `${a.home.wins}W-${a.home.draws}D-${a.home.losses}L`)}
          ${stat('Away record', `${h.away.wins}W-${h.away.draws}D-${h.away.losses}L`, `${a.away.wins}W-${a.away.draws}D-${a.away.losses}L`)}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Head to head</h2>
      <p class="sub">
        ${p.h2h.meetings
          ? `${p.h2h.homeWins} win${p.h2h.homeWins === 1 ? '' : 's'} for ${escapeHtml(p.home.name)}, ${p.h2h.draws} draw${p.h2h.draws === 1 ? '' : 's'}, ${p.h2h.awayWins} for ${escapeHtml(p.away.name)} — ${p.h2h.homeGoals}–${p.h2h.awayGoals} on aggregate.`
          : 'These two have not met in the data for this competition.'}
      </p>
      ${h2hRows ? `<table class="stat-table spaced"><thead><tr><th>Home</th><th>Score</th><th>Away</th><th>Date</th></tr></thead><tbody>${h2hRows}</tbody></table>` : ''}
    </div>
  `;
  applyBars(container);
}

/* ------------------------------------------------------------------ sync */

async function connectSync() {
  const github = loadGithubConfig();
  if (github?.enabled && GithubSync.valid(github)) {
    state.backend = new GithubSync(github);
  } else {
    let space = loadSpace();
    if (!space) {
      try {
        state.backend = await CloudSync.claim();
        space = loadSpace();
      } catch (err) {
        state.backend = null;
        setChip('err', 'no sync — save failed');
        toast(`${err.message}. The log stays in this tab only.`, true);
        renderSettings();
        return;
      }
    } else {
      state.backend = new CloudSync(space);
    }
  }

  setChip('busy', 'syncing…');
  try {
    state.doc = await refresh(state.backend, state.doc);
    setChip('ok', 'synced');
  } catch (err) {
    setChip('err', 'sync error');
    toast(err.message, true);
  }
  renderSaved();
  renderSettings();
}

async function saveDoc(mutate, note) {
  if (!state.backend) {
    // No sync target: keep the change in the tab and say exactly that.
    state.doc = mutate(mergeDocs(state.doc, state.doc));
    renderSaved();
    setChip('err', 'not synced');
    toast(`${note} but it is not synced — no sync target is reachable.`, true);
    return false;
  }
  state.busy = true;
  setChip('busy', 'saving…');
  try {
    const { doc } = await commit(state.backend, state.doc, mutate);
    state.doc = doc;
    setChip('ok', 'synced');
    renderSaved();
    renderSettings();
    toast(note);
    return true;
  } catch (err) {
    setChip('err', 'save failed');
    toast(`${err.message} The change is in this tab but has not been saved.`, true);
    return false;
  } finally {
    state.busy = false;
  }
}

async function savePrediction() {
  const p = state.prediction;
  if (!p) return;
  const entry = {
    id: (crypto.randomUUID && crypto.randomUUID()) || `e${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    bucket: p.bucket,
    bucketLabel: state.bucket.label,
    home: { id: p.home.id, name: p.home.name },
    away: { id: p.away.id, name: p.away.name },
    probabilities: p.probabilities,
    pick: p.pick,
    scoreline: { home: p.scoreline.home, away: p.scoreline.away },
    expectedGoals: p.expectedGoals,
    confidence: p.confidence,
    modelVersion: MODEL_VERSION,
    result: null,
  };
  await saveDoc(
    (doc) => ({ ...doc, entries: [entry, ...doc.entries.filter((e) => e.id !== entry.id)] }),
    `Saved ${entry.home.name} vs ${entry.away.name}.`,
  );
}

async function setResult(id, hg, ag) {
  const entry = state.doc.entries.find((e) => e.id === id);
  if (!entry) return;
  const result = hg === '' || ag === '' ? null : { home: Number(hg), away: Number(ag) };
  await saveDoc(
    (doc) => ({
      ...doc,
      entries: doc.entries.map((e) =>
        e.id === id ? { ...e, result, updatedAt: new Date().toISOString() } : e,
      ),
    }),
    result ? 'Result recorded.' : 'Result cleared.',
  );
}

async function deleteEntry(id) {
  const entry = state.doc.entries.find((e) => e.id === id);
  if (!entry) return;
  await saveDoc(
    (doc) => ({ ...doc, entries: doc.entries.filter((e) => e.id !== id) }),
    `Deleted ${entry.home.name} vs ${entry.away.name}.`,
  );
}

/* ------------------------------------------------------------------ saved log */

function renderSummary() {
  const entries = state.doc.entries ?? [];
  const graded = entries.map((e) => ({ e, s: scorePrediction(e) })).filter((x) => x.s);
  const hits = graded.filter((x) => x.s.correct).length;
  const exact = graded.filter((x) => x.s.scoreCorrect).length;
  const avg = (pick) => (graded.length ? graded.reduce((sum, x) => sum + pick(x.s), 0) / graded.length : null);
  const brier = avg((s) => s.brier);
  const logLoss = avg((s) => s.logLoss);

  const tiles = [
    ['Predictions', entries.length],
    ['Graded', graded.length],
    ['Right call', graded.length ? `${hits}/${graded.length} · ${pct(hits / graded.length)}` : '—'],
    ['Exact scores', exact],
    ['Brier', brier == null ? '—' : brier.toFixed(3)],
    ['Log loss', logLoss == null ? '—' : logLoss.toFixed(3)],
  ];
  $('#summary').innerHTML = tiles
    .map(([label, value]) => `<div class="summary-tile"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');
}

function renderSaved() {
  renderSummary();
  const entries = state.doc.entries ?? [];
  const list = $('#savedList');
  if (!entries.length) {
    list.innerHTML = `<div class="empty">Nothing saved yet. Make a prediction and press <strong>Save to log</strong> — it syncs straight away and follows you to every device that holds your key.</div>`;
    return;
  }

  list.innerHTML = entries
    .slice(0, 60)
    .map((entry) => {
      const score = scorePrediction(entry);
      const pickPct = pct(entry.probabilities[entry.pick]);
      const status = score
        ? `<span class="pill ${score.correct ? 'hit' : 'miss'}">${score.correct ? 'right' : 'wrong'} · ${PICK_LABEL[score.actual]}</span>
           <span class="pill">Brier ${score.brier.toFixed(3)}</span>
           ${score.scoreCorrect ? '<span class="pill hit">exact score</span>' : ''}`
        : '<span class="pill pending">awaiting result</span>';
      return `<div class="entry" data-id="${escapeHtml(entry.id)}">
        <div>
          <div class="entry-fixture">${escapeHtml(entry.home.name)} vs ${escapeHtml(entry.away.name)}
            <small>${escapeHtml(entry.bucketLabel ?? entry.bucket)} · predicted ${entry.scoreline.home}–${entry.scoreline.away} · saved ${escapeHtml(isoDay(entry.createdAt))}</small>
          </div>
          <div class="entry-meta">
            <span class="pill">pick ${PICK_LABEL[entry.pick]} ${pickPct}</span>
            ${status}
          </div>
        </div>
        <div class="entry-actions">
          <input class="score-input" type="number" min="0" max="20" inputmode="numeric" data-score="home"
            value="${entry.result ? entry.result.home : ''}" aria-label="Home goals" />
          <span class="sep">–</span>
          <input class="score-input" type="number" min="0" max="20" inputmode="numeric" data-score="away"
            value="${entry.result ? entry.result.away : ''}" aria-label="Away goals" />
          <button class="delete" type="button" data-act="delete" title="Delete">✕</button>
        </div>
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ settings */

function renderSettings() {
  const space = loadSpace();
  const github = loadGithubConfig();
  const usingGithub = github?.enabled && GithubSync.valid(github);
  $('#syncStatus').textContent = state.backend
    ? `Writing to ${state.backend.label()}.`
    : 'No sync target reachable — the log stays in this tab.';
  $('#spaceInfo').innerHTML = space
    ? `<dt>Space id</dt><dd>${escapeHtml(space.spaceId)}</dd><dt>Space key</dt><dd>${escapeHtml(space.key)}</dd>`
    : '<dt>Space</dt><dd>not created yet</dd>';
  if (github) {
    $('#ghOwner').value = github.owner ?? '';
    $('#ghRepo').value = github.repo ?? '';
    $('#ghPath').value = github.path ?? 'football-outcomer.json';
    $('#ghBranch').value = github.branch ?? 'main';
    $('#ghRemember').checked = Boolean(github.remember);
    if (github.remember) $('#ghToken').value = github.token ?? '';
  }
  $('#useGithub').textContent = usingGithub ? 'Using GitHub file ✓' : 'Use a JSON file on GitHub';
  $('#useCloud').textContent = usingGithub ? 'Switch back to Cloudflare database' : 'Using the Cloudflare database ✓';
}

async function connectGithub() {
  const config = {
    owner: $('#ghOwner').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/.*$/, ''),
    repo: $('#ghRepo').value.trim(),
    path: $('#ghPath').value.trim() || 'football-outcomer.json',
    branch: $('#ghBranch').value.trim() || 'main',
    token: $('#ghToken').value.trim(),
    remember: $('#ghRemember').checked,
    enabled: true,
  };
  if (!GithubSync.valid(config)) {
    toast('Owner, repository, path and token are all needed.', true);
    return;
  }

  const backend = new GithubSync(config);
  try {
    const pulled = await backend.pull();
    saveGithubConfig(config.remember ? config : { ...config, token: config.token });
    state.backend = backend;
    state.doc = mergeDocs(pulled.doc, state.doc);
    setChip('ok', 'synced');
    toast(pulled.doc ? 'Connected — existing file loaded.' : 'Connected — the file will be created on the first save.');
    $('#settings').close();
    renderSaved();
    renderSettings();
  } catch (err) {
    setChip('err', 'sync error');
    toast(err.message, true);
  }
}

function switchToCloud() {
  saveGithubConfig(null);
  state.backend = null;
  $('#ghToken').value = '';
  connectSync().then(() => $('#settings').close());
}

async function joinSpace() {
  const raw = window.prompt('Paste a space id and key, as "id key" (or from the copied line).', '');
  if (!raw) return;
  const [spaceId, key] = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (!spaceId || !key) {
    toast('That line did not contain both a space id and a key.', true);
    return;
  }
  saveSpace({ spaceId, key });
  saveGithubConfig(null);
  state.doc = emptyDoc();
  await connectSync();
  $('#settings').close();
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  $('#comps').addEventListener('click', (event) => {
    const btn = event.target.closest('[data-comp]');
    if (btn) selectBucket(btn.dataset.comp);
  });

  $('#predictBtn').addEventListener('click', runPrediction);
  $('#swapBtn').addEventListener('click', () => {
    const home = $('#homeTeam').value;
    $('#homeTeam').value = $('#awayTeam').value;
    $('#awayTeam').value = home;
    runPrediction();
  });

  $('#result').addEventListener('click', (event) => {
    const act = event.target.closest('[data-act]')?.dataset.act;
    if (act === 'save') savePrediction();
    if (act === 'again') runPrediction();
  });

  $('#savedList').addEventListener('change', (event) => {
    const input = event.target.closest('[data-score]');
    if (!input) return;
    const row = input.closest('[data-id]');
    const hg = row.querySelector('[data-score="home"]').value;
    const ag = row.querySelector('[data-score="away"]').value;
    setResult(row.dataset.id, hg, ag);
  });

  $('#savedList').addEventListener('click', (event) => {
    if (event.target.closest('[data-act="delete"]')) {
      const row = event.target.closest('[data-id]');
      if (window.confirm('Delete this prediction from the log?')) deleteEntry(row.dataset.id);
    }
  });

  $('#settingsBtn').addEventListener('click', () => {
    renderSettings();
    $('#settings').showModal();
  });
  $('#syncChip').addEventListener('click', () => {
    renderSettings();
    $('#settings').showModal();
  });

  $('#useCloud').addEventListener('click', switchToCloud);
  $('#useGithub').addEventListener('click', () => $('#githubSection').scrollIntoView({ behavior: 'smooth' }));
  $('#connectGithub').addEventListener('click', connectGithub);
  $('#joinSpace').addEventListener('click', joinSpace);

  $('#copySpace').addEventListener('click', async () => {
    const space = loadSpace();
    if (!space) return toast('No space yet.', true);
    const text = `${space.spaceId} ${space.key}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Space id and key copied — keep them private.');
    } catch {
      toast(text, true);
    }
  });

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state.doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `football-outcomer-${isoDay(new Date().toISOString())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  $('#exportBtn').addEventListener('click', exportJson);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      await saveDoc((doc) => mergeDocs(doc, parsed), 'Backup imported.');
    } catch (err) {
      toast(`Could not read that file: ${err.message}`, true);
    }
    event.target.value = '';
  });
}

async function init() {
  wire();
  try {
    await loadDataset();
  } catch (err) {
    $('#result').innerHTML = `<div class="card"><p class="muted">The dataset could not be loaded (${escapeHtml(err.message)}). Run <code>npm run data</code> to rebuild it.</p></div>`;
    return;
  }
  selectBucket(state.dataset.competitions[0].key);
  const teams = [...state.bucket.teams].sort((a, b) => b.elo - a.elo);
  if (teams[0] && teams[1]) {
    $('#homeTeam').value = teams[0].id;
    $('#awayTeam').value = teams[1].id;
  }
  await connectSync();
}

init();
