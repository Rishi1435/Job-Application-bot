/**
 * Dynamic source registry.
 *
 * There is no company list in this file any more. The engine used to iterate a
 * hand-written array of ~30 career pages, which meant the bot could only ever
 * find jobs at companies somebody had already thought of. It now *discovers*
 * employers at run time and keeps them in the `ats_boards` table, so the reach
 * of a run grows with every crawl instead of with every commit.
 *
 * What stays here is the part that genuinely is configuration:
 *
 *   1. TRUSTED ATS DOMAINS - the domain extensions a posting may live on. This
 *      is the replacement for the old `TRUSTED_COMPANIES` allow-list, and it is
 *      what keeps the pipeline closed by default: a discovered URL is only
 *      followed when it belongs to a real applicant tracking system, so an
 *      aggregator, a content farm or a scraped-and-reposted ghost listing never
 *      enters the database however it was found.
 *   2. ATS SEARCH PATTERNS - how to turn a board slug into that platform's
 *      public JSON endpoint (Greenhouse, Lever, Ashby, Workday).
 *   3. QUERY TEMPLATES - the role vocabulary and the search-engine dorks that
 *      skills extracted from the user's resumes are substituted into.
 *   4. ATS SELECTOR PROFILES - retained for the HTML paths (a board page or a
 *      job detail page that has to be read with Cheerio rather than an API).
 *
 * Runtime overrides:
 *   TRUSTED_ATS_DOMAINS=greenhouse.io,lever.co   (replaces the domain list)
 *   ENABLED_CHANNELS=ats-api,job-feeds           (subset of the three channels)
 *   SEARCH_ENGINE=duckduckgo-html|duckduckgo-lite|bing
 */

/* ------------------------------------------------------------------ */
/* Trusted ATS domains                                                 */
/* ------------------------------------------------------------------ */

/**
 * Domain extensions a job URL may live on.
 *
 * Matching is on the *registrable suffix*, so every tenant of a platform is
 * covered by one entry: `job-boards.greenhouse.io`, `boards.eu.greenhouse.io`
 * and `acme.wd5.myworkdayjobs.com` all pass without being listed.
 *
 * @type {Array<string>}
 */
const ATS_DOMAINS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'workday.com', 'myworkdayjobs.com', 'workdayjobs.com'];

/**
 * Open developer job feeds. Their postings are hosted on the feed's own domain
 * (RemoteOK and Arbeitnow both redirect through a permalink they control), so
 * the domains are trusted for the same reason an ATS domain is: the operator is
 * known and the link is stable.
 *
 * @type {Array<string>}
 */
const FEED_DOMAINS = ['remoteok.com', 'arbeitnow.com', 'ycombinator.com'];

/**
 * The active domain allow-list, honouring the TRUSTED_ATS_DOMAINS override.
 * @returns {Array<string>}
 */
function getTrustedDomains() {
  const override = (process.env.TRUSTED_ATS_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);

  return override.length ? override : [...ATS_DOMAINS, ...FEED_DOMAINS];
}

/**
 * Whether a URL sits on a trusted domain (or one of its subdomains).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isTrustedJobUrl(url) {
  let host;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  return getTrustedDomains().some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/* ------------------------------------------------------------------ */
/* ATS search patterns                                                 */
/* ------------------------------------------------------------------ */

/**
 * Public, unauthenticated endpoints for the four platforms that host most
 * software job postings.
 *
 * Every one of these returns the *full* job description, which is why the
 * engine prefers them to rendering the board in Chromium: one HTTP request
 * replaces a page load plus N detail-page loads, and the text the matcher
 * reasons over is the canonical one rather than whatever survived a CSS
 * selector.
 *
 * Contract per platform:
 *   dorkSite   the host to aim a `site:` search at
 *   boardUrl   human-facing board page for a slug
 *   apiUrl     JSON endpoint for a slug (null when it needs a POST body)
 *   slugFrom   pulls the board slug out of any URL on that platform
 *
 * @type {Record<string, {label:string, domains:Array<string>, dorkSites:Array<string>, boardUrl:(slug:string)=>string, apiUrl:?(slug:string)=>string, slugFrom:(parsed:URL)=>string|null}>}
 */
