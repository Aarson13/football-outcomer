# Football Outcomer

Match outcome probabilities from real football data, not vibes.

Pick a fixture and the page returns a full scoreline distribution — home/draw/away split, the
most likely score, expected goals, over 2.5 and both-teams-to-score — plus the factors that moved
the number and each team's strengths and weaknesses. Every prediction you save is synced to a
Cloudflare D1 database (or a JSON file on GitHub) and graded once you enter the result.

**Live:** https://football-outcomer.pages.dev

---

## The data

Everything comes from **[Hudl's open data repository](https://github.com/hudl/open-data)** —
StatsBomb's published open data. `scripts/build-dataset.mjs` pulls it and builds a compact
dataset into `public/data/dataset.json` (≈165 KB). Nothing is scraped from a live site, and the
app never calls a third party at runtime: it reads that one file.

| Bucket | Matches | Event coverage | Why this one |
|---|---|---|---|
| Premier League 2015/16 | 380 | 380 (every match) | a complete season, so possession/xG are real for all 20 clubs |
| International tournaments (World Cup 2022, Euro 2024, Copa América 2024) | 147 | 147 | recent, complete, and 52 national teams |
| La Liga | 867 | 35 | 18 seasons of goals for form, Elo and head-to-head |

Two tiers are fetched, because the open data is deliberately partial:

1. `matches/<competition>/<season>.json` — cheap and complete where published. Feeds Elo, form,
   goals for/against, home advantage and head-to-head.
2. `events/<match_id>.json` — 3–4 MB per match. Parsed for **possession time** (summed event
   durations per possession side), shots, shots on target, xG/xGA and passing, then discarded;
   only per-team averages are kept.

```bash
npm run data          # rebuild public/data/dataset.json from the open data
```

To extend it, edit `PLANS` in `scripts/build-dataset.mjs`: add a competition/season id pair from
`competitions.json` in the source repo. Pick seasons with complete event coverage, otherwise the
possession and xG factors fall back to goals for those teams.

## The model

`public/js/model.js` is pure and dependency-free, so the tests run the exact numbers the page shows.

1. **Rates.** Per team: goals for/against per game blended 55/45 with xG for/against (when event
   data exists), normalised against the competition average. This is the goal-stats and defence
   factor, and blending in xG stops it being a pure form-chaser.
2. **Expected goals.** `λ_home = league_home_goals × attack(home) × defence(away)`, and the mirror
   for the away side. Home field lives here, measured from the league's own home/away rates.
3. **Four adjustments**, each multiplicative and symmetric: recent form (weighted, damped for
   small samples), Elo (computed from every result in date order), the possession matchup, and
   head-to-head history (only after three meetings).
4. **Scoreline grid.** Two independent Poisson distributions crossed into an 8×8 grid, which gives
   the 1X2 split, most likely score, over/under and BTTS.

Every factor is reported as a **leave-one-out effect**: switch it off, keep the rest, and report
how far P(home win) moves. A factor with no evidence reads `0.0` rather than inventing a number.

Calibration is checked, not assumed: `npm test` walks each competition in date order and predicts
each match from only the matches before it — **55.7% of calls right, Brier 0.600** on 1,007
out-of-sample fixtures (a uniform 1/3 guess scores 0.667). That is roughly the ceiling for a
goals-based club model, and it is stated plainly on the page rather than hidden.

## Sync

The prediction log is one JSON document. Two interchangeable targets:

- **Cloudflare D1 (default).** `POST /api/spaces` mints a 12-character space id and a 32-character
  key; the server stores only the key's SHA-256. `rev` makes writes conditional, so two devices
  cannot silently clobber each other — the loser gets `409` with the winner's document, merges and
  retries once. Settings → *Copy space id & key* is how a second device joins.
- **A JSON file on GitHub** through the Contents API, with a fine-grained token that has
  *Contents: read and write* on one repository. Every entry is a commit, so git history is the
  audit trail. Registering the token is optional; if you do, it stays in one `localStorage` key and
  is never written into the document. A separate data repository is the right choice here,
  because committing to the site's own repository would trigger a redeploy per entry.

Both targets **pull before every write and on every page load**, so the stored copy is the source
of truth and nothing is cached on the device. A failed write turns the sync chip red and says so;
it never pretends to have saved.

## Layout

```
public/                     # the whole site — uploaded as static assets
  index.html  styles.css  icon.svg  _headers
  js/model.js               # prediction engine (pure, tested)
  js/sync.js                # D1 + GitHub backends, merge logic
  js/app.js                 # rendering and events
  data/dataset.json         # generated from the open data
functions/api/[[path]].js   # Pages Function → worker/api.js for every /api/*
worker/api.js               # the sync service: spaces, doc read, conditional write
scripts/build-dataset.mjs   # Hudl open-data → dataset.json
tests/model.test.mjs        # engine, merge, dataset consistency, walk-forward calibration
wrangler.jsonc              # Pages project + DB (D1) binding
```

## Development

```bash
npm install
npm run dev      # wrangler pages dev — assets + functions + a local D1 on :8788
npm test         # 18 tests, including the walk-forward backtest
npm run data     # rebuild the dataset (~500 event files) 
npm run deploy   # upload public/ + functions/ to the football-outcomer project
```

No framework, no bundler, no runtime dependencies: the page is three ES modules and one
stylesheet. The Content-Security-Policy allows `'self'` plus the GitHub API and, for convenience,
`raw.githubusercontent.com`; there is no inline script or inline style anywhere.

## Limits, stated

- The Premier League bucket is a single completed season (2015/16) because that is the only
  English season the open data ships with complete events. It predicts those teams as they were,
  not as they are now.
- La Liga has only 35 matches with event data, so its possession and xG figures cover a sample and
  the UI says "no event sample" where it does not apply.
- Elo pools are per bucket. A 2016 Arsenal rating is never compared with a 2024 India one.
- Draws are the hardest call and the model does not pretend otherwise: the most likely score is
  often a draw while the most likely *result* is a narrow win.
- Predictions are probabilities. A 70% favourite loses three times in ten.
