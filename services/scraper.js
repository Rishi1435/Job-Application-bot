/**
 * Crawler module.
 *
 * Walks every enabled source in `config/sources.js`, extracts postings, scores
 * the *new* ones with the resume matcher, and persists them to SQLite.
 *
 * Fetch strategies:
 *   file    - local HTML (offline demo board)
 *   static  - axios + Cheerio for server-rendered boards
 *   dynamic - Puppeteer render + Cheerio for JavaScript-rendered boards
 *   json    - public JSON endpoints mapped by the source definition
 *
 * Politeness / basic block avoidance:
 *   - realistic browser headers (User-Agent, Accept, Accept-Language)
 *   - randomised delay between requests
 *   - exponential backoff on 429 / 5xx / socket errors
 *   - per-source failures are isolated: one dead board never aborts the run
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const { getEnabledSources } = require('../config/sources');
const { clean, normalizeDate, absoluteUrl, parseHtml } = require('./parser');
const { insertJob, jobExists, startRun, finishRun } = require('./database');
const { matchJobs } = require('./matcher');

const USER_AGENT =
  process.env.SCRAPER_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = Number(process.env.SCRAPER_TIMEOUT_MS || 20000);
const MAX_RETRIES = Number(process.env.SCRAPER_MAX_RETRIES || 3);
const MIN_DELAY_MS = Number(process.env.SCRAPER_MIN_DELAY_MS || 800);
const MAX_DELAY_MS = Number(process.env.SCRAPER_MAX_DELAY_MS || 2200);

/** Guards against overlapping runs (cron firing while a manual run is active). */
let running = false;

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Randomised pause between requests so traffic does not look robotic. */
const politeDelay = () => sleep(MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS)));

/**
 * @param {any} error
 * @returns {boolean} whether the request is worth retrying
 */
function isRetryable(error) {
  const status = error?.response?.status;
  if (status === 429 || status === 408) return true;
  if (status >= 500 && status < 600) return true;
  return ['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code);
}

/* ------------------------------------------------------------------ */
/* Fetchers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Decodes a raw response body to a string using the charset advertised in
 * `Content-Type`, defaulting to UTF-8 (which is what nearly every board serves,
 * even when it forgets to say so).
 *
 * @param {{data: Buffer|ArrayBuffer, headers: object}} response axios response
 * @returns {string}
 */
function decodeBody(response) {
  const contentType = String(response.headers?.['content-type'] || '');
  const charset = (contentType.match(/charset=([^;]+)/i)?.[1] || 'utf-8').trim().toLowerCase();
  const buffer = Buffer.from(response.data);

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    // Unknown/bogus charset label - UTF-8 is the safest guess.
    return buffer.toString('utf-8');
  }
}

/**
 * HTTP GET with browser-like headers and exponential backoff.
 *
 * @param {string} url
 * @param {{json?:boolean}} [options]
 * @returns {Promise<any>} response body (parsed object when `json` is set)
 */
