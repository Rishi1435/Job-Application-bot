/**
 * Scraping engine (Puppeteer).
 *
 * Visits only the career pages declared in `config/sources.js`, keeps only the
 * postings whose employer is on the `TRUSTED_COMPANIES` allow-list, then hands
 * each posting to the matcher once per tenant and stores the result.
 *
 * Shape of a run:
 *   1. collectJobs()      one browser, one pass over the sources -> postings
 *   2. per user           match against that user's resumes -> match_data
 *   3. per user           upsert into `jobs` (user_id + apply_url is unique)
 *
 * The crawl is shared across tenants (the boards are public and identical for
 * everyone), while scoring and storage are strictly per user.
 *
 * Chromium flags target containers: `--no-sandbox` and `--disable-setuid-sandbox`
 * because the image runs without user namespaces, `--disable-dev-shm-usage`
 * because Docker's default /dev/shm (64 MB) is too small for Chromium and makes
 * it crash mid-render.
 */

const fs = require('fs');
const path = require('path');

const { getEnabledSources, isTrustedCompany, canonicalCompany } = require('../config/sources');
const { clean, normalizeDate, absoluteUrl, parseHtml, extractText } = require('./parser');
const { upsertJob, jobExists, getResumes, listUsers } = require('./database');
const { matchJobsForUser } = require('./matcher');

const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 30000);
const SELECTOR_TIMEOUT_MS = Number(process.env.SCRAPER_SELECTOR_TIMEOUT_MS || 10000);
const MIN_DELAY_MS = Number(process.env.SCRAPER_MIN_DELAY_MS || 800);
const MAX_DELAY_MS = Number(process.env.SCRAPER_MAX_DELAY_MS || 2200);
/** How many job pages are opened per board to read the full description. */
const DETAIL_LIMIT = Number(process.env.SCRAPER_DETAIL_LIMIT || 5);
const DETAIL_MIN_CHARS = Number(process.env.SCRAPER_DETAIL_MIN_CHARS || 400);

/** Guards against overlapping runs (cron firing while a manual run is active). */
let running = false;
/** Summary of the most recent run, surfaced by `GET /api/status`. */
let lastRun = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Randomised pause between page loads so traffic does not look robotic. */
const politeDelay = () => sleep(MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS)));

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
 * @returns {Promise<string>}
 */
async function renderPage(page, url, waitForSelector) {
  await page.goto(url, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });

  if (waitForSelector) {
    // A miss is not fatal: boards restyle constantly and the generic fallback
    // below can still find postings in whatever did render.
    await page.waitForSelector(waitForSelector, { timeout: SELECTOR_TIMEOUT_MS }).catch(() => {});
  }

  return page.content();
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

/**
 * Last-resort extraction for boards whose selectors have changed: scans anchors
 * whose href looks like a job permalink and treats their text as the title.
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
 * directly.
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
 * Normalises raw extraction output and drops anything not on the allow-list.
 *
 * The board's own company (from `config/sources.js`) wins over whatever the
 * markup claims, because a single-company career page is authoritative; the
 * scraped value is only used when the source does not declare one.
 *
 * @param {Array<object>} rawJobs
 * @param {object} source
 * @returns {{jobs:Array<object>, rejected:number}}
 */
function normalizeAndFilter(rawJobs, source) {
  let rejected = 0;

  const jobs = rawJobs
    .map((job) => {
      const company = clean(job.company) || source.company || '';
      return {
        title: clean(job.title),
        company,
        location: clean(job.location),
        description: clean(job.description),
        applyUrl: normalizeApplyUrl(absoluteUrl(job.applyUrl, source.baseUrl)),
        datePosted: normalizeDate(job.datePosted),
        sourceId: source.id,
      };
    })
    .filter((job) => job.title && job.applyUrl)
    .filter((job) => {
      // The allow-list is the whole point of the "trusted companies" design:
      // anything we cannot attribute to a known employer is discarded.
      if (isTrustedCompany(job.company)) {
        job.company = canonicalCompany(job.company);
        return true;
      }
      rejected += 1;
      return false;
    });

  // De-duplicate within the source (boards repeat postings across departments).
  const seen = new Set();
  const unique = jobs.filter((job) => {
    if (seen.has(job.applyUrl)) return false;
    seen.add(job.applyUrl);
    return true;
  });

  return { jobs: Number.isFinite(source.maxJobs) ? unique.slice(0, source.maxJobs) : unique, rejected };
}

