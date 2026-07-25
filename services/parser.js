/**
 * Pure HTML/text parsing helpers used by the scraper.
 *
 * Kept free of I/O (no network, no database) so the extraction logic can be
 * unit-tested in isolation - see `tests/units.test.js`.
 */

const cheerio = require('cheerio');

/** The handful of named entities that survive in JSON feeds. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', hellip: '...', rsquo: '’', lsquo: '‘',
  ldquo: '“', rdquo: '”',
};

/**
 * Repairs text whose UTF-8 bytes were decoded as latin1 somewhere upstream
 * ("Coordenação" -> "CoordenaÃ§Ã£o"). Some feeds - RemoteOK among them - ship
 * their data already mangled, so this runs on every scraped string.
 *
 * @param {string} text
 * @returns {string} the repaired text, or the input when it looks fine
 */
function repairMojibake(text) {
  if (!/[ÂÃ][-¿]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf-8');
    return repaired.includes('�') ? text : repaired;
  } catch {
    return text;
  }
}

/**
 * Decodes HTML entities that appear inside JSON payloads (Cheerio already
 * handles this for the HTML modes).
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * Normalises a scraped string: repairs encoding damage, decodes entities and
 * collapses runs of whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
const clean = (value) => decodeEntities(repairMojibake(String(value || ''))).replace(/\s+/g, ' ').trim();

/**
 * Normalises a posting date to `YYYY-MM-DD` when it can be understood,
 * otherwise returns the cleaned original string.
 *
 * Handles ISO dates, unix timestamps (seconds or milliseconds) and the
 * "3 days ago" phrasing common on job boards.
 *
 * @param {string|number|undefined|null} value
 * @returns {string|null}
 */
function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;

  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const num = Number(value);
    const date = new Date(num < 1e12 ? num * 1000 : num);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }

  const text = clean(value);

  const relative = text.match(/(\d+)\s*(hour|day|week|month)s?\s*ago/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unitDays = { hour: 1 / 24, day: 1, week: 7, month: 30 }[relative[2].toLowerCase()];
    return new Date(Date.now() - amount * unitDays * 86400000).toISOString().slice(0, 10);
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);

  return text || null;
}

/**
 * Resolves a possibly-relative href against the source's base URL and rejects
 * anything that is not a usable navigation target.
 *
 * @param {string|undefined} href raw href attribute
 * @param {string} [baseUrl]
 * @returns {string|null} absolute URL, or null when unusable
 */
function absoluteUrl(href, baseUrl) {
  const raw = clean(href);
  if (!raw || raw.startsWith('#') || /^javascript:/i.test(raw)) return null;
  try {
    const resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

/**
 * Applies a source's selector map to an HTML document.
 * Postings without both a title and an apply URL are discarded.
 *
 * @param {string} html document markup
 * @param {object} source source definition from `config/sources.js`
 * @returns {Array<{title:string, company:string, description:string, datePosted:string, applyUrl:string}>}
 */
function parseHtml(html, source) {
  const $ = cheerio.load(html);
  const { selectors = {}, baseUrl } = source;
  const jobs = [];

  $(selectors.card).each((_, element) => {
    const card = $(element);

    /** Text of the first matching descendant, or '' when the selector misses. */
    const text = (selector) => {
      if (!selector) return '';
      const node = card.find(selector).first();
      return clean(node.length ? node.text() : '');
    };

    const title = text(selectors.title);

    const linkNode = selectors.link ? card.find(selectors.link).first() : card.find('a').first();
    const href = linkNode.attr('href') || (card.is('a') ? card.attr('href') : '');
    const applyUrl = absoluteUrl(href, baseUrl);

    let dateRaw = '';
    if (selectors.date) {
      const dateNode = card.find(selectors.date).first();
      dateRaw = (selectors.dateAttr && dateNode.attr(selectors.dateAttr)) || clean(dateNode.text());
    }

    if (title && applyUrl) {
      jobs.push({
        title,
        company: text(selectors.company),
        description: text(selectors.description),
        datePosted: dateRaw,
        applyUrl,
      });
    }
  });

  return jobs;
}

module.exports = {
  clean,
  repairMojibake,
  decodeEntities,
  normalizeDate,
  absoluteUrl,
  parseHtml,
};
