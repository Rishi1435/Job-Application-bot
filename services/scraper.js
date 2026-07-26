/**
 * Discovery & scraping engine.
 *
 * The engine no longer walks a list of companies. It starts from the skills in
 * the user's resumes and works outwards across three channels, so the set of
 * employers it reaches is a function of who the candidate is rather than of who
 * happened to be typed into a config file:
 *
 *   A. ATS SEARCH APIS - Greenhouse, Lever, Ashby and Workday all publish an
 *      open JSON endpoint per board. Every board the engine has ever discovered
 *      lives in the `ats_boards` table and is walked least-recently-visited
 *      first, so the reach of a run grows with every crawl.
 *   B. DEVELOPER JOB FEEDS - RemoteOK and Arbeitnow answer with structured
 *      listings; the Hacker News "Who is hiring?" thread is mined for the ATS
 *      links buried in its comments, which is where a large share of new boards
 *      come from.
 *   C. SEARCH-ENGINE CRAWLING - Puppeteer runs ATS dorks
 *      (`site:job-boards.greenhouse.io "Node.js" OR "Flutter"`) against
 *      DuckDuckGo. Each result is a career page belonging to a company nobody
 *      configured.
 *
 * Everything discovered is filtered through two gates before it costs anything:
 *
 *   TRUSTED DOMAIN - the URL must live on a known ATS or feed domain
 *                    (`config/sources.js`), which is what replaced the old
 *                    trusted-company allow-list now that the employer set is
 *                    open-ended.
 *   ALREADY SEEN   - the apply URL must not already be in the `jobs` table for
 *                    the tenants this run is storing for. The check happens
 *                    before detail fetching and before the LLM, so a posting is
 *                    never paid for twice.
 *
 * Shape of a run:
 *   1. resumes -> skills -> queries      (per tenant, unioned for one crawl)
 *   2. discover boards                   (channel C + the HN thread)
 *   3. collect postings                  (channels A and B, skill-filtered)
 *   4. per tenant: match, then store only what scores >= MIN_MATCH_SCORE
 *
 * Chromium flags target containers: `--no-sandbox` and `--disable-setuid-sandbox`
 * because the image runs without user namespaces, `--disable-dev-shm-usage`
 * because Docker's default /dev/shm (64 MB) is too small for Chromium and makes
 * it crash mid-render.
 */

const {
  ATS_PLATFORMS,
  workdayEndpoint,
  parseBoardUrl,
  isTrustedJobUrl,
  JOB_FEEDS,
  buildDorks,
  getSearchEngines,
  isChannelEnabled,
  getEnabledChannels,
  profileFor,
  titleCase,
} = require('../config/sources');
const { clean, decodeEntities, normalizeDate, absoluteUrl, parseHtml, extractText, extractUserSkills } = require('./parser');
const { buildCandidateProfile, assessLocation } = require('./relevance');
const db = require('./database');
const { matchJobsForUser, buildSearchQueries, meetsMatchBar, verifyMatchShape, MIN_MATCH_SCORE } = require('./matcher');

const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 30000);
const SELECTOR_TIMEOUT_MS = Number(process.env.SCRAPER_SELECTOR_TIMEOUT_MS || 10000);
const HTTP_TIMEOUT_MS = Number(process.env.SCRAPER_HTTP_TIMEOUT_MS || 20000);
const MIN_DELAY_MS = Number(process.env.SCRAPER_MIN_DELAY_MS || 800);
const MAX_DELAY_MS = Number(process.env.SCRAPER_MAX_DELAY_MS || 2200);

/** How many boards from the registry one run visits. */
const MAX_BOARDS = Number(process.env.SCRAPER_MAX_BOARDS || 40);
/** Postings kept per board after the skill filter. */
const MAX_JOBS_PER_BOARD = Number(process.env.MAX_JOBS_PER_SOURCE || 8);
/** Ceiling on postings handed to the matcher in one run. */
const MAX_NEW_JOBS = Number(process.env.SCRAPER_MAX_NEW_JOBS || 150);
/** Share of that ceiling reserved for the job feeds, so the ATS channel cannot eat the run. */
const FEED_SHARE = Number(process.env.SCRAPER_FEED_SHARE || 0.25);
/** Search-engine queries issued per run. Each one is a page load. */
const MAX_DORKS = Number(process.env.SCRAPER_MAX_DORKS || 6);
/**
 * Pause between search queries. Deliberately much longer than the delay between
 * board reads: an ATS API is a documented endpoint that expects traffic, while a
 * search engine starts serving throttle pages after a handful of rapid dorks.
 */
const SEARCH_DELAY_MS = Number(process.env.SCRAPER_SEARCH_DELAY_MS || 6000);
/** Consecutive refusals before a search engine is dropped for the rest of the run. */
const MAX_ENGINE_STRIKES = Number(process.env.SCRAPER_ENGINE_STRIKES || 3);
/** Job pages opened to fill in a description the listing did not carry. */
const DETAIL_LIMIT = Number(process.env.SCRAPER_DETAIL_LIMIT || 5);
const DETAIL_MIN_CHARS = Number(process.env.SCRAPER_DETAIL_MIN_CHARS || 400);
/** Boards whose API failed that are retried by rendering the board page. */
const HTML_FALLBACK_LIMIT = Number(process.env.SCRAPER_HTML_FALLBACK_LIMIT || 3);

/** Guards against overlapping runs (cron firing while a manual run is active). */
let running = false;
/** Summary of the most recent run, surfaced by `GET /api/status`. */
let lastRun = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Randomised pause between page loads so traffic does not look robotic. */
const politeDelay = () => sleep(MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS)));

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

/**
 * `fetch` with a timeout and a browser-shaped user agent.
 *
 * Every channel goes through this: an ATS API that hangs must not hang the run,
 * and several of these endpoints answer 403 to the default Node user agent.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?:number}} [options]
 * @returns {Promise<Response>}
 */
async function httpFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || HTTP_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GETs (or POSTs) JSON, returning null instead of throwing.
 *
 * A dead board is an ordinary event once boards are discovered rather than
 * curated - roughly one in six slugs found by a search engine has already been
 * retired - so a failure here is data, not an error worth aborting a run over.
 *
 * @param {string} url
 * @param {object} [options] passed through to `httpFetch`
 * @returns {Promise<any|null>}
 */
