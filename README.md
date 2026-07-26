# Job Application Bot

A multi-tenant, cloud-ready job hunting assistant. Users sign up, upload as many
resumes as they like, and the bot scrapes a fixed list of trusted company career
pages, asks an LLM on the NVIDIA API catalog to categorise each role
(**Internship** vs **Full-Time Job**) and pick the best resume for it, then serves
everything on a dark-mode dashboard with per-tab Excel export.

```
cron (00:00) ─▶ Puppeteer scraper ─▶ trusted-company filter ─▶ NVIDIA LLM matcher
                                                                      │
                            per-user match_data (JSONB) ─▶ PostgreSQL ─┘
                                                                      │
                             JWT-protected Express API ─▶ dashboard ─▶ .xlsx
```

## Features

- **Multi-tenant by construction** - `users`, `resumes` and `jobs` are all keyed
  by `user_id`, and every query in [services/database.js](services/database.js)
  filters by it. One crawl feeds every tenant; scoring and storage are private.
- **JWT auth** - register/login with bcrypt-hashed passwords; the token is kept
  in `localStorage` and required by every `/api/resumes`, `/api/jobs`,
  `/api/scrape` and `/api/status` route.
- **In-memory resume parsing** - PDFs go through `pdf-parse`, DOCX through
  `mammoth`, straight from multer's memory storage. Only the extracted text is
  persisted; no file ever touches the disk, which is what makes this safe on
  Render's ephemeral filesystem.
- **Trusted-source scraping** - Puppeteer visits *only* the URLs in
  [config/sources.js](config/sources.js). Every company that owns a configured
  board is trusted automatically, so adding a career page is a one-line change;
  `TRUSTED_COMPANIES` is only for boards that list somebody else's postings.
  26 boards ship by default, weighted towards employers hiring in India.
