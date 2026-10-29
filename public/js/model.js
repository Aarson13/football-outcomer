/**
 * model.js — the prediction engine. Pure functions: no DOM, no network, no randomness, so the
 * Node test suite can check the same numbers the page shows.
 *
 * Shape of the calculation:
 *
 *   1. Every team gets a scoring rate and a conceding rate from its matches (blended with xG
 *      where the open data has event coverage), relative to the competition's average.
 *   2. Those rates become expected goals: home side scores at the league's home rate times its
 *      attack against the visitor's defence, and the mirror image for the away side.
 *   3. Four adjustments are applied, each recorded separately so the UI can show what moved the
 *      number: recent form, Elo, the possession matchup and head-to-head history. Home-field
 *      advantage lives in step 2, and its own effect is measured by removing it.
 *   4. The two Poisson distributions are crossed into an 8x8 scoreline grid, which yields the
 *      1X2 split, the most likely score, over/under and both-teams-to-score.
 *
 * Factors are reported as leave-one-out effects: how much the home win probability moves when
 * that adjustment is switched off. That is an honest "contribution" number and it always sums
 * back to something a reader can reproduce.
 */
export const MODEL_VERSION = '1.0.0';

const MAX_GOALS = 8;
const ELO_WEIGHT = 0.25;
const POSSESSION_WEIGHT = 0.12;
const H2H_WEIGHT = 0.18;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function poisson(k, lambda) {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i += 1) logP -= Math.log(i);
  return Math.exp(logP);
}

/** Cross two Poisson rates into scoreline probabilities, plus the markets that follow. */
export function scoreGrid(lambdaHome, lambdaAway) {
  const grid = [];
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    grid[h] = [];
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      grid[h][a] = poisson(h, lambdaHome) * poisson(a, lambdaAway);
    }
  }
  let home = 0;
  let draw = 0;
  let away = 0;
  let over25 = 0;
  let btts = 0;
  let best = { h: 0, a: 0, p: -1 };
  const top = [];
  for (let h = 0; h <= MAX_GOALS; h += 1) {
    for (let a = 0; a <= MAX_GOALS; a += 1) {
      const p = grid[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h + a > 2.5) over25 += p;
      if (h > 0 && a > 0) btts += p;
      if (p > best.p) best = { h, a, p };
      top.push({ h, a, p });
    }
  }
  top.sort((x, y) => y.p - x.p);
  const total = home + draw + away;
  return {
    probabilities: { home: home / total, draw: draw / total, away: away / total },
    scoreline: { home: best.h, away: best.a, probability: best.p / total },
    topScorelines: top.slice(0, 5).map((s) => ({ ...s, p: s.p / total })),
    over25: over25 / total,
    btts: btts / total,
    expectedGoals: { home: lambdaHome, away: lambdaAway },
  };
}

/** Weighted average over the last N matches, newest match weighted highest. */
function recentAverage(list, pick) {
  if (!list?.length) return null;
  let num = 0;
  let den = 0;
  list.forEach((m, i) => {
    const w = i + 1;
    num += pick(m) * w;
    den += w;
  });
  return den ? num / den : null;
}

/**
 * Everything the model needs about one team, in per-match terms. `deep` (possession, xG) is
 * optional: the La Liga bucket only has an event sample, so those teams fall back to goals.
 */
export function teamMetrics(team, league) {
  const played = Math.max(1, team.matches);
  const leagueAvg = Math.max(0.2, league.goalsPerMatch / 2);
  const goalsFor = team.gf / played;
  const goalsAgainst = team.ga / played;
  const deep = team.deep;
  const xgFor = deep ? deep.xg : goalsFor;
  const xgAgainst = deep ? deep.xga : goalsAgainst;

  // 55% what actually happened, 45% what the chances were worth — shot quality regresses
  // finishing luck, which is what makes a predictor less of a form-chaser.
  const attackSeason = 0.55 * goalsFor + 0.45 * xgFor;
  const defenceSeason = 0.55 * goalsAgainst + 0.45 * xgAgainst;

  const recentFor = recentAverage(team.recent, (m) => m.gf);
  const recentAgainst = recentAverage(team.recent, (m) => m.ga);

  // The season rates stay pure so that recent form can be a separate, measurable factor.
  const attack = attackSeason;
  const defence = defenceSeason;
  const formIndex = recentFor == null || recentAgainst == null
    ? 1
    : clamp((recentFor / Math.max(0.05, attackSeason)) * (defenceSeason / Math.max(0.05, recentAgainst)), 0.4, 2.5);

  const formPoints = (team.form ?? []).reduce((s, r) => s + (r === 'W' ? 3 : r === 'D' ? 1 : 0), 0);
  const formMax = Math.max(1, (team.form ?? []).length * 3);

  return {
    id: team.id,
    name: team.name,
    played,
    goalsFor,
    goalsAgainst,
    xgFor,
    xgAgainst,
    attack,
    defence,
    recentFor,
    recentAgainst,
    formIndex,
    attackRating: attack / leagueAvg,
    defenceRating: defence / leagueAvg,
    possession: deep?.possession ?? null,
    passAccuracy: deep?.passAccuracy ?? null,
    shots: deep?.shots ?? null,
    xgDiff: deep ? deep.xg - deep.xga : null,
    elo: team.elo,
    formPoints,
    formMax,
    formPct: formPoints / formMax,
    home: team.home,
    away: team.away,
    form: (team.form ?? []).slice(-5),
    deepMatches: deep?.matches ?? 0,
  };
}

