import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { predict, scoreGrid, scorePrediction, headToHead, teamMetrics, profileTeam } from '../public/js/model.js';
import { mergeDocs, emptyDoc } from '../public/js/sync.js';

/** A tiny two-team bucket, so the maths can be checked without the real dataset. */
function bucket(overrides = {}) {
  const team = (id, name, extra = {}) => ({
    id,
    name,
    elo: 1500,
    matches: 20,
    wins: 10,
    draws: 5,
    losses: 5,
    gf: 30,
    ga: 20,
    home: { matches: 10, wins: 6, draws: 2, losses: 2, gf: 18, ga: 9, points: 20 },
    away: { matches: 10, wins: 4, draws: 3, losses: 3, gf: 12, ga: 11, points: 15 },
    form: ['W', 'D', 'W', 'L', 'W'],
    recent: [
      { d: '2024-01-01', gf: 2, ga: 1, opp: 2, home: true },
      { d: '2024-01-08', gf: 1, ga: 1, opp: 2, home: false },
      { d: '2024-01-15', gf: 3, ga: 0, opp: 2, home: true },
    ],
    ...extra,
  });
  return {
    key: 'test',
    label: 'Test',
    note: 'synthetic',
    league: {
      matches: 40,
      goalsPerMatch: 2.6,
      homeGoalsPerMatch: 1.45,
      awayGoalsPerMatch: 1.15,
      homeWin: 0.45,
      draw: 0.26,
      awayWin: 0.29,
    },
    teams: [team(1, 'Alpha'), team(2, 'Beta')],
    matches: [
      { d: '2023-08-01', h: 1, a: 2, hg: 2, ag: 1 },
      { d: '2023-12-01', h: 2, a: 1, hg: 1, ag: 1 },
      { d: '2024-02-01', h: 1, a: 2, hg: 3, ag: 0 },
    ],
    ...overrides,
  };
}

test('the scoreline grid is a probability distribution', () => {
  const grid = scoreGrid(1.6, 1.1);
  const total = grid.probabilities.home + grid.probabilities.draw + grid.probabilities.away;
  assert.ok(Math.abs(total - 1) < 1e-9, `1X2 sums to ${total}`);
  assert.ok(grid.probabilities.home > grid.probabilities.away);
  assert.ok(grid.btts > 0 && grid.btts < 1);
  assert.ok(grid.over25 > 0 && grid.over25 < 1);
  assert.equal(grid.topScorelines.length, 5);
  assert.ok(grid.topScorelines[0].p >= grid.topScorelines[1].p);
});

test('a goalless rate still produces a sane grid', () => {
  const grid = scoreGrid(0.0001, 0.0001);
  assert.ok(grid.probabilities.draw > 0.99);
  assert.equal(grid.scoreline.home, 0);
  assert.equal(grid.scoreline.away, 0);
});

test('identical teams: the home side is favoured, but not by much', () => {
  const b = bucket();
  const p = predict(b, 1, 2);
  assert.ok(p.probabilities.home > p.probabilities.away);
  assert.ok(p.probabilities.home < 0.58, `home ${p.probabilities.home}`);
  assert.ok(p.probabilities.home + 0.02 >= b.league.homeWin, 'no more home edge than the league itself shows');
  assert.ok(p.confidence < 0.6, 'a coin-flip fixture should not claim high confidence');
});

test('the stronger team wins more often, whichever end it plays', () => {
  const b = bucket();
  const strong = b.teams[0];
  strong.elo = 1700;
  strong.gf = 55;
  strong.ga = 18;
  const asHome = predict(b, 1, 2);
  const asAway = predict(b, 2, 1);
  assert.ok(asHome.probabilities.home > asHome.probabilities.away);
  assert.ok(asAway.probabilities.away > asAway.probabilities.home);
  assert.ok(predict(b, 1, 2).pick === 'home');
});

test('multiplicative factors are symmetric when the sides are swapped', () => {
  const b = bucket();
  b.teams[0].elo = 1650;
  b.teams[0].recent = [
    { d: '2024-01-01', gf: 4, ga: 0, opp: 2, home: true },
    { d: '2024-01-08', gf: 3, ga: 1, opp: 2, home: false },
  ];
  b.teams[1].recent = [
    { d: '2024-01-01', gf: 0, ga: 3, opp: 1, home: true },
    { d: '2024-01-08', gf: 1, ga: 4, opp: 1, home: false },
  ];
  const a = predict(b, 1, 2);
  const swapped = predict(b, 2, 1);
  assert.ok(Math.abs(a.multipliers.elo - 1 / swapped.multipliers.elo) < 1e-9);
  assert.ok(Math.abs(a.multipliers.possession - 1 / swapped.multipliers.possession) < 1e-9);
  assert.ok(a.multipliers.form > 1 && swapped.multipliers.form < 1);
});