- **Relevance gate** - every posting is screened against a profile derived from
  the candidate's resumes - seniority, role family and country - *before* it
  reaches the LLM. Roles in another field, several levels above them, or in
  another country are answered locally and never cost a call. See
  [the relevance gate](#the-relevance-gate).
- **LLM categorisation + resume selection** - one call returns
  `{job_type, best_resume_id, best_resume_name, score, reason}`, validated
  against the resumes that were actually sent and stored in the `match_data`
  JSONB column.
- **Compensation bar** - a posting is only recommended if the pay it advertises
  clears a floor: **10 LPA** for base/gross salary, **15 LPA** when the figure is
  quoted as **CTC**. See [the pay bar](#the-pay-bar) for why the two differ.
- **Tabbed dashboard** - Internships and Full-Time in separate tabs, with search,
  a minimum-score slider, sorting, light/dark themes and an Excel export that
  downloads **only the active tab**.
- **Resilient** - per-source error isolation, retries with backoff, a generic
  anchor-scan fallback when a board restyles its markup, and deterministic
  keyword scoring when the LLM is unavailable.

## Quick start

```bash
npm install
cp .env.example .env         # set DATABASE_URL, JWT_SECRET, NVIDIA_API_KEY

# a throwaway local database
docker run -d --name jobbot-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=jobbot postgres:16

npm run verify               # checks Postgres, resume parsing and the NVIDIA API
npm start                    # http://localhost:3000
```

Open the dashboard, create an account, upload a resume, then hit **Run Scrape**.

The bundled offline board (`mock-job-board.html`) is off by default because its
apply URLs point at `*.example.com`, which resolves nowhere - a board full of
dead "Apply" buttons. Set `ENABLE_MOCK_BOARD=true` to run the pipeline with no
network access.

`npm run scrape` does the same thing from the CLI (`-- --user <id|name>` for one
tenant, `-- --rescore` to re-run the matcher over postings that were stored
without a verdict).

### Getting an NVIDIA API key

1. Sign in at <https://build.nvidia.com/>.
2. Open any model page (e.g. Llama 3.3 70B Instruct) and click **Get API Key**.
3. Put the `nvapi-...` value in `.env` as `NVIDIA_API_KEY`.

Without a key the app still runs end-to-end - it falls back to local keyword
scoring plus a regex categoriser, and says so in the match reason.

## Project layout

| Path | Purpose |
| --- | --- |
| [server.js](server.js) | Express app, auth + upload routes, cron schedule, graceful shutdown |
| [services/auth.js](services/auth.js) | bcrypt hashing, JWT issuing, `requireAuth` middleware |
| [services/database.js](services/database.js) | PostgreSQL pool, schema, tenant-scoped parameterised queries |
| [services/scraper.js](services/scraper.js) | Puppeteer crawl, trusted-company filter, per-tenant persistence |
| [services/matcher.js](services/matcher.js) | NVIDIA LLM prompt, JSON validation, keyword fallback |
| [services/compensation.js](services/compensation.js) | Pay extraction (LPA/CTC/foreign/monthly) and the pay bar |
| [services/relevance.js](services/relevance.js) | Candidate profile, and the seniority / role-family / location gate |
| [services/parser.js](services/parser.js) | HTML extraction + in-memory PDF/DOCX resume parsing |
| [config/sources.js](config/sources.js) | Career-page URLs, ATS selector profiles, trusted companies |
| [public/](public/) | Dashboard (vanilla HTML/CSS/JS, dark theme) |
| [scripts/scrape.js](scripts/scrape.js) | `npm run scrape` - CLI run, all users or one |
| [scripts/rescreen.js](scripts/rescreen.js) | `npm run rescreen` - re-apply the gate to stored postings, no LLM calls |
| [public/motion.js](public/motion.js) | Framer-Motion-style primitives (springs, stagger, FLIP, presence) on the Web Animations API |
| [tests/verify.js](tests/verify.js) | `npm run verify` - live Postgres + NVIDIA checks |
| [tests/](tests/) | `npm test` - offline node:test unit tests (units, compensation, relevance) |
| [Dockerfile](Dockerfile) | `node:20-slim` + system Chromium, for Render |

## Configuration

Everything is environment-driven; see [.env.example](.env.example) for the full
list. The ones that matter most:

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | *(required)* | PostgreSQL connection string |
| `DATABASE_SSL` | auto | `true`/`false` override; auto-off for localhost |
| `JWT_SECRET` | *(required)* | 16+ random characters; rotating it logs everyone out |
| `NVIDIA_API_KEY` | *(unset)* | Enables LLM categorisation and scoring |
| `NVIDIA_MODEL` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | Any model on the NVIDIA catalog. `meta/llama-3.3-70b-instruct` currently times out on the public endpoint |
| `MIN_LPA_SALARY` | `10` | Floor for postings quoting base/gross salary |
| `MIN_LPA_CTC` | `15` | Floor for postings quoting CTC / total package |
| `INTERNSHIP_ENFORCE_PAY` | `false` | Apply the bar to internships too |
| `INR_PER_USD` | `88` | FX used to convert foreign pay to LPA |
| `TRUSTED_COMPANIES` | list in `config/sources.js` | Comma-separated allow-list override |
| `ENABLED_SOURCES` | *(unset)* | Comma-separated source ids |
| `SCRAPER_DETAIL_LIMIT` | `3` | Job pages opened per board for the full description |
| `MAX_JOBS_PER_SOURCE` | `25` | Cap per board per run |
| `ENABLE_MOCK_BOARD` | `false` | Offline demo board. Its apply URLs are `*.example.com` and resolve nowhere |
| `RELEVANCE_MAX_LEVEL_STRETCH` | `1` | How many rungs above the candidate a posting may sit |
| `CRON_SCHEDULE` | `*/30 * * * *` | Every 30 minutes, for all tenants. Any 5-field cron expression |
| `RUN_ON_STARTUP` | `false` | Scrape once on boot |
| `PORT` | `3000` | HTTP port |

## The relevance gate

Before any posting reaches the LLM it is screened against a profile derived from
the candidate's own resumes (`services/relevance.js`, exposed at
`GET /api/resumes/profile`): their **seniority**, the **role families** they have
actually worked in, and the **country** they are in.

Two accounts with resumes in different fields therefore get different boards. The
field is scored per family from evidence - a job title the candidate actually held
is worth three skill mentions - rather than inferred from tooling, because tools
are shared across careers. Counting "3+ recognised technical skills" as proof of
software engineering, which an earlier version did, labelled an MBA in Business
Analytics a backend engineer purely because her resume named Python and SQL.
A resume that states no field at all yields an empty list, and the field check is
then skipped rather than guessed.

This exists because asking a model "how well does this resume fit?" gets an answer
about *skill overlap*, and skill overlap says yes to a Director of Engineering
posting that shares four technologies with a ten-month intern's resume. Seniority
and country are not judgement calls, so they are not left to a prompt.

| Verdict | Meaning | Score cap | On the board |
| --- | --- | --- | --- |
| `match` | Right country, family and level | none | shown |
| `stretch` | One level up, or an adjacent family | 75 | shown |
| `overreach` | Two or more levels above the candidate | 25 | hidden |
| `mismatch` | A different line of work | 15 | hidden |
| `elsewhere` | Based in a country they are not in | 15 | hidden |

Notes:

- **The gate runs before the model, not after.** `overreach`, `mismatch` and
  `elsewhere` are answered locally and never cost an LLM call - on a typical run
  that is ~85% of what was scraped (359 of 382 in the last full run).
- **The cap is enforced in code**, in `parseMatchData()`. The prompt asks the model
  to respect seniority and it mostly does, but a prompt is not a constraint.
- **Location is an allow-list**: a posting is kept if it names an office in India
  *or* every office it names is unrestricted remote. `"New York, NY (HQ); Remote"`
  is a US role that allows working from home, and is rejected; `"Remote Globally"`
  is not. A posting whose location could not be read is kept.
- **An unclassifiable title is a rejection.** Reaching the `other` family means no
  signal from any family - including engineering - matched the title or the body.
- **Nothing is deleted.** Gated postings are stored and reappear via the
  *Show filtered-out* toggle (`GET /api/jobs?includeMismatch=true`), so changing
  the rules takes effect with `npm run rescreen` rather than a re-scrape.
- The gate only reasons about India. For a candidate anywhere else the location
  check stays out of the way; seniority and role family still apply.

## The pay bar

Postings are filtered on the compensation they advertise:

| Posting says | Bar | Example |
| --- | --- | --- |
| Base / gross **salary** | **≥ 10 LPA** | "Salary: 8 LPA" → hidden; "12 LPA" → shown |
| **CTC** / total package | **≥ 15 LPA** | "CTC 13 LPA" → hidden even though it beats 10 |
| Monthly **stipend** | exempt | intern stipends are not annual figures |
| **Nothing** | kept, marked *Not stated* | most US career pages omit pay entirely |

The two thresholds differ because CTC bundles employer PF, gratuity, insurance,
bonus and ESOP notionals into the headline number, so a 15 LPA CTC and a 10 LPA
base are roughly the same offer. Judging both against one figure would
systematically over-value CTC postings.

Details that matter in practice:

- **Ranges are judged on their upper end** - an "8 - 20 LPA" posting is worth
  recommending.
- **Foreign pay is converted** at the `INR_PER_*` rates (default 1 USD = 88 INR),
  so `$150,000 - $200,000` reads as 132-176 LPA.
- **Below-bar postings are stored, not discarded** - they are excluded from the
  dashboard and the export, and reappear via the *Show below-bar pay* toggle
  (`GET /api/jobs?includeBelowBar=true`). Changing a threshold therefore takes
  effect without a re-scrape.
- **The figure is read from the posting text**, by regex first and the LLM only
  as a fallback that must quote text present in the listing - a model asked for
  a number will otherwise supply a plausible market rate for a posting that
  stated none.
- The bar is deterministic, so it applies identically when the LLM is down.

Tune with `MIN_LPA_SALARY`, `MIN_LPA_CTC`, `INTERNSHIP_ENFORCE_PAY` and the
`INR_PER_*` rates.

## API

All routes except `/api/auth/*` and `/api/health` require
`Authorization: Bearer <jwt>`.

| Method | Route | Description |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account, returns `{token, user}` |
| `POST` | `/api/auth/login` | Exchange credentials for a token |
| `GET` | `/api/auth/me` | Identity behind the current token |
| `GET` | `/api/resumes` | This user's resumes (metadata only) |
| `POST` | `/api/resumes` | Multipart upload, field `resumes`, up to 10 files |
| `DELETE` | `/api/resumes/:id` | Delete one resume |
| `GET` | `/api/resumes/profile` | Seniority, role families and country the gate screens against |
| `GET` | `/api/jobs` | Jobs, best match first. Query: `jobType`, `minScore`, `q`, `limit`, `includeBelowBar`, `includeMismatch` |
| `GET` | `/api/jobs/stats` | Totals, per-category counts, average score |
| `DELETE` | `/api/jobs/:id`, `/api/jobs` | Remove one posting / clear the board |
| `POST` | `/api/scrape` | Run the pipeline now for the calling user (409 if busy) |
| `GET` | `/api/status` | Scheduler state, sources, trusted companies, last run |
| `GET` | `/api/health` | Liveness probe (public) |

## Adding a company

One line in [config/sources.js](config/sources.js):

```js
const SOURCE_URLS = [
  'https://job-boards.greenhouse.io/your-company',   // Greenhouse / Lever / Ashby
];

// Optional - only to override the name derived from the slug.
const SOURCE_OVERRIDES = {
  'https://job-boards.greenhouse.io/your-company': { company: 'Your Company' },
};
```

The employer is trusted automatically because the board belongs to them; there is
no second list to keep in sync. Greenhouse, Lever and Ashby URLs are recognised by
hostname and get their selectors from the matching ATS profile. Anything else
falls back to the `generic` profile plus the anchor-scan heuristic.

**Verify before trusting it.** Two failure modes look identical to a working
board until you check:

```bash
ENABLED_SOURCES=<id> npm run scrape -- --user <you>
```

- **A redirect.** `job-boards.greenhouse.io/databricks` answers 200 and then
  sends you to `databricks.com`, which no ATS profile can read. Stripe, Asana,
  Elastic, Datadog, Instacart, Samsara and MongoDB all do the same.
- **An empty shell.** Zepto, Juspay, Hasura, Darwinbox, Rippling and Slice all
  return a valid, well-formed board containing no postings. That is worse than no
  source at all: it scrapes cleanly, finds nothing, and looks like a selector bug.

Check the board's terms and `robots.txt` first - the scraper is polite (delays,
realistic headers) but makes no attempt to defeat bot challenges or logins.