/** Percentile (0-100) of `value` among `values`; ties share the same rank. */
function percentile(value, values, invert = false) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length || !Number.isFinite(value)) return null;
  const below = sorted.filter((v) => v < value).length;
  const equal = sorted.filter((v) => v === value).length;
  const pct = ((below + equal / 2) / sorted.length) * 100;
  return invert ? 100 - pct : pct;
}

/** Strengths and weaknesses, as tags the reader can argue with. */
export function profileTeam(team, bucket) {
  const league = bucket.league;
  const metrics = teamMetrics(team, league);
  const all = bucket.teams.map((t) => teamMetrics(t, league));
  const possessionValues = all.map((t) => t.possession).filter((v) => v != null);
  const xgValues = all.map((t) => t.xgDiff).filter((v) => v != null);

  const ranks = {
    attack: percentile(metrics.attack, all.map((t) => t.attack)),
    defence: percentile(metrics.defence, all.map((t) => t.defence), true),
    possession: percentile(metrics.possession, possessionValues),
    xg: percentile(metrics.xgDiff, xgValues),
    form: percentile(metrics.formPct, all.map((t) => t.formPct)),
    home: percentile(metrics.home.matches ? metrics.home.points / metrics.home.matches : null, all.map((t) => (t.home.matches ? t.home.points / t.home.matches : null))),
    away: percentile(metrics.away.matches ? metrics.away.points / metrics.away.matches : null, all.map((t) => (t.away.matches ? t.away.points / t.away.matches : null))),
  };

  const labels = [
    { key: 'attack', rank: ranks.attack, strong: 'Free-scoring attack', weak: 'Blunt in front of goal', detail: `${metrics.goalsFor.toFixed(2)} goals per game` },
    { key: 'defence', rank: ranks.defence, strong: 'Mean defence', weak: 'Concedes chances', detail: `${metrics.goalsAgainst.toFixed(2)} conceded per game` },
    { key: 'possession', rank: ranks.possession, strong: 'Controls possession', weak: 'Lives off the ball', detail: metrics.possession == null ? 'no event sample' : `${metrics.possession.toFixed(1)}% possession` },
    { key: 'xg', rank: ranks.xg, strong: 'Creates better chances than it concedes', weak: 'Outshot by opponents', detail: metrics.xgDiff == null ? 'no event sample' : `${metrics.xgDiff > 0 ? '+' : ''}${metrics.xgDiff.toFixed(2)} xG per game` },
    { key: 'form', rank: ranks.form, strong: 'In form', weak: 'Out of form', detail: `${metrics.formPoints} pts from the last ${(team.form ?? []).length} matches` },
    { key: 'home', rank: ranks.home, strong: 'Fortress at home', weak: 'Drops points at home', detail: `${metrics.home.points} pts in ${metrics.home.matches} home games` },
    { key: 'away', rank: ranks.away, strong: 'Strong traveller', weak: 'Poor on the road', detail: `${metrics.away.points} pts in ${metrics.away.matches} away games` },
  ];

  const strengths = labels
    .filter((l) => l.rank != null && l.rank >= 70)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 3)
    .map((l) => ({ label: l.strong, detail: l.detail, rank: Math.round(l.rank) }));
  const weaknesses = labels
    .filter((l) => l.rank != null && l.rank <= 30)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
    .map((l) => ({ label: l.weak, detail: l.detail, rank: Math.round(l.rank) }));

  return { metrics, ranks, strengths, weaknesses };
}

