/**
 * Scrape targets.
 *
 * The engine is config-driven and *closed by default*: it only ever visits the
 * URLs listed in `SOURCE_URLS`, and only keeps postings whose employer appears
 * in `TRUSTED_COMPANIES`. Adding a board means adding a line here, not writing
 * new scraping code.
 *
 * Every URL is classified into an ATS "profile" (Greenhouse / Lever / Ashby /
 * local file) which supplies the CSS selectors. Boards restyle their markup
 * regularly, so `services/scraper.js` falls back to a generic anchor scan when
 * a profile's selectors match nothing.
 *
 * Runtime overrides:
 *   ENABLED_SOURCES=greenhouse-anthropic,mock-board   (comma separated ids)
 *   TRUSTED_COMPANIES=Anthropic,Figma                 (replaces the list below)
 */

/* ------------------------------------------------------------------ */
/* Trusted employers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Allow-list of employers. A scraped posting is discarded unless its company
 * matches one of these (case/punctuation insensitive), which keeps aggregator
 * spam and reposted ghost jobs out of the database.
 *
 * @type {Array<string>}
 */
/**
 * Extra employers to accept beyond the ones that own a configured board.
 *
 * Normally this stays empty: `getTrustedCompanies()` already trusts every
 * company in `SOURCE_URLS`, because a single-employer career page is
 * authoritative about who is hiring. Add a name here only for a board that
 * lists postings from someone else (a parent company, or an acquired brand
 * still posting under its own name).
 *
 * @type {Array<string>}
 */
const TRUSTED_COMPANIES = [];

/**
 * Employers that only exist on the bundled offline board. Their apply URLs point
 * at `*.example.com`, which is reserved by RFC 2606 and resolves nowhere - so
 * they are only admitted while the demo board itself is switched on. Leaving
 * them permanently on the allow-list is what put dead "Apply" links on a
 * dashboard that was otherwise scraping real boards.
 *
 * @type {Array<string>}
 */
const DEMO_COMPANIES = [
  'Tech Innovators Inc.',
  'Data Systems LLC',
  'Bright Apps Studio',
  'Fintech Core Systems',
  'CloudScale Ops',
];

/** Whether the offline demo board is part of the rotation. Off by default. */
const mockBoardEnabled = () => String(process.env.ENABLE_MOCK_BOARD || 'false').toLowerCase() === 'true';

/* ------------------------------------------------------------------ */
/* Career pages                                                        */
/* ------------------------------------------------------------------ */

/**
 * The only URLs the scraper is allowed to open.
 *
 * Each of these was checked to serve its ATS's own markup. Some companies
 * (Databricks, Stripe) redirect their `greenhouse.io/<slug>` URL to a bespoke
 * careers site, which no ATS profile can read - verify a new board with
 * `ENABLED_SOURCES=<id> npm run scrape` before relying on it.
 *
 * @type {Array<string>}
 */
const SOURCE_URLS = [
  // --- Hiring in India -------------------------------------------------
  // Each of these was confirmed to serve its ATS's own markup *and* to return
  // postings. A board that answers 200 with an empty shell (Zepto, Juspay,
  // Hasura, Darwinbox, Rippling and Slice all do) is worse than no source: it
  // scrapes cleanly, finds nothing, and looks like a selector bug.
  'https://job-boards.greenhouse.io/groww',
  'https://job-boards.greenhouse.io/phonepe',
  'https://job-boards.greenhouse.io/hackerrank',
  'https://job-boards.greenhouse.io/postman',
  'https://job-boards.greenhouse.io/zscaler',
  'https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited',
  'https://job-boards.greenhouse.io/tekion',
  'https://job-boards.greenhouse.io/newrelic',
  'https://job-boards.greenhouse.io/coursera',
  'https://jobs.lever.co/cred',
  'https://jobs.lever.co/meesho',
  'https://jobs.lever.co/zeta',
  'https://jobs.lever.co/porter',
  'https://jobs.lever.co/mindtickle',
  'https://jobs.lever.co/hevodata',
  'https://jobs.ashbyhq.com/atlan',

  // --- Global boards with India offices or remote hiring -----------------
  'https://job-boards.greenhouse.io/gitlab',
  'https://job-boards.greenhouse.io/twilio',
  'https://job-boards.greenhouse.io/airtable',

  // --- Global boards ---------------------------------------------------
  'https://job-boards.greenhouse.io/anthropic',
  'https://job-boards.greenhouse.io/discord',
  'https://job-boards.greenhouse.io/figma',
  'https://job-boards.greenhouse.io/reddit',
  'https://jobs.ashbyhq.com/openai',
  'https://jobs.ashbyhq.com/ramp',
  'https://jobs.lever.co/spotify',
];