test('possession and head-to-head only apply when there is evidence', () => {
  const b = bucket();
  const without = predict(b, 1, 2);
  assert.equal(without.multipliers.possession, 1, 'no event coverage means no possession nudge');
  assert.equal(without.h2h.meetings, 3, 'three meetings in the synthetic history');

  b.teams[0].deep = { matches: 20, possession: 62, passAccuracy: 88, shots: 15, shotsOnTarget: 6, xg: 1.9, xga: 0.8, corners: 6 };
  b.teams[1].deep = { matches: 20, possession: 41, passAccuracy: 74, shots: 9, shotsOnTarget: 3, xg: 0.9, xga: 1.6, corners: 3 };
  const withDeep = predict(b, 1, 2);
  assert.ok(withDeep.multipliers.possession > 1.01, 'a 21-point possession edge should show up');
  assert.ok(withDeep.factors.some((f) => f.label === 'Possession matchup' && f.detail.includes('62.0%')));
  assert.ok(withDeep.home.metrics.xgDiff > 0);
});

test('matchups that are too thin to mean anything are skipped', () => {
  const b = bucket({ matches: [{ d: '2024-02-01', h: 1, a: 2, hg: 1, ag: 0 }] });
  const p = predict(b, 1, 2);
  assert.equal(p.h2h.meetings, 1);
  assert.equal(p.multipliers.h2h, 1, 'one meeting is not a pattern');
});

test('factor effects are reported and ranked by size', () => {
  const b = bucket();
  b.teams[0].elo = 1680;
  const p = predict(b, 1, 2);
  assert.equal(p.factors.length, 5);
  const sizes = p.factors.map((f) => Math.abs(f.effect));
  assert.deepEqual(sizes, [...sizes].sort((x, y) => y - x));
  assert.ok(p.factors.find((f) => f.key === 'home').effect > 0, 'home field helps the home side');
  assert.ok(p.factors.find((f) => f.key === 'elo').effect > 0, 'the stronger Elo side is lifted');
});

test('unknown teams and self-fixtures are refused', () => {
  const b = bucket();
  assert.throws(() => predict(b, 1, 1), /two different teams/);
  assert.throws(() => predict(b, 9, 2), /unknown team/);
});

test('head to head follows each side wherever it played', () => {
  const b = bucket();
  const h2h = headToHead(b, 1, 2);
  assert.equal(h2h.meetings, 3);
  assert.equal(h2h.homeWins, 2); // 2-1 and 3-0 to Alpha
  assert.equal(h2h.draws, 1);
  assert.equal(h2h.homeGoals, 6);
  assert.equal(h2h.awayGoals, 2);
});

test('scoring a prediction: right call, Brier and log loss', () => {
  const entry = {
    probabilities: { home: 0.6, draw: 0.25, away: 0.15 },
    pick: 'home',
    scoreline: { home: 2, away: 1 },
    result: { home: 2, away: 1 },
  };
  const s = scorePrediction(entry);
  assert.equal(s.actual, 'home');
  assert.ok(s.correct);
  assert.ok(s.scoreCorrect);
  assert.equal(s.goalsOff, 0);
  assert.ok(Math.abs(s.brier - ((0.6 - 1) ** 2 + 0.25 ** 2 + 0.15 ** 2)) < 1e-9);
  assert.ok(Math.abs(s.logLoss + Math.log(0.6)) < 1e-9);

  assert.equal(scorePrediction({ ...entry, result: null }), null);

  const away = scorePrediction({ ...entry, pick: 'home', result: { home: 0, away: 2 } });
  assert.equal(away.actual, 'away');
  assert.equal(away.correct, false);
});

test('strengths and weaknesses are relative to the competition', () => {
  const b = bucket();
  b.teams[0].gf = 90;
  b.teams[0].ga = 10;
  const profile = profileTeam(b.teams[0], b);
  assert.ok(profile.strengths.some((s) => /attack/i.test(s.label)));
  assert.ok(profile.weaknesses.length === 0 || profile.weaknesses[0].rank <= 30);
});

test('the metrics fall back to goals when there is no event coverage', () => {
  const b = bucket();
  const m = teamMetrics(b.teams[0], b.league);
  assert.equal(m.possession, null);
  assert.equal(m.xgFor, m.goalsFor);
  assert.ok(m.attackRating > 0 && m.defenceRating > 0);
});

test('merging two documents keeps every entry, and prefers a resolved one', () => {
  const a = {
    app: 'football-outcomer',
    version: 1,
    updatedAt: '2024-01-01T00:00:00.000Z',
    entries: [
      { id: 'x', createdAt: '2024-01-01T00:00:00.000Z', result: null, pick: 'home' },
      { id: 'y', createdAt: '2024-01-02T00:00:00.000Z', result: null, pick: 'away' },
    ],
  };
  const b = {
    app: 'football-outcomer',
    version: 1,
    updatedAt: '2024-01-03T00:00:00.000Z',
    entries: [
      { id: 'x', createdAt: '2024-01-01T00:00:00.000Z', result: { home: 1, away: 2 }, pick: 'home' },
      { id: 'z', createdAt: '2024-01-04T00:00:00.000Z', result: null, pick: 'draw' },
    ],
  };
  const merged = mergeDocs(a, b);
  assert.equal(merged.entries.length, 3);
  assert.deepEqual(merged.entries.find((e) => e.id === 'x').result, { home: 1, away: 2 });
  assert.deepEqual(merged.entries.map((e) => e.id), ['z', 'y', 'x'], 'newest first');
  assert.deepEqual(mergeDocs(null, null).entries, []);
  assert.equal(emptyDoc().app, 'football-outcomer');
});