/** Head-to-head record between two teams, newest first. */
export function headToHead(bucket, homeId, awayId, limit = 8) {
  const meetings = bucket.matches
    .filter((m) => (m.h === homeId && m.a === awayId) || (m.h === awayId && m.a === homeId))
    .slice(-limit)
    .reverse();

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let homeGoals = 0;
  let awayGoals = 0;
  for (const m of meetings) {
    const homeIsHost = m.h === homeId;
    const hg = homeIsHost ? m.hg : m.ag;
    const ag = homeIsHost ? m.ag : m.hg;
    homeGoals += hg;
    awayGoals += ag;
    if (hg > ag) homeWins += 1;
    else if (hg === ag) draws += 1;
    else awayWins += 1;
  }

  return {
    meetings: meetings.length,
    homeWins,
    draws,
    awayWins,
    homeGoals,
    awayGoals,
    matches: meetings.map((m) => ({ date: m.d, homeId: m.h, awayId: m.a, homeGoals: m.hg, awayGoals: m.ag })),
  };
}

/**
 * Elo difference turned into a symmetric multiplier on both expected-goals values. Deliberately
 * no home bonus here: home advantage already lives in the league's home/away scoring rates, and
 * adding it twice is the classic way to overrate the host.
 */
function eloMultiplier(eloHome, eloAway) {
  const expected = 1 / (1 + 10 ** (-(eloHome - eloAway) / 400));
  const ratio = (expected / (1 - expected)) ** ELO_WEIGHT;
  return clamp(ratio, 0.6, 1.7);
}

/**
 * Predict a fixture.
 * @param {object} bucket  one entry of dataset.competitions
 * @param {number} homeId
 * @param {number} awayId
 */