/**
 * Opens individual job pages to replace thin listing blurbs with the real
 * description, which is what the matcher actually reasons over. Capped by
 * `SCRAPER_DETAIL_LIMIT` so a run stays bounded.
 *
 * @param {import('puppeteer').Page} page
 * @param {Array<object>} jobs mutated in place
 * @param {object} source
 * @returns {Promise<void>}
 */
async function enrichDescriptions(page, jobs, source) {
  if (!source.detail || DETAIL_LIMIT <= 0) return;

  let opened = 0;
  for (const job of jobs) {
    if (opened >= DETAIL_LIMIT) break;
    if ((job.description || '').length >= DETAIL_MIN_CHARS) continue;

    try {
      const html = await renderPage(page, job.applyUrl, null);
      const text = extractText(html, source.detail);
      if (text.length > (job.description || '').length) job.description = text.slice(0, 20000);
      opened += 1;
      await politeDelay();
    } catch (error) {
      console.warn(`[scraper] Could not open ${job.applyUrl}: ${error.message}`);
    }
  }
}

/**
 * Scrapes one source into normalised, allow-listed postings.
 *
 * @param {import('puppeteer').Browser|null} browser null for `file` sources
 * @param {object} source source definition
 * @returns {Promise<Array<object>>}
 */
async function scrapeSource(browser, source) {
  let html;
  let page = null;

  if (source.ats === 'file') {
    html = fs.readFileSync(path.resolve(__dirname, '..', source.filePath), 'utf-8');
  } else {
    page = await newPage(browser);
    html = await renderPage(page, source.url, source.waitForSelector);
  }

  let rawJobs = parseHtml(html, source);
  if (rawJobs.length === 0) {
    rawJobs = genericAnchorScan(html, source);
    if (rawJobs.length) {
      console.warn(`[scraper] ${source.name}: selectors matched nothing, used the generic anchor scan.`);
    }
  }

  const { jobs, rejected } = normalizeAndFilter(rawJobs, source);
  if (rejected) {
    console.log(`[scraper] ${source.name}: ${rejected} posting(s) dropped - employer not on the trusted list.`);
  }

  try {
    if (page) await enrichDescriptions(page, jobs, source);
  } finally {
    if (page) await page.close().catch(() => {});
  }

  return jobs;
}

/**
 * One crawl over every enabled source.
 *
 * @param {{sources?:Array<object>}} [options]
 * @returns {Promise<{jobs:Array<object>, errors:Array<string>}>}
 */
