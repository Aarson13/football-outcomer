/**
 * scripts/build-dataset.mjs — build the model's dataset from Hudl's open StatsBomb feed.
 *
 *   npm run data
 *
 * Source: https://github.com/hudl/open-data (StatsBomb open data, branch `master`).
 *
 * Two tiers are pulled, because the open data is deliberately partial:
 *
 *   1. `matches/<competition>/<season>.json` — cheap, complete where published. Everything
 *      Elo, form, goals for/against, home advantage and head-to-head need.
 *   2. `events/<match_id>.json` — 3-4 MB each, parsed for possession time, shots, shots on
 *      target, xG, xGA and passing, then thrown away. Only the aggregates are kept.
 *
 * Seasons are chosen for *complete* event coverage, which is why the Premier League bucket is
 * 2015/16 (380 matches, every offset in the repo) rather than a newer campaign the repo only
 * samples. Each bucket keeps its own rating pool — a 2016 Arsenal rating has no business
 * predicting a 2024 India fixture.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const RAW = 'https://raw.githubusercontent.com/hudl/open-data/master/data';
const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'public/data/dataset.json';
const CONCURRENCY = 10;

const log = (...a) => console.log(...a);

async function getJson(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'football-outcomer-dataset' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return getJson(url, attempt + 1);
  }
}

/** Run `fn` over `items` with a small pool, keeping memory flat on hundreds of multi-MB files. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** The buckets the app offers, each a self-contained rating pool. */
const PLANS = [
  {
    key: 'premier-league',
    label: 'Premier League',
    note: 'Full season with event-level stats',
    sources: [{ competition: 2, seasons: [27], deep: [27] }],
  },
  {
    key: 'international',
    label: 'International tournaments',
    note: 'World Cup 2022, Euro 2024, Copa América 2024',
    sources: [
      { competition: 43, seasons: [106], deep: [106] },
      { competition: 55, seasons: [282], deep: [282] },
      { competition: 223, seasons: [282], deep: [282] },
    ],
  },
  {
    key: 'la-liga',
    label: 'La Liga',
    note: '18 seasons of results, 2020/21 event sample',
    sources: [{ competition: 11, seasons: 'all', deep: [90] }],
  },
];

const competitions = await getJson(`${RAW}/competitions.json`);
const seasonMeta = new Map(
  competitions.map((c) => [`${c.competition_id}:${c.season_id}`, c]),
);

function bucketFor(key, label, note) {
  return {
    key,
    label,
    note,
    matches: [],
    teams: new Map(),
    deep: new Map(),
    totals: { matches: 0, hg: 0, ag: 0, homeWin: 0, draw: 0, awayWin: 0 },
    seasons: [],
  };
}

function teamIn(bucket, id, name) {
  if (!bucket.teams.has(id)) {
    bucket.teams.set(id, {
      id,
      name,
      matches: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0,
      home: { matches: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 },
      away: { matches: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 },
      elo: 1500,
      peakElo: 1500,
      form: [],
      recent: [],
    });
  }
  return bucket.teams.get(id);
}

function deepRow(bucket, id) {
  if (!bucket.deep.has(id)) {
    bucket.deep.set(id, {
      matches: 0, poss: 0, shots: 0, sot: 0, xg: 0, xga: 0,
      passes: 0, passesCompleted: 0, corners: 0,
    });
  }
  return bucket.deep.get(id);
}

const output = [];

