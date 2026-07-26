# Job Application Bot

A multi-tenant, cloud-ready job hunting assistant. Users sign up and upload as
many resumes as they like; the bot reads their skills, **discovers** the career
pages of companies hiring for those skills across thousands of employers, asks an
LLM on the NVIDIA API catalog to categorise each role (**Internship** vs
**Full-Time Job**) and pick the best resume for it, then serves everything on a
dark-mode dashboard with per-tab Excel export.

```
resumes ─▶ skills & titles ─▶ search queries
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
  ATS search APIs           developer job feeds       search-engine dorks
  (Greenhouse, Lever,       (RemoteOK, Arbeitnow,     (Puppeteer ─▶ DuckDuckGo,
   Ashby, Workday)           HN "Who is hiring?")      discovers new boards)
        └──────────────────────────┼──────────────────────────┘
                                   ▼
        trusted-ATS-domain filter ─▶ skill filter ─▶ already-seen filter
                                   │
                     NVIDIA LLM matcher ─▶ score >= 50 ─▶ PostgreSQL
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
- **Skill-driven discovery** - there is no company list. `extractUserSkills()`
  reads the stack and job titles out of the uploaded resumes, and those become
  the search queries: ATS dorks (`site:jobs.lever.co "Flutter" OR "Dart"`), the
  `searchText` sent to Workday, and the keyword filter every listing has to pass.
  Two candidates with different stacks reach two different sets of employers.
- **Three discovery channels** - public ATS APIs (Greenhouse, Lever, Ashby,
  Workday), open developer feeds (RemoteOK, Arbeitnow, the Hacker News "Who is
  hiring?" thread), and Puppeteer-driven search-engine crawling. Every career
  page found is remembered in the `ats_boards` table and revisited
  least-recently-first, so the reach of a run grows with every crawl.
- **Trusted ATS domains** - a discovered URL is only followed when it lives on a
  known applicant-tracking domain (`greenhouse.io`, `lever.co`, `ashbyhq.com`,
  `workday.com`, plus the feed domains). This replaced the old trusted-company
  allow-list: it is what keeps aggregator spam and reposted ghost listings out of
  the database now that the employer set is open-ended.
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

The first run has no discovered boards yet, so it leans on the job feeds and the
search crawl; from the second run onwards the `ats_boards` registry carries it.
Nothing needs to be configured for a company to be reachable.

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
| [services/scraper.js](services/scraper.js) | Board discovery, the three collection channels, trusted-domain filter, per-tenant persistence |
| [services/matcher.js](services/matcher.js) | NVIDIA LLM prompt, JSON validation, keyword fallback |
| [services/compensation.js](services/compensation.js) | Pay extraction (LPA/CTC/foreign/monthly) and the pay bar |
| [services/relevance.js](services/relevance.js) | Candidate profile, and the seniority / role-family / location gate |
| [services/parser.js](services/parser.js) | HTML extraction + in-memory PDF/DOCX resume parsing |
| [config/sources.js](config/sources.js) | Trusted ATS domains, ATS API patterns, query/dork templates, selector profiles |
| [public/](public/) | Dashboard (vanilla HTML/CSS/JS, dark theme) |
| [scripts/scrape.js](scripts/scrape.js) | `npm run scrape` - CLI run, all users or one |
| [scripts/rescreen.js](scripts/rescreen.js) | `npm run rescreen` - re-apply the gate to stored postings, no LLM calls |
| [scripts/prune.js](scripts/prune.js) | `npm run prune` - delete rows the current bars would not have stored (dry run by default) |
| [public/motion.js](public/motion.js) | Framer-Motion-style primitives (springs, stagger, FLIP, presence) on the Web Animations API |
| [tests/verify.js](tests/verify.js) | `npm run verify` - live Postgres + NVIDIA checks |
| [tests/](tests/) | `npm test` - offline node:test unit tests (units, compensation, relevance) |
| [Dockerfile](Dockerfile) | `node:20-slim` + system Chromium, for Render |
| [render.yaml](render.yaml) | Render Blueprint: database + web service + environment in one deploy |

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
| `TRUSTED_ATS_DOMAINS` | list in `config/sources.js` | Comma-separated domain allow-list override |
| `ENABLED_CHANNELS` | all three | `ats-api`, `job-feeds`, `search-crawl` |
| `MIN_MATCH_SCORE` | `50` | A posting scoring below this is never stored, and never listed |
| `SCRAPER_MAX_BOARDS` | `40` | Boards from the registry visited per run |
| `SCRAPER_MAX_NEW_JOBS` | `150` | Ceiling on postings handed to the matcher per run |
| `SCRAPER_MAX_DORKS` | `6` | Search-engine queries per run |
| `SCRAPER_SEARCH_DELAY_MS` | `6000` | Pause between search queries; below ~5s engines start throttling |
| `SCRAPER_FEED_SHARE` | `0.25` | Share of the run's budget reserved for the job feeds |
| `MAX_SEARCH_SKILLS` | `12` | Skills taken from the resumes to search with |
| `SCRAPER_DETAIL_LIMIT` | `3` | Job pages opened per board for the full description |
| `MAX_JOBS_PER_SOURCE` | `8` | Cap per board per run |
| `SCRAPER_MAX_PER_COMPANY` | `5` | Cap per employer across the whole run, counted by company name |
| `SEARCH_ENGINE` | all four | Restrict the search crawl, e.g. `brave,duckduckgo-html` |
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
| `GET` | `/api/status` | Scheduler state, discovery channels, trusted domains, board registry, this user's search queries, last run |
| `GET` | `/api/health` | Liveness probe (public) |

## How discovery works

There is nothing to add: companies arrive on their own.

**1. The resumes become a vocabulary.** `extractUserSkills()` in
[services/parser.js](services/parser.js) ranks the technologies a resume actually
leans on (by mention count, so a stack beats a tool named once in a course list)
and reads the job titles it claims. `buildSearchQueries()` in
[services/matcher.js](services/matcher.js) pairs them with role and level terms:

```
Node.js, Spring Boot, Flutter, PostgreSQL, AWS + Full Stack Developer, Backend Developer
  ─▶ "Node.js Full Stack Developer", "Flutter Developer Intern", "Spring Boot Associate", ...