async function collectJobs(options = {}) {
  const sources = options.sources || getEnabledSources();
  const errors = [];
  const jobs = [];
  const seen = new Set();

  const needsBrowser = sources.some((source) => source.ats !== 'file');
  let browser = null;

  if (needsBrowser) {
    try {
      browser = await launchBrowser();
    } catch (error) {
      errors.push(`Could not launch Chromium: ${error.message}`);
      console.error(`[scraper] ${errors[errors.length - 1]}`);
    }
  }

  try {
    for (const source of sources) {
      if (source.ats !== 'file' && !browser) continue; // browser failed to launch

      try {
        const found = await scrapeSource(browser, source);
        let added = 0;

        for (const job of found) {
          if (seen.has(job.applyUrl)) continue;
          seen.add(job.applyUrl);
          jobs.push(job);
          added += 1;
        }

        console.log(`[scraper] ${source.name}: ${found.length} trusted posting(s), ${added} new to this run.`);
      } catch (error) {
        const message = `${source.name}: ${error.message}`;
        errors.push(message);
        console.error(`[scraper] ${message}`);
      }

      await politeDelay();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { jobs, errors };
}

/* ------------------------------------------------------------------ */
/* Per-tenant persistence                                              */
/* ------------------------------------------------------------------ */

/**
 * Scores and stores an already-collected batch of postings for one user.
 *
 * Postings this user has already stored are refreshed but not re-sent to the
 * LLM, so a nightly run only pays for genuinely new listings.
 *
 * @param {number} userId tenant
 * @param {Array<object>} jobs postings from `collectJobs`
 * @returns {Promise<{inserted:number, updated:number, scored:number, errors:Array<string>}>}
 */
async function saveJobsForUser(userId, jobs) {
  const summary = { inserted: 0, updated: 0, scored: 0, errors: [] };
  if (!jobs.length) return summary;

  const resumes = await getResumes(userId);
  const fresh = [];

  for (const job of jobs) {
    if (await jobExists(userId, job.applyUrl)) {
      try {
        await upsertJob(userId, job); // refresh title/description only
        summary.updated += 1;
      } catch (error) {
        summary.errors.push(`Refresh failed for "${job.title}": ${error.message}`);
      }
    } else {
      fresh.push(job);
    }
  }

  if (!fresh.length) return summary;

  const verdicts = await matchJobsForUser(userId, fresh, { resumes });

  for (let i = 0; i < fresh.length; i += 1) {
    const job = fresh[i];
    const { engine, ...matchData } = verdicts[i] || {};

    try {
      const result = await upsertJob(userId, { ...job, matchData });
      if (result.inserted) summary.inserted += 1;
      else summary.updated += 1;
      if (engine === 'llm') summary.scored += 1;
    } catch (error) {
      const message = `Failed to save "${job.title}": ${error.message}`;
      summary.errors.push(message);
      console.error(`[scraper] ${message}`);
    }
  }

  return summary;
}

/**
 * Full pipeline: crawl once, then score and store for each requested tenant.
 *
 * @param {{trigger?:'cron'|'manual'|'startup', userIds?:Array<number>}} [options]
 *   `userIds` defaults to every registered user (that is what the cron run does).
 * @returns {Promise<{status:string, found:number, inserted:number, updated:number, scored:number, users:number, errors:Array<string>, startedAt:string, finishedAt:string, durationMs:number}>}
 */
async function runScraper(options = {}) {
  const trigger = options.trigger || 'manual';

  if (running) {
    console.warn('[scraper] A run is already in progress; skipping this trigger.');
    return { status: 'skipped', found: 0, inserted: 0, updated: 0, scored: 0, users: 0, errors: ['Run already in progress'] };
  }

  running = true;
  const startedAt = new Date();
  const errors = [];
  const totals = { found: 0, inserted: 0, updated: 0, scored: 0, users: 0 };

  try {
    const userIds = options.userIds || (await listUsers()).map((user) => user.id);
    if (!userIds.length) {
      console.warn('[scraper] No registered users - nothing to store.');
    }

    const sources = getEnabledSources();
    console.log(`[scraper] Starting ${trigger} run across ${sources.length} source(s) for ${userIds.length} user(s).`);

    const collected = await collectJobs({ sources });
    errors.push(...collected.errors);
    totals.found = collected.jobs.length;

    for (const userId of userIds) {
      try {
        const summary = await saveJobsForUser(userId, collected.jobs);
        totals.inserted += summary.inserted;
        totals.updated += summary.updated;
        totals.scored += summary.scored;
        totals.users += 1;
        errors.push(...summary.errors);
        console.log(`[scraper] user ${userId}: ${summary.inserted} new, ${summary.updated} refreshed, ${summary.scored} LLM-scored.`);
      } catch (error) {
        const message = `user ${userId}: ${error.message}`;
        errors.push(message);
        console.error(`[scraper] ${message}`);
      }
    }

    const status = errors.length === 0 ? 'success' : totals.inserted > 0 || totals.updated > 0 ? 'partial' : 'failed';
    const finishedAt = new Date();

    lastRun = {
      status,
      trigger,
      ...totals,
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
 * stores for the calling user only.
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
  scrapeSource,
  saveJobsForUser,
  normalizeAndFilter,
  normalizeApplyUrl,
  genericAnchorScan,
  launchBrowser,
  isRunning: () => running,
  getLastRun: () => lastRun,
};
