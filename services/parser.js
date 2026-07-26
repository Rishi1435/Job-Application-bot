/**
 * Text extraction helpers.
 *
 * Two jobs live here, both pure (no network, no database) so they can be
 * unit-tested in isolation - see `tests/units.test.js`:
 *
 *   1. HTML -> job records, driven by a source's selector map (the scraper).
 *   2. Uploaded resume buffer -> plain text (PDF via pdf-parse, DOCX via
 *      mammoth). Buffers arrive from multer's memory storage and are never
 *      written to disk.
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
 * Finds the first descendant matching a selector.
 *
 * An array is an *ordered preference list*: each selector is tried in turn and
 * the first one that matches anything wins. A comma-grouped string cannot
 * express that - cheerio returns grouped matches in document order, so on a
 * card like `<a><p class="title">..</p></a>` the wrapping anchor would beat the
 * title element and swallow every other line of text with it.
 *
 * @param {import('cheerio').Cheerio} card
 * @param {string|Array<string>|undefined} selector
 * @returns {import('cheerio').Cheerio|null}
 */
function findFirst(card, selector) {
  for (const candidate of Array.isArray(selector) ? selector : [selector]) {
    if (!candidate) continue;
    const node = card.find(candidate).first();
    if (node.length) return node;
  }
  return null;
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

  $(Array.isArray(selectors.card) ? selectors.card.join(', ') : selectors.card).each((_, element) => {
    const card = $(element);

    /** Text of the first matching descendant, or '' when nothing matches. */
    const text = (selector) => {
      const node = findFirst(card, selector);
      return clean(node ? node.text() : '');
    };

    const title = text(selectors.title);

    const linkNode = selectors.link ? findFirst(card, selectors.link) : card.find('a').first();
    const href = linkNode?.attr('href') || (card.is('a') ? card.attr('href') : '');
    const applyUrl = absoluteUrl(href, baseUrl);

    let dateRaw = '';
    if (selectors.date) {
      const dateNode = findFirst(card, selectors.date);
      dateRaw = (selectors.dateAttr && dateNode?.attr(selectors.dateAttr)) || clean(dateNode ? dateNode.text() : '');
    }

    if (title && applyUrl) {
      jobs.push({
        title,
        company: text(selectors.company),
        // Every ATS prints the office on the card, and it is the only place the
        // country appears cheaply - the detail page is behind another request.
        location: text(selectors.location),
        description: text(selectors.description),
        datePosted: dateRaw,
        applyUrl,
      });
    }
  });

  return jobs;
}

/**
 * Extracts the visible text of a rendered job page, minus chrome (nav, footer,
 * scripts). Used for the job description when a posting's own page is opened.
 *
 * @param {string} html full page markup
 * @param {string} [selector] container selector, e.g. `main`
 * @returns {string}
 */
function extractText(html, selector) {
  const $ = cheerio.load(html);
  $('script, style, noscript, nav, header, footer, svg').remove();

  const scope = selector ? $(selector).first() : $('body');
  const node = scope.length ? scope : $('body');
  return clean(node.text());
}

/* ------------------------------------------------------------------ */
/* Resume extraction                                                   */
/* ------------------------------------------------------------------ */

/** Upload types the API accepts. */
const SUPPORTED_RESUME_TYPES = {
  pdf: ['application/pdf'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword', // some browsers mislabel .docx
  ],
  txt: ['text/plain', 'text/markdown'],
};

/**
 * Classifies an upload from its extension first (browsers lie about MIME types
 * often enough that the filename is the more reliable signal) and its declared
 * content type second.
 *
 * @param {string} filename
 * @param {string} [mimetype]
 * @returns {'pdf'|'docx'|'txt'|null}
 */
function detectResumeKind(filename, mimetype = '') {
  const extension = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx' || extension === 'doc') return 'docx';
  if (extension === 'txt' || extension === 'md') return 'txt';

  for (const [kind, types] of Object.entries(SUPPORTED_RESUME_TYPES)) {
    if (types.includes(String(mimetype).toLowerCase())) return kind;
  }
  return null;
}

/**
 * Normalises extracted resume text: collapses the runs of blank lines and
 * stray whitespace that PDF extraction produces, while keeping line breaks
 * (bullet structure carries meaning for the matcher).
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeResumeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/**
 * Reads a PDF buffer.
 *
 * pdf-parse v2 exposes a `PDFParse` class while v1 exported a plain function;
 * both shapes are handled so an npm upgrade cannot silently break uploads.
 *
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractPdfText(buffer) {
  const mod = require('pdf-parse');

  if (typeof mod?.PDFParse === 'function') {
    const parser = new mod.PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result?.text || '';
    } finally {
      await parser.destroy?.().catch?.(() => {});
    }
  }

  const legacy = typeof mod === 'function' ? mod : mod?.default;
  if (typeof legacy !== 'function') throw new Error('Unsupported pdf-parse build.');
  return (await legacy(buffer))?.text || '';
}

/**
 * Turns an uploaded resume buffer into plain text.
 *
 * @param {Buffer} buffer file contents from `multer.memoryStorage()`
 * @param {string} filename original name, used to pick the extractor
 * @param {string} [mimetype] browser-declared content type
 * @returns {Promise<{filename:string, kind:string, text:string, characters:number}>}
 * @throws {Error} for unsupported types, corrupt files or image-only PDFs
 */
async function extractResumeText(buffer, filename, mimetype = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error(`"${filename}" is empty.`);
  }

  const kind = detectResumeKind(filename, mimetype);
  if (!kind) {
    throw new Error(`"${filename}" is not a supported resume format (PDF, DOCX or TXT).`);
  }

  let raw = '';
  try {
    if (kind === 'pdf') {
      raw = await extractPdfText(buffer);
    } else if (kind === 'docx') {
      const mammoth = require('mammoth');
      raw = (await mammoth.extractRawText({ buffer })).value || '';
    } else {
      raw = buffer.toString('utf-8');
    }
  } catch (error) {
    throw new Error(`Could not read "${filename}": ${error.message}`);
  }

  const text = normalizeResumeText(raw);
  if (text.length < 50) {
    // Almost always a scanned/image-only PDF - there is no text layer to read.
    throw new Error(`"${filename}" contained no readable text (a scanned image PDF cannot be parsed).`);
  }

  return { filename, kind, text, characters: text.length };
}

module.exports = {
  clean,
  repairMojibake,
  decodeEntities,
  normalizeDate,
  absoluteUrl,
  parseHtml,
  extractText,
  findFirst,
  // resume parsing
  extractResumeText,
  detectResumeKind,
  normalizeResumeText,
  SUPPORTED_RESUME_TYPES,
};
