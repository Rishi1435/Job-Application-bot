# Job Application Bot

A self-hosted job hunting assistant. Every night it scrapes job boards, asks an
LLM how well each posting matches your resume, stores the results in SQLite, and
serves them on a dark-mode dashboard with one-click Excel export.

```
cron (00:00) ──▶ scraper ──▶ matcher (NVIDIA LLM) ──▶ SQLite ──▶ Express API ──▶ dashboard ──▶ .xlsx
```

## Features

- **Config-driven crawler** - add a board by adding selectors, not code. Supports
  local HTML, static HTML (Cheerio), JS-rendered pages (Puppeteer) and JSON feeds.
- **LLM resume matching** - each new posting is scored 0-100 with a one-sentence
  justification by a model on the NVIDIA API catalog (default
  `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`; `meta/llama-3.3-70b-instruct`
  and friends work too).
- **De-duplication** - postings are unique per apply URL; re-seeing a job bumps
  `lastSeenAt`/`timesSeen` instead of re-scoring it, so no LLM budget is wasted.
- **Dashboard** - dark theme, sortable columns, live search, minimum-score
  slider, and the match reason inline under each title.
- **Excel export** - downloads whatever is currently filtered/sorted on screen,
  with a CSV fallback if the SheetJS CDN is unreachable.
- **Resilient** - per-source error isolation, retries with backoff, encoding
  repair, and a keyword-scoring fallback when the LLM is unavailable.

## Quick start

```bash
npm install
cp .env.example .env        # add your NVIDIA_API_KEY (optional, see below)
npm run scrape              # seed the database once
npm start                   # http://localhost:3000
```

The app ships with an offline sample board (`mock-job-board.html`) plus the live
RemoteOK feed, so `npm run scrape` produces real rows immediately.

### Getting an NVIDIA API key

1. Sign in at <https://build.nvidia.com/>.
2. Open any model page (e.g. Llama 3.3 70B Instruct) and click **Get API Key**.
3. Put the `nvapi-...` value in `.env` as `NVIDIA_API_KEY`.

Without a key the app still runs end-to-end - it falls back to a local
keyword-density score and says so in the match reason.

## Project layout

| Path | Purpose |
| --- | --- |
| [server.js](server.js) | Express app, JSON API, node-cron schedule, graceful shutdown |
| [services/scraper.js](services/scraper.js) | Fetch strategies, run orchestration, de-dup + persistence |
| [services/parser.js](services/parser.js) | Pure HTML/text extraction helpers (unit-tested) |
| [services/matcher.js](services/matcher.js) | LLM scoring, JSON repair, retries, keyword fallback |
| [services/database.js](services/database.js) | SQLite schema, migrations, queries, run history |
| [config/sources.js](config/sources.js) | Job board definitions and CSS selectors |
| [config/profile.js](config/profile.js) | Target role + resume text |
| [public/](public/) | Dashboard (vanilla HTML/CSS/JS) |
| [scripts/scrape.js](scripts/scrape.js) | `npm run scrape` - one-off run from the CLI |
| [tests/units.test.js](tests/units.test.js) | `npm test` - node:test unit tests |

## Configuration

Everything is environment-driven; see [.env.example](.env.example) for the full
list. The ones you are most likely to touch:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NVIDIA_API_KEY` | *(unset)* | Enables LLM scoring |
| `NVIDIA_MODEL` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Any model on the NVIDIA catalog |
| `MATCHER_MAX_TOKENS` | `4096` | Must cover reasoning **and** the JSON answer |
| `MATCHER_REASONING_BUDGET` | `2048` | Thinking budget; ignored by non-reasoning models |
| `TARGET_ROLE` | `Full Stack / Mobile Developer` | Role the LLM scores against |
| `RESUME_PATH` | *(unset)* | Plain-text resume; falls back to `./resume.txt`, then the built-in default |
| `CRON_SCHEDULE` | `0 0 * * *` | Daily at midnight |
| `CRON_TIMEZONE` | system zone | e.g. `Asia/Kolkata` |
| `RUN_ON_STARTUP` | `false` | Scrape once on boot |
| `ENABLED_SOURCES` | *(unset)* | Comma-separated source ids, overrides the `enabled` flags |
| `PORT` | `3000` | HTTP port |

### Customising your resume

Either edit `DEFAULT_RESUME_TEXT` in [config/profile.js](config/profile.js) or
drop a `resume.txt` in the project root (gitignored). Keep the "GAPS" section
honest - the prompt tells the model to penalise missing must-haves, which is
what stops every posting scoring 85.

## Adding a job board

Add an entry to `SOURCES` in [config/sources.js](config/sources.js):

```js
{
  id: 'my-board',
  name: 'My Board',
  enabled: true,
  mode: 'static',                       // 'file' | 'static' | 'dynamic' | 'json'
  url: 'https://board.example.com/jobs',
  baseUrl: 'https://board.example.com', // resolves relative apply links
  selectors: {
    card: '.job-card',                  // repeated wrapper element
    title: '.job-card__title',
    company: '.job-card__company',
    description: '.job-card__summary',
    date: 'time',
    dateAttr: 'datetime',               // prefer this attribute over the text
    link: 'a.job-card__link',
  },
  maxJobs: 25,
}
```

Then `ENABLED_SOURCES=my-board npm run scrape` to try it. Only `title` and a
usable apply URL are mandatory; anything else missing just comes back empty.

**Dynamic boards** (`mode: 'dynamic'`) need Puppeteer, which is declared as an
optional dependency so the normal install stays lightweight:

```bash
npm install puppeteer
```

The scraper sends realistic browser headers, randomises the delay between
requests, retries on 429/5xx, and hides `navigator.webdriver` in Puppeteer.
That clears ordinary bot checks - it will not beat Cloudflare challenges or
boards that require a login, and it does not try to. Check a board's terms and
`robots.txt` before enabling it.

## API

| Method | Route | Description |
| --- | --- | --- |
| `GET` | `/api/jobs` | All jobs, score descending. Query: `minScore`, `q`, `limit` |
| `GET` | `/api/stats` | Totals, strong matches, average score, last sighting |
| `GET` | `/api/status` | Scraper state, cron schedule, model, sources, last run |
| `POST` | `/api/scrape` | Run a scrape now (409 while one is in flight) |
| `GET` | `/api/health` | Liveness probe |

## Scheduling

`server.js` registers the cron job in-process, so the daily run happens as long
as the server is up. For a machine that reboots, prefer an OS-level schedule
calling `npm run scrape`, or run the server under a process manager:

```bash
pm2 start server.js --name job-bot
```

## Tests

```bash
npm test
```

Covers HTML extraction, URL resolution, date normalisation, encoding repair,
LLM-response parsing and the keyword fallback ranking - all without network or
database access.

## Notes and limits

- **Data source attribution**: the RemoteOK source uses their public JSON feed;
  their terms ask for attribution if you republish the postings.
- **RemoteOK quirks**: the feed covers the whole board and its `tags` are
  keyword-stuffed, so the source filters on job title only. Some rows also
  arrive double-encoded; `services/parser.js` repairs that.
- **Scores are advisory.** The model sees the posting text, not the hiring bar.
- The dashboard renders scraped text with `textContent`, never `innerHTML`, so a
  malicious posting cannot inject markup.