/**
 * Per-URL metadata. Anything omitted is inferred: the company name comes from
 * the board slug and the selectors come from the ATS profile.
 * `enabled: false` keeps a source in the file but out of the rotation.
 */
const SOURCE_OVERRIDES = {
  'https://job-boards.greenhouse.io/groww': { company: 'Groww' },
  'https://job-boards.greenhouse.io/phonepe': { company: 'PhonePe' },
  'https://job-boards.greenhouse.io/hackerrank': { company: 'HackerRank' },
  'https://job-boards.greenhouse.io/postman': { company: 'Postman' },
  'https://job-boards.greenhouse.io/zscaler': { company: 'Zscaler' },
  'https://jobs.lever.co/cred': { company: 'CRED' },
  'https://jobs.lever.co/meesho': { company: 'Meesho' },
  'https://jobs.lever.co/zeta': { company: 'Zeta' },
  'https://jobs.lever.co/porter': { company: 'Porter' },
  'https://jobs.lever.co/mindtickle': { company: 'Mindtickle' },
  'https://jobs.lever.co/hevodata': { company: 'Hevo Data' },
  'https://jobs.ashbyhq.com/atlan': { company: 'Atlan' },
  // The Greenhouse slug is the registered entity, not the brand.
  'https://job-boards.greenhouse.io/razorpaysoftwareprivatelimited': { company: 'Razorpay' },
  'https://job-boards.greenhouse.io/tekion': { company: 'Tekion' },
  'https://job-boards.greenhouse.io/newrelic': { company: 'New Relic' },
  'https://job-boards.greenhouse.io/coursera': { company: 'Coursera' },
  'https://job-boards.greenhouse.io/gitlab': { company: 'GitLab' },
  'https://job-boards.greenhouse.io/twilio': { company: 'Twilio' },
  'https://job-boards.greenhouse.io/airtable': { company: 'Airtable' },

  'https://job-boards.greenhouse.io/anthropic': { company: 'Anthropic' },
  'https://job-boards.greenhouse.io/discord': { company: 'Discord' },
  'https://job-boards.greenhouse.io/figma': { company: 'Figma' },
  'https://job-boards.greenhouse.io/reddit': { company: 'Reddit' },
  'https://jobs.ashbyhq.com/openai': { company: 'OpenAI' },
  'https://jobs.ashbyhq.com/ramp': { company: 'Ramp' },
  'https://jobs.lever.co/spotify': { company: 'Spotify' },
};

/**
 * Offline board bundled with the repo. It is a real source as far as the engine
 * is concerned, which makes the whole pipeline runnable with no network access.
 */
const LOCAL_SOURCES = [
  {
    id: 'mock-board',
    name: 'Local Demo Job Board',
    company: 'Acme Corp',
    ats: 'file',
    enabled: mockBoardEnabled(),
    filePath: 'mock-job-board.html',
    baseUrl: 'https://example.com',
  },
];

/* ------------------------------------------------------------------ */
/* ATS selector profiles                                               */
/* ------------------------------------------------------------------ */

/**
 * Selector contract:
 *   card            repeated element wrapping one posting (required)
 *   title           job title, relative to `card`
 *   company         employer name, relative to `card` (optional - the board
 *                   slug is authoritative for single-company career pages)
 *   description     short summary shown on the list page
 *   link            anchor carrying the apply URL
 *   waitForSelector selector Puppeteer waits for before reading the DOM
 *   detail          selector for the description on an individual job page
 *
 * Field selectors may be an **array**, which `parseHtml` treats as an ordered
 * preference list: the first selector that matches wins. That matters on boards
 * whose card is `<a><p class="title">..</p><p class="location">..</p></a>` - a
 * comma-grouped string would match the wrapping anchor first and pull the
 * location into the title.
 */