for (const plan of PLANS) {
  log(`\n=== ${plan.label}`);
  const bucket = bucketFor(plan.key, plan.label, plan.note);
  const eventMatchIds = [];

  for (const source of plan.sources) {
    const all = competitions.filter((c) => c.competition_id === source.competition);
    const seasons = source.seasons === 'all'
      ? all
      : all.filter((c) => source.seasons.includes(c.season_id));

    for (const season of seasons) {
      const list = await getJson(`${RAW}/matches/${source.competition}/${season.season_id}.json`);
      log(`  ${season.competition_name} ${season.season_name}: ${list.length} matches`);
      bucket.seasons.push(`${season.competition_name} ${season.season_name}`);

      for (const m of list) {
        if (!Number.isFinite(m.home_score) || !Number.isFinite(m.away_score)) continue;
        bucket.matches.push({
          d: m.match_date,
          h: m.home_team.home_team_id,
          a: m.away_team.away_team_id,
          hg: m.home_score,
          ag: m.away_score,
          s: season.season_id,
        });
        teamIn(bucket, m.home_team.home_team_id, m.home_team.home_team_name);
        teamIn(bucket, m.away_team.away_team_id, m.away_team.away_team_name);
        if (source.deep.includes(season.season_id)) eventMatchIds.push(m.match_id);
      }
    }
  }

  bucket.matches.sort((a, b) => a.d.localeCompare(b.d));
  log(`  ${bucket.matches.length} matches, ${eventMatchIds.length} with event stats`);

  /* ---- Elo, form and goals, in date order ---- */
  const K = 20;
  const HOME_ELO = 65;
  for (const m of bucket.matches) {
    const home = teamIn(bucket, m.h, '');
    const away = teamIn(bucket, m.a, '');
    const expected = 1 / (1 + 10 ** ((away.elo - (home.elo + HOME_ELO)) / 400));
    const score = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
    const multiplier = Math.log(Math.abs(m.hg - m.ag) + 1) + 1;
    const delta = K * multiplier * (score - expected);
    home.elo += delta;
    away.elo -= delta;
    home.peakElo = Math.max(home.peakElo, home.elo);
    away.peakElo = Math.max(away.peakElo, away.elo);

    for (const [t, opp, gf, ga, venue] of [
      [home, away, m.hg, m.ag, 'home'],
      [away, home, m.ag, m.hg, 'away'],
    ]) {
      const result = gf > ga ? 'W' : gf === ga ? 'D' : 'L';
      t.matches += 1;
      t.gf += gf;
      t.ga += ga;
      if (result === 'W') t.wins += 1;
      else if (result === 'D') t.draws += 1;
      else t.losses += 1;
      const v = t[venue];
      v.matches += 1;
      v.gf += gf;
      v.ga += ga;
      v.points += result === 'W' ? 3 : result === 'D' ? 1 : 0;
      if (result === 'W') v.wins += 1;
      else if (result === 'D') v.draws += 1;
      else v.losses += 1;
      t.form.push(result);
      t.recent.push({ d: m.d, gf, ga, opp: opp.id, home: venue === 'home' });
    }

    bucket.totals.matches += 1;
    bucket.totals.hg += m.hg;
    bucket.totals.ag += m.ag;
    if (m.hg > m.ag) bucket.totals.homeWin += 1;
    else if (m.hg === m.ag) bucket.totals.draw += 1;
    else bucket.totals.awayWin += 1;
  }
  // Ratings are relative to a 1500 baseline: re-centre so the pool's mean is 1500 whatever
  // the starting point and how many seasons were folded in.
  const mean = [...bucket.teams.values()].reduce((s, t) => s + t.elo, 0) / bucket.teams.size;
  for (const t of bucket.teams.values()) {
    t.elo = Math.round(t.elo - mean + 1500);
    t.peakElo = Math.round(t.peakElo - mean + 1500);
  }

  /* ---- event aggregates ---- */
  let done = 0;
  await pool(eventMatchIds, CONCURRENCY, async (id) => {
    const events = await getJson(`${RAW}/events/${id}.json`);
    const acc = new Map();
    const get = (teamId) => {
      if (!acc.has(teamId)) acc.set(teamId, { poss: 0, shots: 0, sot: 0, xg: 0, xga: 0, passes: 0, passesCompleted: 0, corners: 0 });
      return acc.get(teamId);
    };

    for (const e of events) {
      const teamId = e.team?.id;
      if (!teamId) continue;
      const row = get(teamId);
      // StatsBomb tags every event with the side in possession and most events carry a
      // duration, so summing durations splits the match between the two teams.
      if (e.duration) row.poss += e.duration;
      if (e.type?.name === 'Shot') {
        const xg = e.shot?.statsbomb_xg ?? 0;
        row.shots += 1;
        row.xg += xg;
        const outcome = e.shot?.outcome?.name;
        if (outcome === 'Goal' || outcome === 'Saved' || outcome === 'Saved to Post' || outcome === 'Blocked') row.sot += 1;
      }
      if (e.type?.name === 'Pass') {
        row.passes += 1;
        if (!e.pass?.outcome) row.passesCompleted += 1;
        if (e.pass?.type?.name === 'Corner') row.corners += 1;
      }
    }

    const total = [...acc.values()].reduce((s, r) => s + r.poss, 0) || 1;
    const totalXg = [...acc.values()].reduce((s, r) => s + r.xg, 0);
    for (const [teamId, row] of acc) {
      const d = deepRow(bucket, teamId);
      d.matches += 1;
      d.poss += (row.poss / total) * 100;
      d.shots += row.shots;
      d.sot += row.sot;
      d.xg += row.xg;
      // Two sides per match, so the other team's xG is everything this side did not produce.
      d.xga += Math.max(0, totalXg - row.xg);
      d.passes += row.passes;
      d.passesCompleted += row.passesCompleted;
      d.corners += row.corners;
    }
    done += 1;
    if (done % 50 === 0) log(`    … ${done}/${eventMatchIds.length} event files`);
  });

  /* ---- compact output ---- */
  const teams = [...bucket.teams.values()].map((t) => {
    const d = bucket.deep.get(t.id);
    const out = {
      id: t.id,
      name: t.name,
      elo: t.elo,
      peakElo: t.peakElo,
      matches: t.matches,
      wins: t.wins,
      draws: t.draws,
      losses: t.losses,
      gf: t.gf,
      ga: t.ga,
      home: t.home,
      away: t.away,
      form: t.form.slice(-10),
      recent: t.recent.slice(-10),
    };
    if (d?.matches >= 3) {
      out.deep = {
        matches: d.matches,
        possession: +(d.poss / d.matches).toFixed(1),
        shots: +(d.shots / d.matches).toFixed(1),
        shotsOnTarget: +(d.sot / d.matches).toFixed(1),
        xg: +(d.xg / d.matches).toFixed(2),
        xga: +(d.xga / d.matches).toFixed(2),
        passes: Math.round(d.passes / d.matches),
        passAccuracy: Math.round((d.passesCompleted / Math.max(1, d.passes)) * 100),
        corners: +(d.corners / d.matches).toFixed(1),
      };
    }
    return out;
  });
  teams.sort((a, b) => b.elo - a.elo);

  const t = bucket.totals;
  output.push({
    key: bucket.key,
    label: bucket.label,
    note: bucket.note,
    seasons: [...new Set(bucket.seasons)],
    league: {
      matches: t.matches,
      goalsPerMatch: +((t.hg + t.ag) / t.matches).toFixed(3),
      homeGoalsPerMatch: +(t.hg / t.matches).toFixed(3),
      awayGoalsPerMatch: +(t.ag / t.matches).toFixed(3),
      homeWin: +(t.homeWin / t.matches).toFixed(4),
      draw: +(t.draw / t.matches).toFixed(4),
      awayWin: +(t.awayWin / t.matches).toFixed(4),
      deepMatches: eventMatchIds.length,
    },
    teams,
    matches: bucket.matches,
  });
}

const dataset = {
  meta: {
    source: 'https://github.com/hudl/open-data',
    credit: 'StatsBomb open data (via Hudl)',
    fetchedAt: new Date().toISOString(),
    buckets: output.map((b) => ({ key: b.key, label: b.label, matches: b.matches.length })),
  },
  competitions: output,
};

await mkdir(path.dirname(OUT), { recursive: true });
const json = JSON.stringify(dataset);
await writeFile(OUT, json);
for (const b of output) log(`✓ ${b.label}: ${b.teams.length} teams, ${b.matches.length} matches`);
log(`✓ wrote ${OUT} — ${(json.length / 1024).toFixed(0)} KB`);
