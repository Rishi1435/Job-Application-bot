/**
 * Unit tests for the pure helpers in the scraper and matcher.
 * Run with `npm test` (node:test, no extra dependencies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseHtml, normalizeDate, absoluteUrl, clean, repairMojibake } = require('../services/parser');
const { parseVerdict, keywordScore } = require('../services/matcher');

const SAMPLE_SOURCE = {
  id: 'test',
  baseUrl: 'https://board.example.com',
  selectors: {
    card: '.job-listing',
    title: '.job-title',
    company: '.company-name',
    description: '.job-description',
    date: '.date-posted',
    link: '.apply-btn',
  },
};

test('parseHtml extracts postings and resolves relative apply URLs', () => {
  const html = `
    <div class="job-listing">
      <h2 class="job-title">  Full   Stack Developer </h2>
      <div class="company-name">Acme</div>
      <div class="date-posted">2026-07-22</div>
      <div class="job-description">Node.js and Flutter</div>
      <a class="apply-btn" href="/apply/1">Apply</a>
    </div>
    <div class="job-listing">
      <h2 class="job-title">No link here</h2>
    </div>`;

  const jobs = parseHtml(html, SAMPLE_SOURCE);

  assert.equal(jobs.length, 1, 'postings without an apply URL are dropped');
  assert.equal(jobs[0].title, 'Full Stack Developer', 'whitespace is collapsed');
  assert.equal(jobs[0].applyUrl, 'https://board.example.com/apply/1');
});

test('normalizeDate understands ISO, relative and epoch inputs', () => {
  assert.equal(normalizeDate('2026-07-22'), '2026-07-22');
  assert.equal(normalizeDate(1753142400), '2025-07-22');
  assert.equal(normalizeDate(''), null);
  assert.equal(normalizeDate('sometime soon'), 'sometime soon', 'unparseable text is preserved');

  const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  assert.equal(normalizeDate('3 days ago'), threeDaysAgo);
});

test('absoluteUrl rejects unusable hrefs', () => {
  assert.equal(absoluteUrl('javascript:alert(1)', 'https://x.com'), null);
  assert.equal(absoluteUrl('#', 'https://x.com'), null);
  assert.equal(absoluteUrl('https://y.com/job', 'https://x.com'), 'https://y.com/job');
});

test('clean repairs upstream mojibake and decodes entities', () => {
  // RemoteOK ships some rows already double-encoded.
  assert.equal(repairMojibake('CoordenaÃ§Ã£o de Tecnologia'), 'Coordenação de Tecnologia');
  assert.equal(repairMojibake('Plain ASCII title'), 'Plain ASCII title', 'clean text is left alone');
  assert.equal(clean('NHS Ayrshire &amp; Arran'), 'NHS Ayrshire & Arran');
  assert.equal(clean('  spaced   out \n text '), 'spaced out text');
});

test('parseVerdict tolerates fenced and prose-wrapped JSON', () => {
  assert.deepEqual(parseVerdict('{"score": 88, "reason": "Node.js overlap"}'), {
    score: 88,
    reason: 'Node.js overlap',
  });

  assert.equal(parseVerdict('```json\n{"score": 42, "reason": "Partial"}\n```').score, 42);
  assert.equal(parseVerdict('Here you go: {"score": 7, "reason": "No overlap"} hope that helps').score, 7);
  assert.equal(parseVerdict('not json at all'), null);
});

test('parseVerdict clamps out-of-range scores', () => {
  assert.equal(parseVerdict('{"score": 250, "reason": "x"}').score, 100);
  assert.equal(parseVerdict('{"score": -30, "reason": "x"}').score, 0);
  assert.equal(parseVerdict('{"score": "73", "reason": "x"}').score, 73);
});

test('keywordScore ranks a matching stack above an unrelated one', () => {
  const strong = keywordScore('Node.js, Express and Flutter developer building REST APIs');
  const weak = keywordScore('Kubernetes, Terraform and Go site reliability engineer');

  assert.ok(strong.score > weak.score, `${strong.score} should beat ${weak.score}`);
  assert.equal(keywordScore('').score, 0);
});

/* ------------------------------------------------------------------ */
/* Database TLS negotiation                                            */
/* ------------------------------------------------------------------ */

/**
 * Reloads the database module under a given connection string and reports
 * whether the pool would ask for TLS. The module reads the environment once at
 * load, so the cache entry has to go with it.
 *
 * @param {string} url
 * @param {string} [explicit] value for DATABASE_SSL
 * @returns {boolean}
 */
function wouldUseTls(url, explicit) {
  const path = require.resolve('../services/database');
  const previous = { url: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL };

  delete require.cache[path];
  process.env.DATABASE_URL = url;
  if (explicit === undefined) delete process.env.DATABASE_SSL;
  else process.env.DATABASE_SSL = explicit;

  const { pool } = require(path);
  const answer = Boolean(pool.options.ssl);

  delete require.cache[path];
  if (previous.url === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.url;
  if (previous.ssl === undefined) delete process.env.DATABASE_SSL;
  else process.env.DATABASE_SSL = previous.ssl;

  return answer;
}

test('TLS is requested for public database hosts and skipped for private ones', () => {
  // Render's internal connection string is a single-label host, which cannot be
  // a public DNS name - and its Postgres does not offer TLS there. Asking for it
  // does not downgrade, it fails the boot outright.
  assert.equal(wouldUseTls('postgresql://u:p@dpg-cvab12345678-a/jobbot'), false, 'Render internal');
  assert.equal(wouldUseTls('postgresql://u:p@localhost:5432/jobbot'), false, 'localhost');
  assert.equal(wouldUseTls('postgresql://u:p@172.17.0.2:5432/jobbot'), false, 'docker bridge');
  assert.equal(wouldUseTls('postgresql://u:p@10.1.2.3:5432/jobbot'), false, 'RFC 1918');

  assert.equal(
    wouldUseTls('postgresql://u:p@dpg-cvab12345678-a.singapore-postgres.render.com/jobbot'),
    true,
    'Render external'
  );

  // Explicit settings win over the guess, in both directions.
  assert.equal(wouldUseTls('postgresql://u:p@localhost:5432/jobbot', 'true'), true);
  assert.equal(wouldUseTls('postgresql://u:p@db.example.com:5432/jobbot', 'false'), false);
  assert.equal(wouldUseTls('postgresql://u:p@db.example.com:5432/jobbot?sslmode=disable'), false);
});

test('a database that is not up yet is retried, a misconfigured one is not', () => {
  const { isTransientConnectionError } = require('../services/database');

  // "Not ready yet" - the shape a container gets when it starts before its
  // database's hostname resolves.
  assert.equal(isTransientConnectionError({ code: 'ENOTFOUND' }), true);
  assert.equal(isTransientConnectionError({ code: 'EAI_AGAIN' }), true);
  assert.equal(isTransientConnectionError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isTransientConnectionError({ code: '57P03' }), true, 'starting up');
  assert.equal(isTransientConnectionError({ errors: [{ code: 'ENOTFOUND' }] }), true, 'wrapped by pg');

  // "Wrong" - waiting cannot fix any of these, so the boot should fail loudly.
  assert.equal(isTransientConnectionError({ code: '28P01' }), false, 'bad password');
  assert.equal(isTransientConnectionError({ code: '3D000' }), false, 'no such database');
  assert.equal(isTransientConnectionError({ message: 'does not support SSL connections' }), false);
});