const ATS_PROFILES = {
  greenhouse: {
    label: 'Greenhouse',
    waitForSelector: 'tr.job-post a, .opening a',
    selectors: {
      card: ['tr.job-post', '.opening'],
      title: ['p.body--medium', '.opening a', 'a'],
      // Greenhouse's second metadata line is the office, which is where the
      // country comes from - see the location gate in services/relevance.js.
      location: ['p.body--metadata', '.location'],
      description: ['p.body--metadata', '.location'],
      link: ['a'],
    },
    detail: '#content, .job__description, main',
    jobUrlPattern: /\/jobs\/\d+|\/job\//i,
  },

  lever: {
    label: 'Lever',
    waitForSelector: '.posting, [data-qa="posting"]',
    selectors: {
      card: ['.posting', '[data-qa="posting"]'],
      title: ['[data-qa="posting-name"]', '.posting-title h5', 'h5', 'a'],
      location: ['.sort-by-location', '.location', '.posting-categories'],
      description: ['.posting-categories', '.sort-by-team'],
      link: ['a.posting-title', 'a'],
    },
    detail: '.section-wrapper .section, .content',
    jobUrlPattern: /jobs\.lever\.co\/[^/]+\/[0-9a-f-]{8,}/i,
  },

  ashby: {
    label: 'Ashby',
    // Ashby renders its board client-side, so the wait matters here.
    waitForSelector: 'a[href*="/"], .ashby-job-posting-brief-list',
    selectors: {
      card: ['.ashby-job-posting-brief-list a', 'a[href*="/jobs/"]'],
      title: ['h3', '.ashby-job-posting-brief-title', 'p:first-child', 'span'],
      location: ['.ashby-job-posting-brief-details', 'p:nth-of-type(2)'],
      description: ['.ashby-job-posting-brief-details', 'p:nth-of-type(2)'],
      link: ['a'],
    },
    detail: '.ashby-job-posting-right-pane, main, #root',
    jobUrlPattern: /\/[0-9a-f]{8}-[0-9a-f]{4}-/i,
  },

  file: {
    label: 'Local file',
    selectors: {
      card: '.job-listing',
      title: '.job-title',
      company: '.company-name',
      description: '.job-description',
      date: '.date-posted',
      link: '.apply-btn',
    },
  },

  generic: {
    label: 'Generic career page',
    waitForSelector: null,
    selectors: {
      card: ['[class*="job"]', '[class*="posting"]', '[class*="opening"]'],
      title: ['h2', 'h3', 'h4', 'a'],
      description: ['p'],
      link: ['a'],
    },
    detail: 'main, article, body',
    jobUrlPattern: /(job|career|position|opening)/i,
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Strips punctuation/spacing and lowercases so "Acme Corp." === "acme corp".
 * @param {unknown} name
 * @returns {string}
 */
function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|plc|limited)\b/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * The active allow-list, honouring the TRUSTED_COMPANIES env override.
 * @returns {Array<string>}
 */
function getTrustedCompanies() {
  const override = (process.env.TRUSTED_COMPANIES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (override.length) return override;

  // Every company that owns a configured board is trusted by definition: the
  // whole point of scraping `job-boards.greenhouse.io/<slug>` is that it is that
  // employer's own careers page. Requiring the name to *also* appear in
  // TRUSTED_COMPANIES meant adding a board silently produced zero postings until
  // someone remembered to edit a second list.
  const fromSources = SOURCE_URLS.map((url) => SOURCE_OVERRIDES[url]?.company || titleCase(identify(url).slug));

  const names = new Set([...TRUSTED_COMPANIES, ...fromSources]);
  if (mockBoardEnabled()) DEMO_COMPANIES.forEach((name) => names.add(name));

  return [...names];
}

/** Pre-computed lookup, rebuilt on every call so env changes are picked up. */
function trustedIndex() {
  return new Map(getTrustedCompanies().map((name) => [normalizeCompany(name), name]));
}

/**
 * Whether a scraped employer is on the allow-list.
 *
 * @param {string} company employer name as scraped
 * @returns {boolean}
 */
function isTrustedCompany(company) {
  const key = normalizeCompany(company);
  if (!key) return false;
  return trustedIndex().has(key);
}

/**
 * Canonical spelling for a trusted employer ("figma" -> "Figma"), so the
 * dashboard shows one consistent name per company.
 *
 * @param {string} company
 * @returns {string|null} canonical name, or null when not trusted
 */
function canonicalCompany(company) {
  return trustedIndex().get(normalizeCompany(company)) || null;
}

/**
 * Picks the ATS profile for a URL from its hostname.
 * @param {string} url
 * @returns {string} profile key
 */
function detectAts(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();

  if (host.includes('greenhouse.io')) return 'greenhouse';
  if (host.includes('lever.co')) return 'lever';
  if (host.includes('ashbyhq.com')) return 'ashby';
  return 'generic';
}

/**
 * Derives a stable source id and a human name from a board URL.
 * @param {string} url
 * @returns {{id:string, slug:string}}
 */
function identify(url) {
  let slug = '';
  try {
    const parsed = new URL(url);
    slug = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname.split('.')[0];
  } catch {
    slug = 'source';
  }
  const ats = detectAts(url);
  return { id: `${ats}-${slug}`.toLowerCase(), slug };
}

/**
 * Turns a slug into a display name ("acme-corp" -> "Acme Corp").
 * @param {string} slug
 * @returns {string}
 */
function titleCase(slug) {
  return String(slug)
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Expands `SOURCE_URLS` (plus the local board) into full source definitions.
 *
 * @returns {Array<{id:string,name:string,company:string,url?:string,filePath?:string,ats:string,selectors:object,waitForSelector:?string,detail:?string,baseUrl:string,enabled:boolean}>}
 */
function buildSources() {
  const remote = SOURCE_URLS.map((url) => {
    const override = SOURCE_OVERRIDES[url] || {};
    const { id, slug } = identify(url);
    const ats = override.ats || detectAts(url);
    const profile = ATS_PROFILES[ats] || ATS_PROFILES.generic;
    const company = override.company || titleCase(slug);

    return {
      id: override.id || id,
      name: override.name || `${company} (${profile.label})`,
      company,
      url,
      ats,
      selectors: override.selectors || profile.selectors,
      waitForSelector: override.waitForSelector ?? profile.waitForSelector ?? null,
      detail: override.detail || profile.detail || null,
      jobUrlPattern: profile.jobUrlPattern || null,
      baseUrl: override.baseUrl || new URL(url).origin,
      enabled: override.enabled !== false,
      maxJobs: override.maxJobs ?? Number(process.env.MAX_JOBS_PER_SOURCE || 12),
    };
  });

  const local = LOCAL_SOURCES.map((source) => {
    const profile = ATS_PROFILES[source.ats] || ATS_PROFILES.generic;
    return {
      jobUrlPattern: null,
      detail: null,
      waitForSelector: null,
      maxJobs: Number(process.env.MAX_JOBS_PER_SOURCE || 12),
      selectors: profile.selectors,
      ...source,
      name: source.name || titleCase(source.id),
    };
  });

  return [...local, ...remote];
}

/**
 * Sources that should actually run, honouring `ENABLED_SOURCES`.
 * @returns {Array<object>}
 */
function getEnabledSources() {
  const sources = buildSources();
  const override = (process.env.ENABLED_SOURCES || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (override.length > 0) {
    const known = new Set(sources.map((source) => source.id));
    override
      .filter((id) => !known.has(id))
      .forEach((id) => console.warn(`[sources] Unknown source id in ENABLED_SOURCES: "${id}"`));
    return sources.filter((source) => override.includes(source.id));
  }

  return sources.filter((source) => source.enabled);
}

module.exports = {
  SOURCE_URLS,
  TRUSTED_COMPANIES,
  DEMO_COMPANIES,
  ATS_PROFILES,
  buildSources,
  getEnabledSources,
  getTrustedCompanies,
  isTrustedCompany,
  canonicalCompany,
  normalizeCompany,
  detectAts,
};