const ATS_PLATFORMS = {
  greenhouse: {
    label: 'Greenhouse',
    domains: ['greenhouse.io'],
    dorkSites: ['job-boards.greenhouse.io', 'boards.greenhouse.io'],
    boardUrl: (slug) => `https://job-boards.greenhouse.io/${slug}`,
    apiUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`,
    // https://job-boards.greenhouse.io/<slug>[/jobs/<id>]
    slugFrom: (parsed) => parsed.pathname.split('/').filter(Boolean)[0] || null,
  },

  lever: {
    label: 'Lever',
    domains: ['lever.co'],
    dorkSites: ['jobs.lever.co'],
    boardUrl: (slug) => `https://jobs.lever.co/${slug}`,
    apiUrl: (slug) => `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`,
    // https://jobs.lever.co/<slug>[/<uuid>]
    slugFrom: (parsed) => parsed.pathname.split('/').filter(Boolean)[0] || null,
  },

  ashby: {
    label: 'Ashby',
    domains: ['ashbyhq.com'],
    dorkSites: ['jobs.ashbyhq.com'],
    boardUrl: (slug) => `https://jobs.ashbyhq.com/${slug}`,
    apiUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}`,
    // https://jobs.ashbyhq.com/<slug>[/<uuid>]
    slugFrom: (parsed) => parsed.pathname.split('/').filter(Boolean)[0] || null,
  },

  workday: {
    label: 'Workday',
    domains: ['myworkdayjobs.com', 'workdayjobs.com', 'workday.com'],
    dorkSites: ['myworkdayjobs.com'],
    // Workday is multi-tenant *and* multi-site, so one slug has to carry both:
    // "<host>/<site>", e.g. "acme.wd5.myworkdayjobs.com/AcmeCareers".
    boardUrl: (slug) => `https://${slug.split('/')[0]}/en-US/${slug.split('/')[1] || ''}`,
    // The search endpoint is a POST with a JSON body - see `fetchWorkdayBoard`.
    apiUrl: null,
    slugFrom: (parsed) => {
      // /en-US/<site>/job/... , /<site>/job/... or /en-US/<site>
      const parts = parsed.pathname.split('/').filter(Boolean);
      const site = parts.find((part) => !/^[a-z]{2}-[A-Z]{2}$/.test(part) && part !== 'job' && part !== 'details');
      return site ? `${parsed.hostname.toLowerCase()}/${site}` : null;
    },
  },
};

/**
 * Workday's job-search endpoint for a `<host>/<site>` slug.
 *
 * @param {string} slug
 * @returns {{url:string, tenant:string, host:string, site:string}|null}
 */
function workdayEndpoint(slug) {
  const [host, site] = String(slug || '').split('/');
  if (!host || !site) return null;
  const tenant = host.split('.')[0];
  return { url: `https://${host}/wday/cxs/${tenant}/${site}/jobs`, tenant, host, site };
}

/**
 * Identifies the ATS behind any URL.
 *
 * @param {string} url
 * @returns {string} platform key, or 'generic'
 */
function detectAts(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }

  for (const [key, platform] of Object.entries(ATS_PLATFORMS)) {
    if (platform.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return key;
  }
  return 'generic';
}

/**
 * Turns any ATS URL - a board page, a single posting, a search result - into the
 * board it belongs to. This is what makes discovery work: one hit on
 * `jobs.lever.co/acme/1234-uuid` teaches the engine about Acme's whole board.
 *
 * @param {string} url
 * @returns {{platform:string, slug:string, boardUrl:string, company:string}|null}
 */
function parseBoardUrl(url) {
  const platform = detectAts(url);
  if (platform === 'generic') return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const spec = ATS_PLATFORMS[platform];
  const slug = spec.slugFrom(parsed);
  if (!slug || !/^[a-z0-9][a-z0-9._/-]{1,120}$/i.test(slug)) return null;

  // Platform-owned paths that look like a slug but are not a customer board.
  if (RESERVED_SLUGS.has(slug.toLowerCase())) return null;

  return {
    platform,
    slug,
    boardUrl: spec.boardUrl(slug),
    company: titleCase(platform === 'workday' ? slug.split('.')[0] : slug),
  };
}

