/**
 * Text extraction helpers.
 *
 * Three jobs live here, all pure (no network, no database) so they can be
 * unit-tested in isolation - see `tests/units.test.js`:
 *
 *   1. HTML -> job records, driven by a source's selector map (the scraper).
 *   2. Uploaded resume buffer -> plain text (PDF via pdf-parse, DOCX via
 *      mammoth). Buffers arrive from multer's memory storage and are never
 *      written to disk.
 *   3. Resume text -> the skills and job titles the crawl searches for
 *      (`extractUserSkills`), which is what makes the scrape follow the person
 *      rather than a hardcoded list of employers.
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

/* ------------------------------------------------------------------ */
/* Resume -> search vocabulary                                          */
/* ------------------------------------------------------------------ */

/**
 * Technologies worth searching a job board for, keyed by the spelling that goes
 * into a query.
 *
 * The canonical key is what gets quoted in a dork (`"Spring Boot"`), so it has
 * to be the spelling employers use in a posting - not a normalised slug. The
 * aliases are what a resume might say instead.
 *
 * @type {Record<string, Array<string>>}
 */
const SKILL_ALIASES = {
  'Node.js': ['node.js', 'nodejs', 'node js'],
  Express: ['express.js', 'expressjs', 'express'],
  JavaScript: ['javascript', 'es6', 'ecmascript'],
  TypeScript: ['typescript', 'ts'],
  React: ['react.js', 'reactjs', 'react'],
  'React Native': ['react native'],
  'Next.js': ['next.js', 'nextjs'],
  Angular: ['angular', 'angularjs'],
  'Vue.js': ['vue.js', 'vuejs', 'vue'],
  Java: ['java', 'j2ee'],
  'Spring Boot': ['spring boot', 'springboot', 'spring-boot'],
  Spring: ['spring framework', 'spring mvc'],
  Hibernate: ['hibernate', 'jpa'],
  Flutter: ['flutter'],
  Dart: ['dart'],
  Kotlin: ['kotlin'],
  Swift: ['swift', 'swiftui'],
  Android: ['android'],
  iOS: ['ios'],
  Python: ['python'],
  Django: ['django'],
  Flask: ['flask'],
  FastAPI: ['fastapi'],
  Go: ['golang', 'go lang'],
  Rust: ['rust'],
  'C++': ['c++', 'cpp'],
  'C#': ['c#', 'csharp'],
  '.NET': ['.net', 'dotnet', 'asp.net'],
  PHP: ['php', 'laravel'],
  Ruby: ['ruby', 'ruby on rails', 'rails'],
  SQL: ['sql'],
  PostgreSQL: ['postgresql', 'postgres', 'psql'],
  MySQL: ['mysql'],
  MongoDB: ['mongodb', 'mongo'],
  Redis: ['redis'],
  SQLite: ['sqlite'],
  Firebase: ['firebase', 'firestore'],
  DynamoDB: ['dynamodb'],
  AWS: ['aws', 'amazon web services', 'ec2', 'lambda', 's3'],
  Azure: ['azure'],
  GCP: ['gcp', 'google cloud'],
  Docker: ['docker'],
  Kubernetes: ['kubernetes', 'k8s'],
  Terraform: ['terraform'],
  Jenkins: ['jenkins'],
  'CI/CD': ['ci/cd', 'cicd', 'continuous integration'],
  GraphQL: ['graphql'],
  'REST API': ['rest api', 'restful', 'rest apis'],
  Microservices: ['microservices', 'microservice'],
  Kafka: ['kafka'],
  Spark: ['spark', 'pyspark'],
  'Machine Learning': ['machine learning', 'ml'],
  TensorFlow: ['tensorflow'],
  PyTorch: ['pytorch'],
  NLP: ['nlp', 'natural language processing'],
  Pandas: ['pandas'],
  NumPy: ['numpy'],
  'Power BI': ['power bi', 'powerbi'],
  Tableau: ['tableau'],
  Excel: ['advanced excel', 'ms excel'],
  Git: ['git', 'github', 'gitlab'],
  Linux: ['linux', 'unix'],
  Jira: ['jira'],
  Selenium: ['selenium'],
};

/**
 * Job titles a resume can claim, mapped to the phrasing boards advertise them
 * under. Only the *primary* families are listed: the point is to seed queries,
 * not to build an ontology.
 *
 * @type {Array<[string, RegExp]>}
 */