async function fetchJson(url, options = {}) {
  try {
    const response = await httpFetch(url, options);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Fetches a page as text, reporting the status so a refusal can be told apart
 * from an empty answer.
 *
 * @param {string} url
 * @returns {Promise<{html:string|null, status:number}>}
 */
async function fetchText(url) {
  try {
    const response = await httpFetch(url);
    // 202 is DuckDuckGo's throttle answer and is technically "ok", so the body
    // still has to be read for the caller to classify it.
    if (!response.ok && response.status !== 202) return { html: null, status: response.status };
    return { html: await response.text(), status: response.status };
  } catch {
    return { html: null, status: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* Browser                                                             */
/* ------------------------------------------------------------------ */

/**
 * Launches Chromium with container-safe flags.
 *
 * In the Docker image Chromium is installed by apt and
 * `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` points at it; locally the flag
 * is unset and Puppeteer uses its own download.
 *
 * @returns {Promise<import('puppeteer').Browser>}
 */
async function launchBrowser() {
  const puppeteer = require('puppeteer');

  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-blink-features=AutomationControlled',
    ],
  });
}

/**
 * Opens a tab configured to look like an ordinary browser.
 *
 * @param {import('puppeteer').Browser} browser
 * @returns {Promise<import('puppeteer').Page>}
 */
async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  // Hide the most obvious automation tell-tale.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return page;
}

/**
 * Loads a URL and returns its rendered HTML.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {string|null} [waitForSelector] extra wait once navigation settles
 * @param {'networkidle2'|'domcontentloaded'|'load'} [waitUntil] `domcontentloaded`
 *   for search engines: their result pages keep analytics sockets open, so
 *   waiting for the network to go idle just burns the navigation timeout.
 * @returns {Promise<string>}
 */
async function renderPage(page, url, waitForSelector, waitUntil = 'networkidle2') {
  await page.goto(url, { waitUntil, timeout: NAV_TIMEOUT_MS });

  if (waitForSelector) {
    // A miss is not fatal: boards restyle constantly and the fallbacks below can
    // still find postings in whatever did render.
    await page.waitForSelector(waitForSelector, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => {});
  }

  return page.content();
}

/* ------------------------------------------------------------------ */
/* URL handling                                                        */
/* ------------------------------------------------------------------ */

/**
 * Hosts that answer a posting URL with a 301 to somewhere else. Following the
 * redirect ourselves keeps the stored link stable: the browser still lands on
 * the right page either way, but a link that visibly bounces looks broken, and
 * some corporate proxies and in-app browsers drop the query string across the
 * hop - which is how `?gh_jid=...` gets lost and the board shows its index page
 * instead of the job.
 */
const HOST_REWRITES = {
  'boards.greenhouse.io': 'job-boards.greenhouse.io',
  'boards.eu.greenhouse.io': 'job-boards.eu.greenhouse.io',
};

/** Query parameters that only exist for analytics and can safely be dropped. */
const TRACKING_PARAMS = /^(utm_|gh_src$|ref$|source$|rx$|fbclid$|gclid$)/i;

/**
 * Canonicalises an apply URL so the link in the dashboard opens the posting
 * directly, and so two spellings of one posting deduplicate against each other.
 *
 * Returns null for anything that is not plain http(s) - the href is written
 * straight into an anchor, so a `javascript:` or `data:` URL that slipped out of
 * a career page must never reach the DOM.
 *
 * @param {string} url absolute URL from `absoluteUrl()`
 * @returns {string|null} canonical URL, or null when it is unusable
 */
function normalizeApplyUrl(url) {
  if (!url) return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const rewrite = HOST_REWRITES[parsed.hostname.toLowerCase()];
  if (rewrite) parsed.hostname = rewrite;

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }

  // Greenhouse repeats the posting id in the path and in `gh_jid`; the bare
  // path is the canonical permalink.
  if (/greenhouse\.io$/i.test(parsed.hostname) && /\/jobs\/\d+/.test(parsed.pathname)) {
    parsed.searchParams.delete('gh_jid');
  }

  parsed.hash = '';
  return parsed.toString();
}

/**
 * Strips markup out of the HTML descriptions Greenhouse, RemoteOK and Arbeitnow
 * ship (Greenhouse double-escapes its own, hence the entity decode first).
 *
 * @param {string} html
 * @returns {string}
 */
function htmlToText(html) {
  const raw = String(html || '');
  if (!raw.trim()) return '';
  if (!raw.includes('<') && !raw.includes('&lt;')) return clean(raw);
  return extractText(decodeEntities(raw));
}

/* ------------------------------------------------------------------ */
/* Channel A - ATS search APIs                                         */
/* ------------------------------------------------------------------ */

/**
 * One posting in the shape the rest of the pipeline expects.
 *
 * @param {object} fields
 * @returns {{title:string, company:string, location:string, description:string, applyUrl:string|null, datePosted:string|null, sourceId:string}}
 */
function toJob(fields) {
  return {
    title: clean(fields.title),
    company: clean(fields.company),
    location: clean(fields.location),
    description: String(fields.description || '').slice(0, 20000),
    applyUrl: normalizeApplyUrl(fields.applyUrl),
    datePosted: normalizeDate(fields.datePosted),
    sourceId: fields.sourceId,
  };
}

/**
 * Greenhouse's board API. `content=true` returns the full posting, so no detail
 * page ever has to be opened for these.
 *
 * @param {{slug:string, company?:string}} board
 * @returns {Promise<Array<object>|null>} null when the board is gone
 */
async function fetchGreenhouseBoard(board) {
  const payload = await fetchJson(ATS_PLATFORMS.greenhouse.apiUrl(board.slug));
  if (!payload || !Array.isArray(payload.jobs)) return null;

  return payload.jobs.map((job) =>
    toJob({
      title: job.title,
      company: job.company_name || board.company || titleCase(board.slug),
      location: job.location?.name || (job.offices || []).map((office) => office.name).join(', '),
      description: htmlToText(job.content),
      applyUrl: job.absolute_url,
      datePosted: job.first_published || job.updated_at,
      sourceId: `greenhouse:${board.slug}`,
    })
  );
}

/**
 * Lever's posting API.
 *
 * @param {{slug:string, company?:string}} board
 * @returns {Promise<Array<object>|null>}
 */