/** First path segments that belong to the ATS itself rather than to a customer. */
const RESERVED_SLUGS = new Set([
  'embed', 'api', 'v0', 'v1', 'jobs', 'job', 'search', 'about', 'privacy', 'terms',
  'static', 'assets', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'login', 'signup',
  'company', 'companies', 'blog', 'help', 'support', 'legal', 'error', 'index.html',
]);

/* ------------------------------------------------------------------ */
/* Developer job feeds                                                 */
/* ------------------------------------------------------------------ */

/**
 * Open job APIs that need no key and publish structured JSON.
 *
 * `kind` selects the normaliser in `services/scraper.js`. `boardsOnly` feeds do
 * not yield postings directly - they are mined for ATS links, which is how the
 * Hacker News "Who is hiring?" thread turns into 40 new Greenhouse boards.
 *
 * @type {Array<{id:string, label:string, kind:string, url:string|((q:string)=>string), boardsOnly?:boolean}>}
 */
const JOB_FEEDS = [
  {
    id: 'remoteok',
    label: 'RemoteOK',
    kind: 'remoteok',
    url: 'https://remoteok.com/api',
  },
  {
    id: 'arbeitnow',
    label: 'Arbeitnow',
    kind: 'arbeitnow',
    url: 'https://www.arbeitnow.com/api/job-board-api',
  },
  {
    id: 'hn-whoishiring',
    label: 'Hacker News "Who is hiring?"',
    kind: 'hackernews',
    url: 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6',
    boardsOnly: true,
  },
];

/* ------------------------------------------------------------------ */
/* Query templates                                                     */
/* ------------------------------------------------------------------ */

/**
 * Role vocabulary the extracted resume skills are combined with. These are the
 * words job boards actually use in titles, which is what the feed filters and
 * the Workday `searchText` parameter match on.
 *
 * @type {Array<string>}
 */
const ROLE_TERMS = [
  'Software Engineer',
  'Full Stack Developer',
  'Backend Developer',
  'Developer',
  'Software Engineer Intern',
  'Associate Software Engineer',
  'Graduate Software Engineer',
  'Mobile Developer',
];

/**
 * Shapes for a plain search query. `{skill}` and `{role}` are substituted by
 * `buildSearchQueries()` in `services/matcher.js`.
 *
 * @type {Array<string>}
 */
const QUERY_TEMPLATES = ['{skill} {role}', '{role} {skill}', '{skill} Engineer', '{role}'];

/**
 * Search-engine dorks aimed at one ATS host at a time.
 *
 * `{site}` is a host from a platform's `dorkSites`, `{skills}` is an OR-joined
 * quoted skill list ("Node.js" OR "Flutter" OR "Spring Boot") and `{role}` a
 * term from `ROLE_TERMS`. The point of a dork is *discovery* - each result is a
 * career page belonging to a company the database has never seen.
 *
 * @type {Array<string>}
 */
const DORK_TEMPLATES = [
  'site:{site} {skills}',
  'site:{site} {skills} "{role}"',
  'site:{site} "{role}" {skills}',
];

/**
 * Builds the dork list for one run.
 *
 * Skills are batched into OR-groups rather than issued one per query: a search
 * engine will happily answer `"Node.js" OR "Flutter" OR "Spring Boot"` in a
 * single request, and issuing one query per skill per site is what gets a
 * crawler rate-limited.
 *
 * When the candidate's country is known it is added to every other dork. An
 * open crawl otherwise discovers whatever is loudest on the web - which is US
 * startups - and the location gate in `services/relevance.js` then rejects all
 * of it, so the run spends its whole budget finding jobs its own user cannot
 * take.
 *
 * @param {{skills?:Array<string>, roles?:Array<string>, locations?:Array<string>, platforms?:Array<string>, limit?:number, groupSize?:number}} options
 * @returns {Array<string>} dork strings
 */