export function predict(bucket, homeId, awayId) {
  const homeTeam = bucket.teams.find((t) => t.id === homeId);
  const awayTeam = bucket.teams.find((t) => t.id === awayId);
  if (!homeTeam || !awayTeam) throw new Error('unknown team');
  if (homeTeam.id === awayTeam.id) throw new Error('pick two different teams');

  const league = bucket.league;
  const h = teamMetrics(homeTeam, league);
  const a = teamMetrics(awayTeam, league);

  // Base rates: league home/away scoring, times each side's attack against the other's defence.
  const base = {
    home: clamp(league.homeGoalsPerMatch * h.attackRating * a.defenceRating, 0.15, 5),
    away: clamp(league.awayGoalsPerMatch * a.attackRating * h.defenceRating, 0.15, 5),
  };

  // Recent form: each side's recent scoring/conceding against its own season rate. The square
  // root keeps a hot streak from rewriting a team's identity, and the damping means a team with
  // six matches to its name (an international tournament) cannot swing as hard as a full season.
  const formSpan = clamp(Math.sqrt(Math.min(h.played, a.played) / 12), 0.4, 1);
  const form = 1 + (clamp((h.formIndex / a.formIndex) ** 0.5, 0.75, 1.35) - 1) * formSpan;

  const elo = eloMultiplier(h.elo, a.elo);

  let possession = 1;
  let possessionNote = null;
  if (h.possession != null && a.possession != null) {
    const edge = (h.possession - a.possession) / 100;
    possession = clamp(1 + POSSESSION_WEIGHT * edge, 0.85, 1.15);
    possessionNote = `${h.possession.toFixed(1)}% vs ${a.possession.toFixed(1)}% possession`;
  }

  const h2h = headToHead(bucket, homeId, awayId);
  let h2hMultiplier = 1;
  let h2hNote = null;
  if (h2h.meetings >= 3) {
    const perGame = (h2h.homeGoals - h2h.awayGoals) / h2h.meetings;
    h2hMultiplier = clamp(1 + H2H_WEIGHT * (perGame / 2), 0.82, 1.2);
    h2hNote = `${h2h.homeWins}W-${h2h.draws}D-${h2h.awayWins}L in the last ${h2h.meetings}`;
  }

  const multipliers = { form, elo, possession, h2h: h2hMultiplier };
  const product = (m) => m.form * m.elo * m.possession * m.h2h;

  const lambdaHome = clamp(base.home * product(multipliers), 0.2, 5.5);
  const lambdaAway = clamp(base.away / product(multipliers), 0.2, 5.5);
  const full = scoreGrid(lambdaHome, lambdaAway);

  /* Leave-one-out effects: switch one factor off, keep every other one, and measure how far
   * P(home win) moves. Dividing the home rate by `f` and the away rate by `1/f` is exactly the
   * inverse of how the factor was applied, so a factor of 1.0 (no evidence) reads 0.0 here. */
  const without = (drop) => {
    const rest = product(multipliers) / multipliers[drop];
    return scoreGrid(base.home * rest, base.away / rest).probabilities.home;
  };

  const neutralRating = league.goalsPerMatch / 2;
  const noHomeField = scoreGrid(
    neutralRating * h.attackRating * a.defenceRating * product(multipliers),
    neutralRating * a.attackRating * h.defenceRating / product(multipliers),
  ).probabilities.home;

  const homeAdvantageEffect = full.probabilities.home - noHomeField;
  const eloEffect = full.probabilities.home - without('elo');
  const formEffect = full.probabilities.home - without('form');
  const possessionEffect = full.probabilities.home - without('possession');
  const h2hEffect = full.probabilities.home - without('h2h');

  const factors = [
    {
      key: 'home',
      label: 'Home field',
      detail: `${league.homeWin * 100}% of matches in this pool went to the home side`,
      effect: homeAdvantageEffect,
    },
    {
      key: 'elo',
      label: 'Overall strength (Elo)',
      detail: `${h.elo} vs ${a.elo}`,
      effect: eloEffect,
    },
    {
      key: 'form',
      label: 'Recent form',
      detail: `${h.form.map((r) => r).join('') || '—'} vs ${a.form.join('') || '—'} (last 5, oldest first)`,
      effect: formEffect,
    },
    {
      key: 'possession',
      label: 'Possession matchup',
      detail: possessionNote ?? 'no event sample for both sides',
      effect: possessionEffect,
    },
    {
      key: 'h2h',
      label: 'Head-to-head',
      detail: h2hNote ?? `${h2h.meetings} previous meeting${h2h.meetings === 1 ? '' : 's'}`,
      effect: h2hEffect,
    },
  ].sort((x, y) => Math.abs(y.effect) - Math.abs(x.effect));

  const homeProfile = profileTeam(homeTeam, bucket);
  const awayProfile = profileTeam(awayTeam, bucket);

  // Confidence: half of it is how much evidence stands behind the two ratings (event coverage and
  // matches played), the other half how far the most likely outcome is ahead of a coin-toss
  // three-way race. A 46/26/28 split is a lean, not a conviction, and the number says so.
  const evidence = Math.min(1, (h.deepMatches + a.deepMatches) / 20) * 0.5
    + Math.min(1, Math.min(h.played, a.played) / 20) * 0.5;
  const clarity = Math.max(full.probabilities.home, full.probabilities.draw, full.probabilities.away);
  const clarityScore = clamp((clarity - 1 / 3) / (2 / 3), 0, 1);

  return {
    modelVersion: MODEL_VERSION,
    bucket: bucket.key,
    home: { id: h.id, name: h.name, elo: h.elo, metrics: h },
    away: { id: a.id, name: a.name, elo: a.elo, metrics: a },
    ...full,
    base,
    multipliers,
    factors,
    h2h,
    profiles: { home: homeProfile, away: awayProfile },
    pick: full.probabilities.home >= full.probabilities.away && full.probabilities.home >= full.probabilities.draw
      ? 'home'
      : full.probabilities.away >= full.probabilities.draw ? 'away' : 'draw',
    confidence: clamp(0.15 + 0.25 * evidence + 0.5 * clarityScore, 0.12, 0.9),
  };
}

/** Score a saved prediction against the real result: right call, Brier score, log loss. */
export function scorePrediction(entry) {
  if (!entry.result) return null;
  const { home, away } = entry.result;
  const actual = home > away ? 'home' : home === away ? 'draw' : 'away';
  const probs = entry.probabilities;
  const pActual = clamp(probs[actual], 1e-6, 1);
  const oneHot = { home: 0, draw: 0, away: 0 };
  oneHot[actual] = 1;
  const brier = ['home', 'draw', 'away'].reduce((s, k) => s + (probs[k] - oneHot[k]) ** 2, 0);
  return {
    actual,
    correct: actual === entry.pick,
    brier,
    logLoss: -Math.log(pActual),
    scoreCorrect: entry.scoreline.home === home && entry.scoreline.away === away,
    goalsOff: Math.abs(entry.scoreline.home - home) + Math.abs(entry.scoreline.away - away),
  };
}