async function fetchLeverBoard(board) {
  const payload = await fetchJson(ATS_PLATFORMS.lever.apiUrl(board.slug));
  if (!Array.isArray(payload)) return null;

  return payload.map((posting) => {
    const categories = posting.categories || {};
    const locations = categories.allLocations?.length ? categories.allLocations.join(', ') : categories.location;

    return toJob({
      title: posting.text,
      company: board.company || titleCase(board.slug),
      location: locations,
      // `commitment` is where Lever records "Intern" / "Full-time", which is the
      // single most useful line for the categorisation the matcher has to do.
      description: [
        categories.commitment ? `Employment type: ${categories.commitment}` : '',
        posting.descriptionPlain,
        posting.additionalPlain,
      ]
        .filter(Boolean)
        .join('\n'),
      applyUrl: posting.hostedUrl || posting.applyUrl,
      datePosted: posting.createdAt,
      sourceId: `lever:${board.slug}`,
    });
  });
}

/**
 * Ashby's public job-board API.
 *
 * @param {{slug:string, company?:string}} board
 * @returns {Promise<Array<object>|null>}
 */
async function fetchAshbyBoard(board) {
  const payload = await fetchJson(ATS_PLATFORMS.ashby.apiUrl(board.slug));
  if (!payload || !Array.isArray(payload.jobs)) return null;

  return payload.jobs
    .filter((job) => job.isListed !== false)
    .map((job) =>
      toJob({
        title: job.title,
        company: board.company || titleCase(board.slug),
        location: [job.location, ...(job.secondaryLocations || []).map((extra) => extra.location || extra)]
          .filter(Boolean)
          .join(', '),
        description: [
          job.employmentType ? `Employment type: ${job.employmentType}` : '',
          job.descriptionPlain || htmlToText(job.descriptionHtml),
        ]
          .filter(Boolean)
          .join('\n'),
        applyUrl: job.jobUrl || job.applyUrl,
        datePosted: job.publishedAt,
        sourceId: `ashby:${board.slug}`,
      })
    );
}

/**
 * Workday's search endpoint.
 *
 * Workday is the one platform that will not hand over a whole board: the `cxs`
 * endpoint is a paged *search*, so the queries built from the resume are sent
 * to it directly as `searchText`. Listings come back without a description,
 * which `enrichWorkdayDescriptions` fills in from the same API.
 *
 * @param {{slug:string, company?:string}} board `<host>/<site>`
 * @param {Array<string>} queries
 * @returns {Promise<Array<object>|null>}
 */
async function fetchWorkdayBoard(board, queries) {
  const endpoint = workdayEndpoint(board.slug);
  if (!endpoint) return null;

  const searches = queries.length ? queries.slice(0, 3) : ['Software Engineer'];
  const jobs = [];
  let answered = false;

  for (const searchText of searches) {
    const payload = await fetchJson(endpoint.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText }),
    });

    if (!payload || !Array.isArray(payload.jobPostings)) continue;
    answered = true;

    for (const posting of payload.jobPostings) {
      jobs.push(
        toJob({
          title: posting.title,
          company: board.company || titleCase(endpoint.tenant),
          location: posting.locationsText,
          description: '',
          applyUrl: `https://${endpoint.host}/en-US/${endpoint.site}${posting.externalPath || ''}`,
          datePosted: posting.postedOn,
          sourceId: `workday:${board.slug}`,
        })
      );
    }

    await sleep(300);
  }

  return answered ? jobs : null;
}

/**
 * Fills in the descriptions Workday's search results omit, bounded by
 * `SCRAPER_DETAIL_LIMIT` so a run stays predictable.
 *
 * @param {Array<object>} jobs mutated in place
 * @returns {Promise<void>}
 */
async function enrichWorkdayDescriptions(jobs) {
  let opened = 0;

  for (const job of jobs) {
    if (opened >= DETAIL_LIMIT) break;
    if ((job.description || '').length >= DETAIL_MIN_CHARS) continue;

    const slug = String(job.sourceId || '').replace(/^workday:/, '');
    const endpoint = workdayEndpoint(slug);
    if (!endpoint) continue;

    const path = job.applyUrl.split(`/${endpoint.site}`)[1];
    if (!path) continue;

    const payload = await fetchJson(`https://${endpoint.host}/wday/cxs/${endpoint.tenant}/${endpoint.site}${path}`);
    const info = payload?.jobPostingInfo;
    if (info?.jobDescription) job.description = htmlToText(info.jobDescription).slice(0, 20000);
    opened += 1;
    await sleep(400);
  }
}

/**
 * Reads one board through its platform's API.
 *
 * @param {{platform:string, slug:string, company?:string}} board
 * @param {Array<string>} queries used by Workday, ignored by the others
 * @returns {Promise<{jobs:Array<object>, ok:boolean}>} `ok:false` retires the board
 */
async function fetchAtsBoard(board, queries) {
  const readers = {
    greenhouse: fetchGreenhouseBoard,
    lever: fetchLeverBoard,
    ashby: fetchAshbyBoard,
    workday: fetchWorkdayBoard,
  };

  const reader = readers[board.platform];
  if (!reader) return { jobs: [], ok: false };

  const jobs = await reader(board, queries);
  // null means "the endpoint did not answer with a board" - a retired slug.
  // An empty array means the company simply is not hiring, which is temporary.
  if (jobs === null) return { jobs: [], ok: false };

  return { jobs: jobs.filter((job) => job.title && job.applyUrl), ok: true };
}

/**
 * Last-resort read of a board that has no working API: render the page and
 * apply the platform's selector profile, then fall back to scanning anchors
 * that look like job permalinks.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {{platform:string, slug:string, company?:string, boardUrl?:string}} board
 * @returns {Promise<Array<object>>}
 */