## Scheduling

`server.js` registers the cron job in-process, so the board refreshes for as
long as the server is up. The default is every 30 minutes (`CRON_SCHEDULE`).

Why a frequent schedule is cheap: postings are de-duplicated per tenant on their
apply URL, so a repeat sighting only refreshes the stored row - **the LLM is
called for genuinely new listings only**. A measured cycle on the demo board went
19.4s on the first run (3 postings scored per user) and 1.0s on the next, with
zero LLM calls. Overlap is impossible: a trigger that fires while a scrape is
still running is skipped with a warning.

Two caveats:

- **Politeness.** Every 30 minutes is ~48 visits per board per day. That is fine
  for a handful of career pages, but keep `SCRAPER_DETAIL_LIMIT` low and do not
  add dozens of sources on this cadence.
- **Render free instances sleep.** An in-process cron cannot fire while the
  service is spun down. Use a paid instance, or move the schedule to a Render
  Cron Job running `npm run scrape` and set `CRON_SCHEDULE` to something inert.

An open dashboard polls `/api/jobs/stats` once a minute and redraws only when
the stored data actually changed, so scheduled results appear without a reload.

## Deploying to Render

1. **Create a PostgreSQL instance** and copy its *Internal Connection String*.
2. **New Web Service** → *Docker* runtime, pointed at this repo. The
   [Dockerfile](Dockerfile) installs Chromium via apt and sets
   `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` /
   `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
3. **Environment**: `DATABASE_URL`, `JWT_SECRET`, `NVIDIA_API_KEY`, and
   `DATABASE_SSL=true` if you use the external connection string.
4. **Health check path**: `/api/health`.

The schema is created on boot, so no migration step is needed. Puppeteer needs
memory - the free instance type can OOM mid-render; lower
`MAX_JOBS_PER_SOURCE` / `SCRAPER_DETAIL_LIMIT` or use a paid instance if you see
Chromium crashes.

## Tests

```bash
npm test        # offline unit tests (parsing, JSON repair, keyword ranking)
npm run verify  # live: Postgres round-trip, tenant isolation, NVIDIA contract
```

`npm run verify` creates two throwaway users, asserts that neither can read or
write the other's rows, and removes them again - including when a check fails.
Checks whose configuration is missing are reported as `SKIP`, not failure.

## Notes and limits

- **Scores are advisory.** The model sees the posting text, not the hiring bar.
- **The allow-list is the safety net.** Anything the scraper cannot attribute to
  a trusted employer is dropped rather than stored.
- The dashboard builds rows with `textContent`, never `innerHTML`, so a
  malicious posting cannot inject markup, and apply links are restricted to
  `http(s)`.
- `bcryptjs` is used rather than the native `bcrypt` binding - same algorithm and
  API, but no node-gyp toolchain in the Docker image or on Render.