async function httpGet(url, options = {}) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await axios.get(url, {
        timeout: REQUEST_TIMEOUT_MS,
        maxRedirects: 5,
        // Some boards return 403 for "unknown" clients; look like a real browser.
        headers: {
          'User-Agent': USER_AGENT,
          Accept: options.json
            ? 'application/json,text/plain,*/*'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Upgrade-Insecure-Requests': '1',
        },
        // Raw bytes, decoded below. Letting axios decode strings mangles UTF-8
        // on responses whose Content-Type omits a charset (RemoteOK does).
        responseType: 'arraybuffer',
        validateStatus: (status) => status >= 200 && status < 400,
      });

      const body = decodeBody(response);
      return options.json ? JSON.parse(body) : body;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) break;
      const backoff = 1500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      console.warn(`[scraper] GET ${url} failed (${error.message}); retry ${attempt}/${MAX_RETRIES - 1} in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  const status = lastError?.response?.status;
  throw new Error(`GET ${url} failed${status ? ` with HTTP ${status}` : ''}: ${lastError?.message}`);
}

/**
 * Renders a JavaScript-driven page with Puppeteer and returns its HTML.
 * Puppeteer is required lazily so the app still boots when it is not installed.
 *
 * @param {object} source source definition
 * @returns {Promise<string>} rendered HTML
 */
async function renderWithPuppeteer(source) {
  let puppeteer;
  try {
    // eslint-disable-next-line global-require
    puppeteer = require('puppeteer');
  } catch {
    throw new Error("Puppeteer is not installed - run 'npm install puppeteer' to enable dynamic sources.");
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 900 });

    // Hide the most obvious automation tell-tale.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    await page.goto(source.url, { waitUntil: 'networkidle2', timeout: REQUEST_TIMEOUT_MS });

    if (source.waitForSelector) {
      await page.waitForSelector(source.waitForSelector, { timeout: REQUEST_TIMEOUT_MS });
    }

    return await page.content();
  } finally {
    await browser.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Source handling                                                     */
/* ------------------------------------------------------------------ */

/**
 * Fetches and parses one source into normalised job records.
 *
 * @param {object} source source definition
 * @returns {Promise<Array<object>>} normalised jobs tagged with their source
 */
async function scrapeSource(source) {
  let rawJobs = [];

  switch (source.mode) {
    case 'file': {
      const filePath = path.resolve(__dirname, '..', source.filePath);
      const html = fs.readFileSync(filePath, 'utf-8');
      rawJobs = parseHtml(html, source);
      break;
    }
    case 'static': {
      const html = await httpGet(source.url);
      rawJobs = parseHtml(html, source);
      break;
    }
    case 'dynamic': {
      const html = await renderWithPuppeteer(source);
      rawJobs = parseHtml(html, source);
      break;
    }
    case 'json': {
      const payload = await httpGet(source.url, { json: true });
      rawJobs = typeof source.map === 'function' ? source.map(payload) : [];
      break;
    }
    default:
      throw new Error(`Unknown source mode "${source.mode}" for source "${source.id}"`);
  }

  const normalised = rawJobs
    .map((job) => ({
      title: clean(job.title),
      company: clean(job.company) || 'Unknown',
      description: clean(job.description),
      applyUrl: absoluteUrl(job.applyUrl, source.baseUrl),
      datePosted: normalizeDate(job.datePosted),
      sourceId: source.id,
      sourceName: source.name,
    }))
    .filter((job) => job.title && job.applyUrl);

  return Number.isFinite(source.maxJobs) ? normalised.slice(0, source.maxJobs) : normalised;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Runs the full pipeline: scrape -> de-duplicate -> score -> persist.
 *
 * Jobs whose apply URL is already stored are *not* sent to the LLM again; they
 * only get their `lastSeenAt` / `timesSeen` counters refreshed.
 *
 * @param {{trigger?:'cron'|'manual'|'startup'}} [options]
 * @returns {Promise<{status:string, found:number, inserted:number, duplicates:number, scored:number, errors:Array<string>}>}
 */
async function runScraper(options = {}) {
  const trigger = options.trigger || 'manual';

  if (running) {
    console.warn('[scraper] A run is already in progress; skipping this trigger.');
    return { status: 'skipped', found: 0, inserted: 0, duplicates: 0, scored: 0, errors: ['Run already in progress'] };
  }

  running = true;
  const startedAt = Date.now();
  const runId = await startRun(trigger);
  const errors = [];
  const summary = { found: 0, inserted: 0, duplicates: 0, scored: 0 };

  try {
    const sources = getEnabledSources();
    console.log(`[scraper] Starting ${trigger} run across ${sources.length} source(s).`);

    /** @type {Array<object>} every posting seen this run, de-duplicated by URL */
    const collected = [];
    const seenUrls = new Set();

    for (const source of sources) {
      try {
        const jobs = await scrapeSource(source);
        let added = 0;

        for (const job of jobs) {
          if (seenUrls.has(job.applyUrl)) continue;
          seenUrls.add(job.applyUrl);
          collected.push(job);
          added += 1;
        }

        console.log(`[scraper] ${source.name}: ${jobs.length} posting(s), ${added} unique.`);
      } catch (error) {
        const message = `${source.name}: ${error.message}`;
        errors.push(message);
        console.error(`[scraper] ${message}`);
      }

      await politeDelay();
    }

    summary.found = collected.length;

    // Split into brand-new postings (need scoring) and ones already stored.
    const fresh = [];
    for (const job of collected) {
      if (await jobExists(job.applyUrl)) {
        await insertJob(job); // refreshes lastSeenAt / timesSeen
        summary.duplicates += 1;
      } else {
        fresh.push(job);
      }
    }

    if (fresh.length > 0) {
      console.log(`[scraper] Scoring ${fresh.length} new posting(s) against the resume...`);
      const verdicts = await matchJobs(fresh);

      for (let i = 0; i < fresh.length; i += 1) {
        const job = fresh[i];
        const verdict = verdicts[i] || { score: 0, reason: 'No verdict produced.' };
        job.score = verdict.score;
        job.reason = verdict.reason;

        try {
          const result = await insertJob(job);
          if (result.status === 'inserted') {
            summary.inserted += 1;
            summary.scored += 1;
            console.log(`[scraper] Saved "${job.title}" @ ${job.company} - score ${job.score}`);
          } else {
            summary.duplicates += 1;
          }
        } catch (error) {
          const message = `Failed to save "${job.title}": ${error.message}`;
          errors.push(message);
          console.error(`[scraper] ${message}`);
        }
      }
    }

    const status = errors.length === 0 ? 'success' : summary.inserted > 0 ? 'partial' : 'failed';
    await finishRun(runId, { status, ...summary, errors });

    console.log(
      `[scraper] Run finished in ${((Date.now() - startedAt) / 1000).toFixed(1)}s - ` +
        `${summary.found} found, ${summary.inserted} new, ${summary.duplicates} already seen, ${errors.length} error(s).`
    );

    return { status, ...summary, errors };
  } catch (error) {
    console.error('[scraper] Run aborted:', error.message);
    errors.push(error.message);
    await finishRun(runId, { status: 'failed', ...summary, errors });
    return { status: 'failed', ...summary, errors };
  } finally {
    running = false;
  }
}

module.exports = {
  runScraper,
  scrapeSource,
  httpGet,
  isRunning: () => running,
  // Re-exported for convenience; the implementations live in ./parser.
  parseHtml,
  normalizeDate,
  absoluteUrl,
};