async function fetchBoardViaHtml(browser, board) {
  const url = board.boardUrl || ATS_PLATFORMS[board.platform]?.boardUrl(board.slug);
  if (!url || !browser) return [];

  const profile = profileFor(url);
  const source = {
    id: `${board.platform}:${board.slug}`,
    company: board.company || titleCase(board.slug),
    baseUrl: new URL(url).origin,
    selectors: profile.selectors,
    jobUrlPattern: profile.jobUrlPattern,
  };

  const page = await newPage(browser);
  try {
    const html = await renderPage(page, url, profile.waitForSelector);
    let raw = parseHtml(html, source);
    if (!raw.length) raw = genericAnchorScan(html, source);

    return raw.map((job) =>
      toJob({
        title: job.title,
        company: job.company || source.company,
        location: job.location,
        description: job.description,
        applyUrl: absoluteUrl(job.applyUrl, source.baseUrl),
        datePosted: job.datePosted,
        sourceId: source.id,
      })
    );
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Scans anchors whose href looks like a job permalink and treats their text as
 * the title. Used when a board's selectors have changed under us.
 *
 * @param {string} html rendered markup
 * @param {object} source source definition
 * @returns {Array<{title:string, applyUrl:string, description:string}>}
 */
function genericAnchorScan(html, source) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const pattern = source.jobUrlPattern || /(job|career|position|opening)/i;
  const seen = new Set();
  const jobs = [];

  $('a[href]').each((_, element) => {
    const node = $(element);
    const href = node.attr('href') || '';
    const url = absoluteUrl(href, source.baseUrl);
    const title = clean(node.text());

    if (!url || !title || title.length < 4 || title.length > 160) return;
    if (!pattern.test(url)) return;
    if (seen.has(url)) return;

    seen.add(url);
    jobs.push({ title, applyUrl: url, description: clean(node.parent().text()).slice(0, 400) });
  });

  return jobs;
}

/* ------------------------------------------------------------------ */
/* Channel B - developer job feeds                                     */
/* ------------------------------------------------------------------ */

/**
 * RemoteOK's public feed. The first element is a legal notice, not a job.
 *
 * @param {object} feed
 * @returns {Promise<Array<object>>}
 */
async function fetchRemoteOkFeed(feed) {
  const payload = await fetchJson(feed.url);
  if (!Array.isArray(payload)) return [];

  return payload
    .filter((row) => row && !row.legal && row.position)
    .map((row) =>
      toJob({
        title: row.position,
        company: row.company,
        location: row.location || 'Remote',
        description: [htmlToText(row.description), (row.tags || []).join(', ')].filter(Boolean).join('\n'),
        applyUrl: row.url,
        datePosted: row.date || row.epoch,
        sourceId: `feed:${feed.id}`,
      })
    );
}

/**
 * Arbeitnow's open job-board API.
 *
 * @param {object} feed
 * @returns {Promise<Array<object>>}
 */
async function fetchArbeitnowFeed(feed) {
  const payload = await fetchJson(feed.url);
  if (!payload || !Array.isArray(payload.data)) return [];

  return payload.data.map((row) =>
    toJob({
      title: row.title,
      company: row.company_name,
      location: row.location || (row.remote ? 'Remote' : ''),
      description: [htmlToText(row.description), (row.job_types || []).join(', '), (row.tags || []).join(', ')]
        .filter(Boolean)
        .join('\n'),
      applyUrl: row.url,
      datePosted: row.created_at,
      sourceId: `feed:${feed.id}`,
    })
  );
}

/**
 * Mines the current Hacker News "Who is hiring?" thread for ATS links.
 *
 * The thread is prose, so it yields boards rather than postings - which is the
 * more valuable half anyway: one thread routinely names dozens of companies
 * that no search dork surfaces, and their APIs then hand over structured jobs.
 *
 * HN escapes URLs in its API payloads (`https:&#x2F;&#x2F;...`), so the text has
 * to be entity-decoded before anything can be matched in it.
 *
 * @param {object} feed
 * @returns {Promise<Array<{platform:string, slug:string, company:string, boardUrl:string, via:string}>>}
 */
async function fetchHackerNewsBoards(feed) {
  const search = await fetchJson(feed.url);
  const story = (search?.hits || []).find((hit) => /who is hiring\?/i.test(hit.title || ''));
  if (!story) return [];

  const thread = await fetchJson(`https://hn.algolia.com/api/v1/items/${story.objectID}`);
  if (!thread) return [];

  const text = decodeEntities(JSON.stringify(thread));
  const boards = new Map();

  for (const match of text.matchAll(/https?:\/\/[a-z0-9.-]+\/[^\s"'<>\\)]+/gi)) {
    const board = parseBoardUrl(match[0]);
    if (board) boards.set(`${board.platform}:${board.slug}`, { ...board, via: 'hackernews' });
  }

  return [...boards.values()];
}

/**
 * Runs the feed channel.
 *
 * @returns {Promise<{jobs:Array<object>, boards:Array<object>, errors:Array<string>}>}
 */
async function collectFromFeeds() {
  const readers = { remoteok: fetchRemoteOkFeed, arbeitnow: fetchArbeitnowFeed };
  const jobs = [];
  const boards = [];
  const errors = [];

  for (const feed of JOB_FEEDS) {
    try {
      if (feed.kind === 'hackernews') {
        const found = await fetchHackerNewsBoards(feed);
        boards.push(...found);
        console.log(`[scraper] ${feed.label}: ${found.length} ATS board(s) named in the thread.`);
        continue;
      }

      const reader = readers[feed.kind];
      if (!reader) continue;

      const found = await reader(feed);
      jobs.push(...found);
      console.log(`[scraper] ${feed.label}: ${found.length} listing(s).`);
    } catch (error) {
      const message = `${feed.label}: ${error.message}`;
      errors.push(message);
      console.warn(`[scraper] ${message}`);
    }
  }

  return { jobs, boards, errors };
}

/* ------------------------------------------------------------------ */
/* Channel C - search-engine crawling                                  */
/* ------------------------------------------------------------------ */

/**
 * Pulls every ATS board out of a results page.
 *
 * DuckDuckGo wraps outbound links in `/l/?uddg=<encoded>`, and its lite layout
 * prints the bare URL as text rather than as an href - so the raw markup is
 * scanned as well as the anchors. Both shapes go through `parseBoardUrl`, which
 * is what enforces "this is a real ATS board" on anything a search engine hands
 * back.
 *
 * @param {string} html results markup
 * @returns {Array<{platform:string, slug:string, company:string, boardUrl:string}>}
 */
function extractBoardsFromResults(html) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const candidates = new Set();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href') || '';
    // DuckDuckGo's redirector; the real target is in `uddg`.
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    candidates.add(redirect ? decodeURIComponent(redirect[1]) : href);
  });

  // Bing and the lite layouts print URLs as text.
  for (const match of html.matchAll(/https?:\/\/[a-z0-9.-]+\/[^\s"'<>\\)]+/gi)) candidates.add(match[0]);

  const boards = new Map();
  for (const candidate of candidates) {
    const url = candidate.startsWith('//') ? `https:${candidate}` : candidate;
    if (!isTrustedJobUrl(url)) continue;
    const board = parseBoardUrl(url);
    if (board) boards.set(`${board.platform}:${board.slug}`, board);
  }

  return [...boards.values()];
}

/**
 * Whether a results page is the search engine's throttle screen rather than
 * results.
 *
 * DuckDuckGo answers a burst of automated queries with HTTP **202** and a page
 * that looks structurally like a result page - it just has no results in it.
 * Without this check the run reads that as "nobody is hiring for Node.js" and
 * keeps hammering an endpoint that has already said no.
 *
 * @param {string} html
 * @returns {boolean}
 */
function looksThrottled(html) {
  if (!html || html.length > 40000) return false;
  return /anomaly|unusual traffic|captcha|challenge-form|are you a robot/i.test(html);
}

/**
 * Issues one dork and reads the boards out of the answer.
 *
 * Puppeteer is the primary path - a real browser is what gets past the
 * interstitials a bare client collects - with a plain fetch as the fallback so
 * discovery still works on a host where Chromium could not launch.
 *
 * @param {import('puppeteer').Page|null} page
 * @param {string} dork
 * @param {Map<string, number>} [strikes] consecutive refusals per engine, shared
 *   across the dorks of one run
 * @returns {Promise<{boards:Array<object>, throttled:boolean}>}
 */
async function runDork(page, dork, strikes = new Map()) {
  const engines = getSearchEngines();
  const isRetired = (engine) => (strikes.get(engine.id) || 0) >= MAX_ENGINE_STRIKES;

  for (const engine of engines) {
    if (isRetired(engine)) continue;

    const url = engine.url(dork);

    // Both transports are tried against every engine, and a *result-less* page
    // counts as a failure rather than as "this engine has nothing". Headless
    // Chromium is served an interstitial often enough that treating its empty
    // answer as final is what silently switched the discovery channel off.
    const attempts = [];
    if (page) {
      attempts.push(async () => {
        try {
          return { html: await renderPage(page, url, null, 'domcontentloaded'), status: 200 };
        } catch (error) {
          console.warn(`[scraper] ${engine.id} did not render "${dork}": ${error.message}`);
          return { html: null, status: 0 };
        }
      });
    }
    attempts.push(() => fetchText(url));

    let refused = false;

    for (const attempt of attempts) {
      const { html, status } = await attempt();

      if (status === 429 || status === 403 || status === 503) {
        refused = true;
        break;
      }
      if (!html) continue;

      const boards = extractBoardsFromResults(html);
      if (boards.length) {
        // A single answer clears the record: Brave in particular refuses about
        // every other query and then serves twenty boards, so retiring it on
        // the first 429 throws away the best source of new companies there is.
        strikes.delete(engine.id);
        console.log(`[scraper] ${engine.id} "${dork}": ${boards.length} board(s).`);
        return { boards: boards.map((board) => ({ ...board, via: `search:${engine.id}` })), throttled: false };
      }

      // Checked only once the page turned out to have no results, so a genuine
      // results page mentioning "captcha" can never be read as a refusal.
      if (looksThrottled(html)) {
        refused = true;
        break;
      }
    }

    // Strikes, not a single failure: an engine is only retired for the run once
    // it has refused several dorks in a row.
    if (refused) strikes.set(engine.id, (strikes.get(engine.id) || 0) + 1);
  }

  const throttled = engines.every(isRetired);
  console.log(`[scraper] no boards found for "${dork}"${throttled ? ' - every search engine is throttling us' : ''}.`);
  return { boards: [], throttled };
}

/**
 * Runs the search channel: skills -> dorks -> newly discovered career pages.
 *
 * @param {import('puppeteer').Browser|null} browser
 * @param {{skills:Array<string>, titles:Array<string>}} vocabulary
 * @returns {Promise<Array<object>>}
 */
async function discoverBoards(browser, vocabulary) {
  const dorks = buildDorks({
    skills: vocabulary.skills,
    roles: vocabulary.titles,
    locations: vocabulary.locations,
    limit: MAX_DORKS,
  });
  if (!dorks.length) return [];

  const page = browser ? await newPage(browser) : null;
  const boards = new Map();
  // Shared across dorks so a run stops asking an engine that keeps refusing.
  const strikes = new Map();

  try {
    for (const dork of dorks) {
      const { boards: found, throttled } = await runDork(page, dork, strikes);
      for (const board of found) boards.set(`${board.platform}:${board.slug}`, board);

      if (throttled) {
        console.warn('[scraper] search channel stopped early: every engine is throttling automated queries.');
        break;
      }

      await sleep(SEARCH_DELAY_MS);
    }
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return [...boards.values()];
}

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

/**
 * Builds the matcher used to decide whether a posting has anything to do with
 * the candidate's stack.
 *
 * The terms are matched as whole tokens against the title and the first part of
 * the description. A substring test would accept "Go" inside "Google" and "R"
 * inside every other word, which on an open crawl is the difference between a
 * skill filter and no filter at all.
 *
 * @param {Array<string>} terms skills and titles from `extractUserSkills`
 * @returns {(job:object) => Array<string>} the terms a posting hits
 */
function termMatcher(terms) {
  const patterns = terms.map((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Short terms are the ones that collide: "Go" is inside "go-to-market" and
    // "go-getter", "ML" inside "ML-driven marketing". They are only accepted
    // with whitespace or punctuation-free boundaries on both sides. Longer
    // terms keep the lenient boundary, because "React-based" and "Node.js-first"
    // are genuine hits that a hyphen rule would throw away.
    const boundary = term.length <= 3 ? '\\-' : '';
    return {
      term,
      pattern: new RegExp(`(?<![a-z0-9+#.${boundary}])${escaped}(?![a-z0-9+#${boundary}])`, 'i'),
    };
  });

  return (job) => {
    const haystack = `${job.title || ''}\n${String(job.description || '').slice(0, 4000)}`;
    return patterns.filter(({ pattern }) => pattern.test(haystack)).map(({ term }) => term);
  };
}

/**
 * Builds the "could this candidate take the job?" predicate for a run.
 *
 * A posting is kept when it is reachable from *any* of the countries the target
 * tenants are in - the crawl is shared, so a run covering an Indian and a
 * British candidate has to collect for both. When no country could be read from
 * any resume the predicate is open, which is what `assessLocation` does anyway.
 *
 * The check is a duplicate of the one the relevance gate performs later, and
 * that is the point: doing it here means the run's budget is spent on postings
 * that can survive the gate, instead of collecting 26 US-only roles and then
 * rejecting all 26.
 *
 * @param {Array<string|null>} countries
 * @returns {(job:object) => boolean}
 */
function locationFilter(countries) {
  const known = countries.filter(Boolean);
  if (!known.length) return () => true;

  return (job) => {
    const text = job.location || String(job.description || '').slice(0, 160);
    return known.some((country) => assessLocation(text, country).eligible);
  };
}

/**
 * Applies every gate a posting has to clear before it costs anything: a usable
 * title and link, a trusted domain, a hit on the candidate's vocabulary, a
 * location they can work from, and a URL neither this run nor the database has
 * seen.
 *
 * @param {Array<object>} jobs
 * @param {{matches:(job:object)=>Array<string>, knownUrls:Set<string>, seen:Set<string>, eligible?:(job:object)=>boolean, limit?:number}} context
 * @returns {{kept:Array<object>, skipped:{untrusted:number, offStack:number, duplicate:number, elsewhere:number}}}
 */
function filterJobs(jobs, context) {
  const skipped = { untrusted: 0, offStack: 0, duplicate: 0, elsewhere: 0 };
  const kept = [];

  for (const job of jobs) {
    if (!job.title || !job.applyUrl) continue;

    if (!isTrustedJobUrl(job.applyUrl)) {
      skipped.untrusted += 1;
      continue;
    }

    if (context.knownUrls.has(job.applyUrl) || context.seen.has(job.applyUrl)) {
      skipped.duplicate += 1;
      continue;
    }

    const hits = context.matches(job);
    if (!hits.length) {
      skipped.offStack += 1;
      continue;
    }

    if (context.eligible && !context.eligible(job)) {
      skipped.elsewhere += 1;
      continue;
    }

    context.seen.add(job.applyUrl);
    kept.push({ ...job, matchedSkills: hits });

    if (context.limit && kept.length >= context.limit) break;
  }

  return { kept, skipped };
}

/* ------------------------------------------------------------------ */
/* Collection                                                          */
/* ------------------------------------------------------------------ */

/**
 * One crawl: discover, then collect postings across the enabled channels.
 *
 * The crawl is shared across tenants (the boards are public and identical for
 * everyone) while scoring and storage are strictly per user, so the vocabulary
 * handed in here is the union of every tenant's skills.
 *
 * @param {{vocabulary:object, queries:Array<string>, knownUrls?:Set<string>, browser?:object}} options
 * @returns {Promise<{jobs:Array<object>, errors:Array<string>, stats:object}>}
 */
async function collectJobs(options = {}) {
  const vocabulary = options.vocabulary || { skills: [], titles: [], terms: [] };
  const queries = options.queries || [];
  const knownUrls = options.knownUrls || new Set();
  const terms = vocabulary.terms?.length ? vocabulary.terms : [...(vocabulary.skills || []), ...(vocabulary.titles || [])];

  const errors = [];
  const jobs = [];
  const seen = new Set();
  const matches = termMatcher(terms.length ? terms : ['Software Engineer', 'Developer']);
  const eligible = locationFilter(vocabulary.locations || []);
  const stats = {
    boardsDiscovered: 0,
    boardsNew: 0,
    boardsScraped: 0,
    boardsRetired: 0,
    fromAts: 0,
    fromFeeds: 0,
    untrusted: 0,
    offStack: 0,
    elsewhere: 0,
    duplicates: 0,
    companies: new Set(),
  };

  let browser = options.browser || null;
  let ownsBrowser = false;

  if (!browser && isChannelEnabled('search-crawl')) {
    try {
      browser = await launchBrowser();
      ownsBrowser = true;
    } catch (error) {
      // Discovery degrades to plain HTTP search rather than stopping: the ATS
      // and feed channels do not need a browser at all.
      errors.push(`Chromium unavailable, search crawling falls back to HTTP: ${error.message}`);
      console.warn(`[scraper] ${errors[errors.length - 1]}`);
    }
  }

  try {
    /* --- discovery ------------------------------------------------- */
    const discovered = [];

    if (isChannelEnabled('search-crawl')) {
      try {
        discovered.push(...(await discoverBoards(browser, vocabulary)));
      } catch (error) {
        errors.push(`Search crawl failed: ${error.message}`);
        console.error(`[scraper] ${errors[errors.length - 1]}`);
      }
    }

    /* --- channel B: feeds ------------------------------------------ */
    let feedJobs = [];
    if (isChannelEnabled('job-feeds')) {
      const feeds = await collectFromFeeds();
      errors.push(...feeds.errors);
      discovered.push(...feeds.boards);
      feedJobs = feeds.jobs;
    }

    stats.boardsDiscovered = discovered.length;
    if (discovered.length) {
      stats.boardsNew = await db.recordBoards(discovered);
      console.log(`[scraper] discovery: ${discovered.length} board(s) seen, ${stats.boardsNew} new to the registry.`);
    }

    /* --- feed postings ---------------------------------------------- */
    // Taken before the boards, up to their reserved share of the run. The ATS
    // channel returns thousands of postings and would otherwise consume the
    // whole budget, which is how a "multi-source" run quietly became a
    // single-source one.
    if (feedJobs.length) {
      const { kept, skipped } = filterJobs(feedJobs, {
        matches,
        eligible,
        knownUrls,
        seen,
        limit: Math.max(1, Math.round(MAX_NEW_JOBS * FEED_SHARE)),
      });
      stats.untrusted += skipped.untrusted;
      stats.offStack += skipped.offStack;
      stats.elsewhere += skipped.elsewhere;
      stats.duplicates += skipped.duplicate;
      stats.fromFeeds = kept.length;
      kept.forEach((job) => stats.companies.add(job.company));
      jobs.push(...kept);
      console.log(`[scraper] feeds: ${kept.length} skill-matched listing(s) kept.`);
    }

    /* --- channel A: ATS APIs --------------------------------------- */
    if (isChannelEnabled('ats-api')) {
      const boards = await db.getBoardsToScrape({ limit: MAX_BOARDS });
      const failed = [];

      for (const row of boards) {
        if (jobs.length >= MAX_NEW_JOBS) break;

        const board = { platform: row.platform, slug: row.slug, company: row.company, boardUrl: row.board_url };

        try {
          const { jobs: found, ok } = await fetchAtsBoard(board, queries);
          stats.boardsScraped += 1;

          const { kept, skipped } = filterJobs(found, {
            matches,
            eligible,
            knownUrls,
            seen,
            // The run's remaining budget, not just the per-board cap: the loop
            // only checks `MAX_NEW_JOBS` between boards, so without this the
            // last board can push the batch a whole board over the ceiling.
            limit: Math.max(1, Math.min(MAX_JOBS_PER_BOARD, MAX_NEW_JOBS - jobs.length)),
          });
          stats.untrusted += skipped.untrusted;
          stats.offStack += skipped.offStack;
          stats.elsewhere += skipped.elsewhere;
          stats.duplicates += skipped.duplicate;

          if (!ok) {
            stats.boardsRetired += 1;
            failed.push(board);
          }

          if (kept.length) {
            jobs.push(...kept);
            stats.fromAts += kept.length;
            kept.forEach((job) => stats.companies.add(job.company));
            console.log(
              `[scraper] ${board.platform}/${board.slug}: ${found.length} posting(s), ` +
                `${kept.length} match your skills (${[...new Set(kept.flatMap((job) => job.matchedSkills))].slice(0, 5).join(', ')}).`
            );
          } else if (found.length) {
            console.log(`[scraper] ${board.platform}/${board.slug}: ${found.length} posting(s), none on your stack.`);
          }

          await db.markBoardScraped(board.platform, board.slug, { jobCount: found.length, ok });
        } catch (error) {
          errors.push(`${board.platform}/${board.slug}: ${error.message}`);
          console.warn(`[scraper] ${errors[errors.length - 1]}`);
        }
      }

      /* --- HTML fallback for boards whose API is gone --------------- */
      if (browser && failed.length && HTML_FALLBACK_LIMIT > 0) {
        for (const board of failed.slice(0, HTML_FALLBACK_LIMIT)) {
          if (jobs.length >= MAX_NEW_JOBS) break;
          try {
            const found = await fetchBoardViaHtml(browser, board);
            const { kept } = filterJobs(found, { matches, eligible, knownUrls, seen, limit: MAX_JOBS_PER_BOARD });
            if (kept.length) {
              jobs.push(...kept);
              stats.fromAts += kept.length;
              stats.boardsRetired -= 1;
              kept.forEach((job) => stats.companies.add(job.company));
              // The API is gone but the page is not, so the board stays healthy.
              await db.markBoardScraped(board.platform, board.slug, { jobCount: found.length, ok: true });
              console.log(`[scraper] ${board.platform}/${board.slug}: ${kept.length} posting(s) read from the page.`);
            }
          } catch (error) {
            console.warn(`[scraper] HTML fallback for ${board.platform}/${board.slug}: ${error.message}`);
          }
          await politeDelay();
        }
      }
    }

    /* --- descriptions Workday withheld ------------------------------ */
    const workdayJobs = jobs.filter((job) => String(job.sourceId || '').startsWith('workday:'));
    if (workdayJobs.length) await enrichWorkdayDescriptions(workdayJobs);
  } finally {
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }

  stats.companies = [...stats.companies];
  return { jobs, errors, stats };
}

/* ------------------------------------------------------------------ */
/* Per-tenant persistence                                              */
/* ------------------------------------------------------------------ */

/**
 * Scores an already-collected batch for one user and stores what clears the bar.
 *
 * Two filters apply here and nowhere else:
 *   - a posting this user already stores is skipped outright (it was matched on
 *     the run that first found it, and nothing about it has changed);
 *   - a verdict below `MIN_MATCH_SCORE` is not written at all. On an open crawl
 *     most of what is discovered is a near-miss, and storing it buries the rows
 *     that are worth an evening.
 *
 * @param {number} userId tenant
 * @param {Array<object>} jobs postings from `collectJobs`
 * @returns {Promise<{inserted:number, updated:number, scored:number, belowBar:number, malformed:number, errors:Array<string>}>}
 */
async function saveJobsForUser(userId, jobs) {
  const summary = { inserted: 0, updated: 0, scored: 0, belowBar: 0, malformed: 0, errors: [] };
  if (!jobs.length) return summary;

  const resumes = await db.getResumes(userId);
  const known = await db.getKnownApplyUrls([userId]);
  const fresh = jobs.filter((job) => !known.has(job.applyUrl));

  // `updated` is "this tenant already had it, so it was left alone". The stored
  // row was written by the run that first found the posting and nothing about
  // the listing has changed, so re-writing it would only cost a round trip.
  summary.updated = jobs.length - fresh.length;
  if (!fresh.length) return summary;

  const verdicts = await matchJobsForUser(userId, fresh, { resumes });

  for (let i = 0; i < fresh.length; i += 1) {
    const { matchedSkills, ...job } = fresh[i];
    const { engine, ...matchData } = verdicts[i] || {};

    // Counted before the bar: a verdict the model produced was paid for whether
    // or not the posting was good enough to keep, and reporting it only for
    // stored rows made a run that scored eight postings look like it made no
    // calls at all.
    if (engine === 'llm') summary.scored += 1;

    const shape = verifyMatchShape(matchData);
    if (!shape.ok) {
      // A verdict missing a field the dashboard reads is a bug worth seeing
      // rather than a row worth storing.
      summary.malformed += 1;
      summary.errors.push(`Incomplete verdict for "${job.title}" (missing: ${shape.missing.join(', ')})`);
      continue;
    }

    if (!meetsMatchBar(matchData)) {
      summary.belowBar += 1;
      continue;
    }

    try {
      const result = await db.upsertJob(userId, { ...job, matchData });
      if (result.inserted) summary.inserted += 1;
      else summary.updated += 1;
    } catch (error) {
      const message = `Failed to save "${job.title}": ${error.message}`;
      summary.errors.push(message);
      console.error(`[scraper] ${message}`);
    }
  }

  return summary;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * The union of every target tenant's search vocabulary.
 *
 * One crawl serves all of them, so the queries have to cover all of them; the
 * per-user part of the pipeline is the scoring, which still only ever sees that
 * user's own resumes.
 *
 * @param {Array<number>} userIds
 * @returns {Promise<{vocabulary:{skills:Array<string>, titles:Array<string>, terms:Array<string>}, queries:Array<string>, perUser:Record<number, object>}>}
 */
async function buildRunVocabulary(userIds) {
  const skills = new Set();
  const titles = new Set();
  const locations = new Set();
  const queries = new Set();
  const perUser = {};

  for (const userId of userIds) {
    const resumes = await db.getResumes(userId);
    const vocabulary = extractUserSkills(resumes);
    // The country comes from the same profile the relevance gate screens with,
    // so the crawl searches exactly where the gate will accept.
    const { location } = buildCandidateProfile(resumes);
    if (location) locations.add(location);

    perUser[userId] = { ...vocabulary, location };

    vocabulary.skills.forEach((skill) => skills.add(skill));
    vocabulary.titles.forEach((title) => titles.add(title));
    buildSearchQueries(vocabulary, { locations: location ? [location] : [] }).forEach((query) => queries.add(query));
  }

  const merged = { skills: [...skills], titles: [...titles], locations: [...locations] };
  return {
    vocabulary: { ...merged, terms: [...new Set([...merged.skills, ...merged.titles])] },
    queries: [...queries],
    perUser,
  };
}

/**
 * Full pipeline: read the resumes, crawl once, then score and store per tenant.
 *
 * @param {{trigger?:'cron'|'manual'|'startup', userIds?:Array<number>}} [options]
 *   `userIds` defaults to every registered user (that is what the cron run does).
 * @returns {Promise<object>} run summary
 */
async function runScraper(options = {}) {
  const trigger = options.trigger || 'manual';

  if (running) {
    console.warn('[scraper] A run is already in progress; skipping this trigger.');
    return {
      status: 'skipped',
      found: 0,
      inserted: 0,
      updated: 0,
      scored: 0,
      belowBar: 0,
      users: 0,
      errors: ['Run already in progress'],
    };
  }

  running = true;
  const startedAt = new Date();
  const errors = [];
  const totals = { found: 0, inserted: 0, updated: 0, scored: 0, belowBar: 0, users: 0 };

  try {
    const userIds = options.userIds || (await db.listUsers()).map((user) => user.id);
    if (!userIds.length) {
      console.warn('[scraper] No registered users - nothing to store.');
    }

    const { vocabulary, queries } = await buildRunVocabulary(userIds);
    const channels = getEnabledChannels().map((channel) => channel.id);

    console.log(
      `[scraper] Starting ${trigger} run for ${userIds.length} user(s) across ${channels.join(', ')}.\n` +
        `[scraper] Skills: ${vocabulary.skills.join(', ') || '(none - upload a resume)'}\n` +
        `[scraper] Titles: ${vocabulary.titles.join(', ') || '(none)'}\n` +
        `[scraper] Hiring in: ${vocabulary.locations.join(', ') || 'anywhere (no country on the resumes)'}\n` +
        `[scraper] ${queries.length} search quer(ies), e.g. ${queries.slice(0, 3).join(' | ')}`
    );

    if (!vocabulary.terms.length) {
      console.warn('[scraper] No skills could be read from any resume - the crawl would have nothing to search for.');
    }

    // Postings every target tenant already stores are dropped before the crawl
    // spends anything on them.
    const knownUrls = await db.getSharedApplyUrls(userIds);

    const collected = await collectJobs({ vocabulary, queries, knownUrls });
    errors.push(...collected.errors);
    totals.found = collected.jobs.length;
    totals.discovery = collected.stats;

    console.log(
      `[scraper] ${collected.jobs.length} new posting(s) from ${collected.stats.companies.length} compan(ies) - ` +
        `${collected.stats.fromAts} via ATS APIs, ${collected.stats.fromFeeds} via feeds; ` +
        `skipped ${collected.stats.duplicates} already seen, ${collected.stats.offStack} off-stack, ` +
        `${collected.stats.elsewhere} in another country, ${collected.stats.untrusted} untrusted.`
    );

    for (const userId of userIds) {
      try {
        const summary = await saveJobsForUser(userId, collected.jobs);
        totals.inserted += summary.inserted;
        totals.updated += summary.updated;
        totals.scored += summary.scored;
        totals.belowBar += summary.belowBar;
        totals.users += 1;
        errors.push(...summary.errors);
        console.log(
          `[scraper] user ${userId}: ${summary.inserted} stored, ${summary.belowBar} below the ` +
            `${MIN_MATCH_SCORE}% bar, ${summary.scored} LLM-scored.`
        );
      } catch (error) {
        const message = `user ${userId}: ${error.message}`;
        errors.push(message);
        console.error(`[scraper] ${message}`);
      }
    }

    const status = errors.length === 0 ? 'success' : totals.inserted > 0 || totals.found > 0 ? 'partial' : 'failed';
    const finishedAt = new Date();

    lastRun = {
      status,
      trigger,
      ...totals,
      skills: vocabulary.skills,
      errors,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
    };

    console.log(
      `[scraper] Run finished in ${(lastRun.durationMs / 1000).toFixed(1)}s - ` +
        `${totals.found} posting(s) found, ${totals.inserted} stored, ${errors.length} error(s).`
    );

    return lastRun;
  } catch (error) {
    console.error('[scraper] Run aborted:', error.message);
    errors.push(error.message);
    const finishedAt = new Date();
    lastRun = {
      status: 'failed',
      trigger,
      ...totals,
      errors,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
    };
    return lastRun;
  } finally {
    running = false;
  }
}

/**
 * Convenience wrapper for the dashboard's "Run scrape now" button: crawls and
 * stores for the calling user only, which also means the crawl searches for
 * that user's skills alone.
 *
 * @param {number} userId
 * @returns {Promise<object>} run summary
 */
function runScraperForUser(userId) {
  return runScraper({ trigger: 'manual', userIds: [userId] });
}

module.exports = {
  runScraper,
  runScraperForUser,
  collectJobs,
  saveJobsForUser,
  buildRunVocabulary,
  // channels
  fetchAtsBoard,
  fetchGreenhouseBoard,
  fetchLeverBoard,
  fetchAshbyBoard,
  fetchWorkdayBoard,
  collectFromFeeds,
  discoverBoards,
  extractBoardsFromResults,
  looksThrottled,
  fetchBoardViaHtml,
  genericAnchorScan,
  // helpers
  termMatcher,
  filterJobs,
  normalizeApplyUrl,
  htmlToText,
  launchBrowser,
  isRunning: () => running,
  getLastRun: () => lastRun,
};