```

**2. Three channels turn queries into postings.**

| Channel | What it does | Needs a browser |
| --- | --- | --- |
| `ats-api` | Reads every discovered board through Greenhouse / Lever / Ashby / Workday's public JSON API. Full descriptions come back in one request, so no detail page is opened | no |
| `job-feeds` | RemoteOK and Arbeitnow listings, plus the Hacker News "Who is hiring?" thread mined for the ATS links in its comments | no |
| `search-crawl` | Puppeteer runs dorks (`site:jobs.lever.co "Flutter" OR "Dart" India`) against DuckDuckGo and keeps every career page in the results | yes (falls back to plain HTTP) |

**3. Boards are remembered.** Every career page discovered is upserted into the
`ats_boards` table and revisited least-recently-scraped first, so each run reaches
companies the last one did not. The registry is shared across tenants - a board
found while scraping for one user is a board everyone's run can search. A board
whose API stops answering is marked `ok = false` and stops being retried.

**4. Four gates run before anything is paid for.**

- **Trusted domain** - the URL must be on an ATS or feed domain
  (`greenhouse.io`, `lever.co`, `ashbyhq.com`, `workday.com`, ...). Matching is on
  the registrable suffix, so every tenant of a platform is covered by one entry.
- **On the candidate's stack** - the title or description must hit one of their
  skills, matched as a whole token (a substring test accepts "Go" inside
  "go-to-market", which on an open crawl is no filter at all).
- **Somewhere they can work** - the same location check the relevance gate uses,
  applied at collection time so the run's budget is not spent on roles the gate
  will reject anyway. The country also goes into the dorks and into Workday's
  `searchText`.
- **Not already seen** - apply URLs already stored for every tenant on the run are
  dropped before any detail fetch or LLM call.
- **Not a fifth helping of the same employer** - a run keeps at most
  `SCRAPER_MAX_PER_COMPANY` postings per company, counted across every channel.
  A single large board can easily offer forty matching openings, and spending the
  run on them is how a crawl of the whole web comes back looking like a crawl of
  one company.

Only then does the LLM score the posting, and only a verdict of **50 or above**
is written to the database (`MIN_MATCH_SCORE`). The same floor applies when the
board is read, so rows stored under an older, lower bar do not resurface -
`npm run prune` deletes them for good.

Rate limits are real and every engine handles them differently: DuckDuckGo
answers a burst of dorks with HTTP 202 and an interstitial that looks like a
result page, while Brave refuses roughly every other query with a 429 and then
serves twenty boards. So the crawler rotates engines, counts *consecutive*
refusals rather than retiring an engine on the first one, and gives up on the
search channel only when all of them are refusing - the other two channels do not
need a search engine at all. Check a board's terms and `robots.txt` before
widening `TRUSTED_ATS_DOMAINS`: the crawler is polite (delays, realistic headers)
but makes no attempt to defeat bot challenges or logins.

## Scheduling

`server.js` registers the cron job in-process, so the board refreshes for as
long as the server is up. The default is every 30 minutes (`CRON_SCHEDULE`).

Why a frequent schedule is cheap: apply URLs already stored are dropped before
any detail fetch or LLM call, so **the LLM is called for genuinely new listings
only**, and the board registry is walked least-recently-scraped first, so
consecutive runs visit different companies rather than re-reading the same ones.
Overlap is impossible: a trigger that fires while a scrape is still running is
skipped with a warning.

Two caveats:

- **Politeness.** `SCRAPER_MAX_BOARDS` bounds how many career pages a run touches
  and `SCRAPER_MAX_DORKS` how many search queries it issues; both matter far more
  than the cron interval. Raising them on a 30-minute schedule is what turns a
  polite crawler into a nuisance.
- **Render free instances sleep.** An in-process cron cannot fire while the
  service is spun down. Use a paid instance, or move the schedule to a Render
  Cron Job running `npm run scrape` and set `CRON_SCHEDULE` to something inert.

An open dashboard polls `/api/jobs/stats` once a minute and redraws only when
the stored data actually changed, so scheduled results appear without a reload.

## Deploying to Render

[render.yaml](render.yaml) is a Blueprint: it declares the database, the web
service and the wiring between them, so the deploy is *New → Blueprint*, point
it at the repo, and paste one secret (`NVIDIA_API_KEY`) when prompted.
`DATABASE_URL` is injected from the database and `JWT_SECRET` is generated, so
neither is ever typed or committed.

Doing it by hand instead: create the PostgreSQL instance first, then a Web
Service on the **Docker** runtime with health check path `/api/health`, and set
`DATABASE_URL`, `JWT_SECRET` and `NVIDIA_API_KEY` yourself. The schema is created
on boot, so there is no migration step either way.

Three things about the free instance type are worth knowing before you pick it:

- **It sleeps after 15 minutes of inactivity, and the scheduler sleeps with it.**
  The cron job runs *inside* the web process ([server.js](server.js)), so a
  sleeping service scrapes nothing and wakes on the next HTTP request. Opening the
  dashboard and pressing *Run scrape* still works, which is the free-tier
  workflow. For an unattended schedule, use a paid instance, or move the scrape
  to a separate Render Cron Job running `npm run scrape`.
- **512 MB is not enough for Chromium.** The `search-crawl` channel is the only
  one that launches a browser, so `ENABLED_CHANNELS=ats-api,job-feeds` keeps the
  service inside its memory budget - at the cost of discovering fewer new boards.
  The Blueprint sets this. Turn `search-crawl` back on when you upgrade.
- **A manual scrape has to answer before Render's proxy times the request out.**
  Keep `SCRAPER_MAX_BOARDS` modest (the Blueprint uses 25). The run continues
  server-side even if the request gives up, but the dashboard will not show its
  summary.

TLS is negotiated from the connection string's host: Render's *internal* string
is a single-label name (`dpg-...-a`) whose Postgres does not offer TLS, while the
*external* string is a public `.render.com` name that requires it. Both are
handled automatically; `DATABASE_SSL=true|false` overrides the guess if you ever
need it.

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