function buildDorks(options = {}) {
  const skills = (options.skills || []).filter(Boolean);
  const roles = options.roles && options.roles.length ? options.roles : ROLE_TERMS;
  const platforms = options.platforms && options.platforms.length ? options.platforms : Object.keys(ATS_PLATFORMS);
  const locations = (options.locations || []).filter(Boolean);
  const groupSize = Math.max(1, options.groupSize || 3);
  const limit = Math.max(1, options.limit || 12);

  const sites = platforms.flatMap((key) => ATS_PLATFORMS[key]?.dorkSites || []);
  if (!sites.length) return [];

  // Skills in groups of `groupSize`, quoted so a multi-word skill stays one term.
  const groups = [];
  for (let i = 0; i < skills.length; i += groupSize) {
    const group = skills.slice(i, i + groupSize).map((skill) => `"${skill}"`);
    if (group.length) groups.push(group.join(' OR '));
  }
  if (!groups.length) groups.push('"Software Engineer"');

  const dorks = [];
  // Round-robin over sites first: covering four platforms shallowly beats
  // exhausting one before the query budget runs out.
  for (let round = 0; dorks.length < limit && round < groups.length * DORK_TEMPLATES.length; round += 1) {
    for (const site of sites) {
      if (dorks.length >= limit) break;
      const template = DORK_TEMPLATES[round % DORK_TEMPLATES.length];
      // Every other dork carries the candidate's country, so the discovered set
      // is a mix of "anywhere" and "somewhere they can be hired".
      const place = locations.length && dorks.length % 2 === 1 ? ` ${locations[round % locations.length]}` : '';
      const dork = `${template
        .replace('{site}', site)
        .replace('{skills}', groups[round % groups.length])
        .replace('{role}', roles[round % roles.length])}${place}`;
      if (!dorks.includes(dork)) dorks.push(dork);
    }
  }

  return dorks.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Search engines                                                      */
/* ------------------------------------------------------------------ */

/**
 * Result pages a dork can be issued against, in the order they are tried.
 *
 * All of these serve plain server-side markup with the result URLs in the
 * response body, so a query works whether it went through Chromium or a bare
 * fetch. The order is measured rather than assumed:
 *
 *   brave       honours `site:` fully and returns ~20 boards per dork, but
 *               answers 429 to roughly every other rapid query.
 *   duckduckgo  reliable until a burst, then HTTP 202 and an interstitial.
 *   mojeek      independent index, so it is up when the others are throttling;
 *               it is small, so it often has nothing for a narrow dork.
 *
 * Google and Bing are deliberately absent. Both answer a plain client with a
 * JavaScript shell that contains the query and no organic results (Bing also
 * base64-wraps the few links it does emit), so every request to them cost a page
 * load, produced zero boards, and filled the log with navigation errors.
 *
 * No single engine is dependable, which is the reason `runDork` rotates through
 * them and remembers which ones have started refusing.
 *
 * @type {Array<{id:string, url:(query:string)=>string}>}
 */
const SEARCH_ENGINES = [
  { id: 'brave', url: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}` },
  { id: 'duckduckgo-html', url: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}` },
  { id: 'duckduckgo-lite', url: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
  { id: 'mojeek', url: (query) => `https://www.mojeek.com/search?q=${encodeURIComponent(query)}` },
];

/**
 * The engines to use this run, honouring the SEARCH_ENGINE override.
 * @returns {Array<{id:string, url:(query:string)=>string}>}
 */
function getSearchEngines() {
  const wanted = (process.env.SEARCH_ENGINE || '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);

  if (!wanted.length) return SEARCH_ENGINES;
  const chosen = SEARCH_ENGINES.filter((engine) => wanted.includes(engine.id));
  return chosen.length ? chosen : SEARCH_ENGINES;
}

/* ------------------------------------------------------------------ */
/* Discovery channels                                                  */
/* ------------------------------------------------------------------ */

/**
 * The three ways a run finds work. Reported by `GET /api/status` in place of
 * the old static source list, and switchable with `ENABLED_CHANNELS`.
 *
 * @type {Array<{id:string, name:string, description:string}>}
 */
const CHANNELS = [
  {
    id: 'ats-api',
    name: 'ATS search APIs',
    description: 'Greenhouse, Lever, Ashby and Workday public job endpoints for every discovered board.',
  },
  {
    id: 'job-feeds',
    name: 'Developer job feeds',
    description: 'RemoteOK, Arbeitnow and the Hacker News "Who is hiring?" thread, filtered by resume skills.',
  },
  {
    id: 'search-crawl',
    name: 'Search-engine crawling',
    description: 'Puppeteer runs ATS dorks against DuckDuckGo to discover career pages nobody configured.',
  },
];

/**
 * Channels enabled for this run.
 * @returns {Array<{id:string, name:string, description:string}>}
 */
function getEnabledChannels() {
  const override = (process.env.ENABLED_CHANNELS || '')
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);

  if (!override.length) return CHANNELS;

  const known = new Set(CHANNELS.map((channel) => channel.id));
  override
    .filter((id) => !known.has(id))
    .forEach((id) => console.warn(`[sources] Unknown channel in ENABLED_CHANNELS: "${id}"`));

  return CHANNELS.filter((channel) => override.includes(channel.id));
}

/** Whether a channel should run. @param {string} id @returns {boolean} */
const isChannelEnabled = (id) => getEnabledChannels().some((channel) => channel.id === id);

/* ------------------------------------------------------------------ */
/* ATS selector profiles                                               */
/* ------------------------------------------------------------------ */

/**
 * Selectors for the HTML paths that survive: a board whose API answered 404 and
 * has to be read from the page, and the detail page of a posting whose feed
 * entry carried no description.
 *
 * Selector contract:
 *   card / title / company / location / description / link
 *     - a string, or an **array** treated by `parseHtml` as an ordered
 *       preference list (the first selector that matches wins).
 *   waitForSelector  what Puppeteer waits for before reading the DOM
 *   detail           the description container on an individual job page
 */
const ATS_PROFILES = {
  greenhouse: {
    label: 'Greenhouse',
    waitForSelector: 'tr.job-post a, .opening a',
    selectors: {
      card: ['tr.job-post', '.opening'],
      title: ['p.body--medium', '.opening a', 'a'],
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

  workday: {
    label: 'Workday',
    waitForSelector: '[data-automation-id="jobTitle"]',
    selectors: {
      card: ['li.css-1q2dra3', '[data-automation-id="jobResults"] li'],
      title: ['[data-automation-id="jobTitle"]', 'a'],
      location: ['[data-automation-id="locations"]'],
      description: ['[data-automation-id="locations"]'],
      link: ['a'],
    },
    detail: '[data-automation-id="jobPostingDescription"], main',
    jobUrlPattern: /\/job\//i,
  },

  generic: {
    label: 'Career page',
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
 * Turns a slug into a display name ("hevo-data" -> "Hevo Data").
 * @param {string} slug
 * @returns {string}
 */
function titleCase(slug) {
  return String(slug)
    .split(/[-_.\s]/)
    .filter(Boolean)
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/**
 * The selector profile for a URL, used by the HTML fallback paths.
 * @param {string} url
 * @returns {object}
 */
function profileFor(url) {
  return ATS_PROFILES[detectAts(url)] || ATS_PROFILES.generic;
}

module.exports = {
  // trusted domains
  ATS_DOMAINS,
  FEED_DOMAINS,
  getTrustedDomains,
  isTrustedJobUrl,
  // ATS search patterns
  ATS_PLATFORMS,
  workdayEndpoint,
  detectAts,
  parseBoardUrl,
  // feeds
  JOB_FEEDS,
  // query templates
  ROLE_TERMS,
  QUERY_TEMPLATES,
  DORK_TEMPLATES,
  buildDorks,
  SEARCH_ENGINES,
  getSearchEngines,
  // channels
  CHANNELS,
  getEnabledChannels,
  isChannelEnabled,
  // html fallback
  ATS_PROFILES,
  profileFor,
  // helpers
  titleCase,
};