const TITLE_PATTERNS = [
  ['Full Stack Developer', /\bfull[\s-]?stack\b/i],
  ['Backend Developer', /\bback[\s-]?end\b/i],
  ['Frontend Developer', /\bfront[\s-]?end\b/i],
  ['Software Engineer', /\bsoftware\s+(engineer|developer|development\s+engineer)\b|\b(sde|swe)\b/i],
  ['Web Developer', /\bweb\s+(developer|development)\b/i],
  ['Mobile Developer', /\b(mobile|flutter|android|ios)\s+(app\s+)?(developer|engineer)\b/i],
  ['Data Analyst', /\bdata\s+analyst\b|\bbusiness\s+analyst\b/i],
  ['Data Scientist', /\bdata\s+scien(ce|tist)\b/i],
  ['Machine Learning Engineer', /\b(machine\s+learning|ml)\s+(engineer|intern)\b/i],
  ['Data Engineer', /\bdata\s+engineer\b/i],
  ['DevOps Engineer', /\b(devops|site\s+reliability|sre)\b/i],
  ['Cloud Engineer', /\bcloud\s+(engineer|architect|practitioner)\b/i],
  ['QA Engineer', /\b(qa|quality\s+assurance|test)\s+(engineer|analyst)\b/i],
];

/**
 * How many mentions of a skill are needed before it is treated as central
 * enough to search on. One passing mention in a course list is not a stack.
 */
const SKILL_MENTION_FLOOR = 1;

/**
 * Matches an alias as a whole token, tolerating the punctuation that real
 * technology names carry: `\b` cannot see the boundary in "C++" or "C#", and
 * would happily match the "react" inside "reactive".
 *
 * @param {string} alias
 * @returns {RegExp}
 */
function aliasPattern(alias) {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9+#.])${escaped}(?![a-z0-9+#])`, 'gi');
}

/** Compiled once - these patterns are rebuilt on every resume otherwise. */
const SKILL_PATTERNS = Object.entries(SKILL_ALIASES).map(([skill, aliases]) => ({
  skill,
  patterns: aliases.map(aliasPattern),
}));

/**
 * Reads the search vocabulary out of a user's resumes.
 *
 * This is the input to the whole crawl: the skills become quoted terms in the
 * ATS dorks and the keyword filter for the job feeds, and the titles become the
 * role half of every generated query. Because it is derived per user, two
 * people with different stacks cause two different sets of companies to be
 * visited - which is the entire reason the static company list went away.
 *
 * Skills are ranked by how often the resumes mention them, so a stack the
 * candidate actually works in outranks a tool named once in a course list.
 *
 * @param {Array<{content?:string, filename?:string}>|string} resumes resume rows
 *   (or raw text, which is what the unit tests pass)
 * @param {{limit?:number, titleLimit?:number}} [options]
 * @returns {{skills:Array<string>, titles:Array<string>, terms:Array<string>, mentions:Record<string, number>}}
 */
function extractUserSkills(resumes, options = {}) {
  const limit = Math.max(1, options.limit || Number(process.env.MAX_SEARCH_SKILLS || 12));
  const titleLimit = Math.max(1, options.titleLimit || 4);

  const text = (Array.isArray(resumes) ? resumes.map((resume) => String(resume?.content || '')).join('\n') : String(resumes || ''))
    // Resume PDFs routinely glue a bullet to the next line; the token patterns
    // below need the whitespace back.
    .replace(/[•|,/]/g, ' ');

  if (!text.trim()) return { skills: [], titles: [], terms: [], mentions: {} };

  const mentions = {};
  for (const { skill, patterns } of SKILL_PATTERNS) {
    let count = 0;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      count += (text.match(pattern) || []).length;
    }
    if (count >= SKILL_MENTION_FLOOR) mentions[skill] = count;
  }

  const skills = Object.entries(mentions)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([skill]) => skill);

  const titles = TITLE_PATTERNS.filter(([, pattern]) => pattern.test(text))
    .map(([title]) => title)
    .slice(0, titleLimit);

  // Terms are what a feed listing is filtered against, so both halves count.
  const terms = [...new Set([...skills, ...titles])];

  return { skills, titles, terms, mentions };
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
  // search vocabulary
  extractUserSkills,
  SKILL_ALIASES,
  TITLE_PATTERNS,
};
