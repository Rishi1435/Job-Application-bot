/**
 * Job board source definitions.
 *
 * The scraper is config-driven: adding a new board means adding an entry here,
 * not writing new scraping code. Three fetch modes are supported:
 *
 *   'file'    - read a local HTML file (used for the offline demo board)
 *   'static'  - HTTP GET + Cheerio (server-rendered boards)
 *   'dynamic' - Puppeteer render + Cheerio (JavaScript-rendered boards)
 *   'json'    - HTTP GET against a public JSON endpoint + a mapping function
 *
 * Selector contract for the HTML modes:
 *   card        - repeated element wrapping one job posting (required)
 *   title       - job title, relative to `card` (required)
 *   company     - hiring company
 *   description - job summary / description text
 *   date        - posting date; `dateAttr` is preferred when present
 *   link        - anchor holding the apply URL (`href` is read from it)
 *
 * Any selector that resolves to nothing simply yields an empty field; only
 * `title` and the apply URL are mandatory for a posting to be kept.
 *
 * Enable/disable at runtime with the `ENABLED_SOURCES` env var, e.g.
 *   ENABLED_SOURCES=mock-board,remoteok
 */

const SOURCES = [
  {
    id: 'mock-board',
    name: 'Local Demo Job Board',
    enabled: true,
    mode: 'file',
    // Bundled sample markup so the pipeline is runnable with zero network access.
    filePath: 'mock-job-board.html',
    baseUrl: 'https://example.com',
    selectors: {
      card: '.job-listing',
      title: '.job-title',
      company: '.company-name',
      description: '.job-description',
      date: '.date-posted',
      link: '.apply-btn',
    },
  },

  {
    id: 'remoteok',
    name: 'RemoteOK (remote developer jobs)',
    // Public JSON feed - the most reliable real source, so it ships enabled.
    // Attribution to remoteok.com is required by their terms when reposting.
    enabled: true,
    mode: 'json',
    url: 'https://remoteok.com/api',
    /**
     * Maps the RemoteOK payload onto the internal job shape.
     *
     * The feed is the whole board (sales, support, design...), so it is first
     * narrowed to engineering roles - both to keep the dashboard relevant and
     * to avoid spending LLM calls on obviously irrelevant postings. The filter
     * looks at the job title only: RemoteOK's `tags` are keyword-stuffed and
     * tag almost every posting with "dev"/"engineer".
     * The first array element is a legal notice, not a job, so it is skipped.
     *
     * @param {any} payload parsed JSON body
     * @returns {Array<object>} raw job records
     */
    map(payload) {
      if (!Array.isArray(payload)) return [];

      const ENGINEERING = /\b(developer|engineer|programmer|full[\s-]?stack|backend|back[\s-]?end|frontend|front[\s-]?end|mobile|android|ios|flutter|react|node|java|javascript|typescript|python|golang|software|devops|sre|architect)\b/i;

      return payload
        .filter((row) => row && row.id && row.position)
        .filter((row) => ENGINEERING.test(row.position))
        .map((row) => ({
          title: row.position,
          company: row.company,
          description: [row.description, Array.isArray(row.tags) ? `Tags: ${row.tags.join(', ')}` : '']
            .filter(Boolean)
            .join('\n'),
          applyUrl: row.apply_url || row.url,
          datePosted: row.date,
        }));
    },
    // RemoteOK returns hundreds of postings; cap the per-run workload.
    maxJobs: Number(process.env.REMOTEOK_MAX_JOBS || 15),
  },

  {
    id: 'weworkremotely',
    name: 'We Work Remotely (full-stack programming)',
    // Server-rendered HTML. Disabled by default because markup changes often;
    // enable with ENABLED_SOURCES once you have verified the selectors.
    enabled: false,
    mode: 'static',
    url: 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs',
    baseUrl: 'https://weworkremotely.com',
    selectors: {
      card: 'section.jobs li:not(.view-all)',
      title: 'span.title',
      company: 'span.company:first-of-type',
      description: 'span.region',
      date: 'time',
      dateAttr: 'datetime',
      link: 'a[href*="/remote-jobs/"]',
    },
    maxJobs: Number(process.env.WWR_MAX_JOBS || 20),
  },

  {
    id: 'example-dynamic-board',
    name: 'Example JavaScript-rendered board (Puppeteer)',
    // Template for a client-rendered board. Point `url` at the real board,
    // adjust the selectors, then enable it. Requires `npm install puppeteer`.
    enabled: false,
    mode: 'dynamic',
    url: 'https://example.com/jobs?q=full+stack',
    baseUrl: 'https://example.com',
    // Wait for this selector before reading the DOM (null = wait for network idle only).
    waitForSelector: '.job-card',
    selectors: {
      card: '.job-card',
      title: '.job-card__title',
      company: '.job-card__company',
      description: '.job-card__summary',
      date: 'time',
      dateAttr: 'datetime',
      link: 'a.job-card__link',
    },
  },
];

/**
 * Returns the sources that should run, honouring the `ENABLED_SOURCES` override.
 *
 * @returns {Array<object>} active source definitions
 */
function getEnabledSources() {
  const override = (process.env.ENABLED_SOURCES || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  if (override.length > 0) {
    const known = new Set(SOURCES.map((s) => s.id));
    override
      .filter((id) => !known.has(id))
      .forEach((id) => console.warn(`[sources] Unknown source id in ENABLED_SOURCES: "${id}"`));
    return SOURCES.filter((source) => override.includes(source.id));
  }

  return SOURCES.filter((source) => source.enabled);
}

module.exports = {
  SOURCES,
  getEnabledSources,
};