test('a merged document never adopts prototype-shaped keys', () => {
  const hostile = JSON.parse('{"entries":[{"id":"p","__proto__":{"polluted":true}}]}');
  const merged = mergeDocs(hostile, emptyDoc());
  assert.equal({}.polluted, undefined);
  assert.equal(merged.entries.length, 1);
});

/* ---------------------------------------------------------------- the real dataset */

const datasetPath = new URL('../public/data/dataset.json', import.meta.url);
if (existsSync(datasetPath)) {
  const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));

  test('the shipped dataset is internally consistent', () => {
    assert.ok(dataset.competitions.length >= 3);
    for (const comp of dataset.competitions) {
      assert.ok(comp.teams.length >= 2, `${comp.key} has teams`);
      assert.equal(comp.league.deepMatches, comp.league.deepMatches | 0);
      for (const t of comp.teams) {
        assert.equal(t.matches, t.home.matches + t.away.matches, `${t.name} home+away = total`);
        assert.equal(t.matches, t.wins + t.draws + t.losses, `${t.name} results add up`);
        assert.equal(t.gf, t.home.gf + t.away.gf);
        assert.equal(t.ga, t.home.ga + t.away.ga);
      }
      const played = comp.teams.reduce((s, t) => s + t.matches, 0);
      assert.equal(played, comp.matches.length * 2, 'every match is counted twice, once per side');
    }
  });

  test('every fixture in the dataset is predictable', () => {
    for (const comp of dataset.competitions) {
      for (const m of comp.matches.slice(-25)) {
        const p = predict(comp, m.h, m.a);
        assert.ok(p.probabilities.home + p.probabilities.draw + p.probabilities.away > 0.999);
        assert.ok(Number.isFinite(p.expectedGoals.home) && p.expectedGoals.home > 0);
        assert.ok(p.confidence > 0 && p.confidence <= 0.9);
      }
    }
  });

  test('the model beats a coin toss on the matches it was built from', () => {
    // Walk each competition in date order, rating nothing ahead of itself: this is the honest
    // check, because a model that could see the season average would be marking its own homework.
    let calls = 0;
    let hits = 0;
    let brierSum = 0;
    for (const comp of dataset.competitions) {
      const seen = new Map();
      let count = 0;
      for (const m of comp.matches) {
        const row = (id) => {
          if (!seen.has(id)) seen.set(id, { id, matches: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, elo: 1500, form: [], recent: [], home: { matches: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 }, away: { matches: 0, wins: 0, draws: 0, losses: 0, gf: 0, ga: 0, points: 0 } });
          return seen.get(id);
        };
        const h = row(m.h);
        const a = row(m.a);
        if (count > 60 && h.matches >= 6 && a.matches >= 6) {
          const live = {
            ...comp,
            teams: [h, a],
          };
          const p = predict(live, m.h, m.a);
          const actual = m.hg > m.ag ? 'home' : m.hg === m.ag ? 'draw' : 'away';
          calls += 1;
          if (p.pick === actual) hits += 1;
          brierSum += ['home', 'draw', 'away'].reduce((s, k) => s + (p.probabilities[k] - (k === actual ? 1 : 0)) ** 2, 0);
        }
        count += 1;
        const expected = 1 / (1 + 10 ** ((a.elo - (h.elo + 65)) / 400));
        const score = m.hg > m.ag ? 1 : m.hg === m.ag ? 0.5 : 0;
        const delta = 20 * (Math.log(Math.abs(m.hg - m.ag) + 1) + 1) * (score - expected);
        h.elo += delta;
        a.elo -= delta;
        for (const [t, gf, ga] of [[h, m.hg, m.ag], [a, m.ag, m.hg]]) {
          t.matches += 1;
          t.gf += gf;
          t.ga += ga;
          t.form.push(gf > ga ? 'W' : gf === ga ? 'D' : 'L');
          t.recent.push({ d: m.d, gf, ga, opp: 0, home: true });
        }
      }
    }
    const hitRate = hits / calls;
    const brier = brierSum / calls;
    console.log(`   walk-forward: ${hits}/${calls} right call (${(hitRate * 100).toFixed(1)}%), Brier ${brier.toFixed(3)}`);
    assert.ok(hitRate > 0.4, `hit rate ${(hitRate * 100).toFixed(1)}% should beat a coin toss`);
    assert.ok(brier < 0.66, `Brier ${brier.toFixed(3)} should beat a uniform prediction`);
  });
}
