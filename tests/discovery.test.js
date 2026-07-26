/**
 * Unit tests for the dynamic discovery pipeline: resume -> skills -> queries ->
 * dorks -> boards -> filtered postings. Everything tested here is pure, so the
 * whole crawl can be reasoned about without a network or a database.
 *
 * Run with `npm test` (node:test, no extra dependencies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractUserSkills } = require('../services/parser');
const { buildSearchQueries, verifyMatchShape, meetsMatchBar } = require('../services/matcher');
const { buildDorks, parseBoardUrl, isTrustedJobUrl, getTrustedDomains } = require('../config/sources');
const { termMatcher, filterJobs, extractBoardsFromResults, htmlToText, looksThrottled } = require('../services/scraper');

const BACKEND_RESUME = `
  Rishi Pediredla - Full Stack Developer
  Skills: Node.js, Express, Spring Boot, Java, Flutter, Dart, PostgreSQL, Docker, AWS
  Experience: Built REST APIs in Node.js and Spring Boot; shipped a Flutter app.
  Node.js again, because PDFs repeat the skills section in the summary.
`;

const ANALYST_RESUME = `
  Tejaswini Pediredla - Data Analyst
  Skills: Python, SQL, Pandas, Power BI, Tableau, Machine Learning
  Built dashboards in Power BI and forecasting models in Python.
`;

/* ------------------------------------------------------------------ */
/* extractUserSkills                                                   */
/* ------------------------------------------------------------------ */

test('extractUserSkills reads the stack and the job titles off a resume', () => {
  const { skills, titles, terms } = extractUserSkills([{ content: BACKEND_RESUME }]);

  for (const expected of ['Node.js', 'Spring Boot', 'Flutter', 'PostgreSQL', 'AWS']) {
    assert.ok(skills.includes(expected), `${expected} should be extracted, got ${skills.join(', ')}`);
  }
  assert.ok(titles.includes('Full Stack Developer'));
  assert.ok(terms.includes('Flutter') && terms.includes('Full Stack Developer'));
});

test('extractUserSkills ranks the skills a resume leans on first', () => {
  const { skills } = extractUserSkills([{ content: BACKEND_RESUME }]);
  // Node.js is named three times, Docker once.
  assert.ok(skills.indexOf('Node.js') < skills.indexOf('Docker'), skills.join(', '));
});

test('extractUserSkills does not mistake a substring for a skill', () => {
  const { skills } = extractUserSkills('We built a reactive, go-to-market dashboard in JavaScript.');
  assert.ok(!skills.includes('React'), '"reactive" is not React');
  assert.ok(!skills.includes('Go'), '"go-to-market" is not Go');
  assert.ok(!skills.includes('Java'), '"JavaScript" is not Java');
  assert.ok(skills.includes('JavaScript'));
});

test('extractUserSkills gives two different candidates two different vocabularies', () => {
  const backend = extractUserSkills([{ content: BACKEND_RESUME }]);
  const analyst = extractUserSkills([{ content: ANALYST_RESUME }]);

  assert.ok(analyst.skills.includes('Power BI') && !backend.skills.includes('Power BI'));
  assert.ok(backend.skills.includes('Spring Boot') && !analyst.skills.includes('Spring Boot'));
  assert.deepEqual(extractUserSkills([]), { skills: [], titles: [], terms: [], mentions: {} });
});

/* ------------------------------------------------------------------ */
/* buildSearchQueries / buildDorks                                     */
/* ------------------------------------------------------------------ */

test('buildSearchQueries pairs the candidate skills with role terms', () => {
  const queries = buildSearchQueries([{ content: BACKEND_RESUME }]);

  assert.ok(queries.length > 5, `expected several queries, got ${queries.length}`);
  assert.ok(queries.some((query) => /Node\.js/.test(query) && /Developer|Engineer/.test(query)), queries.join(' | '));
  assert.ok(queries.some((query) => /Intern|Associate|Graduate/.test(query)), 'entry rungs are searched for too');
  assert.equal(new Set(queries).size, queries.length, 'queries are distinct');
});

test('buildSearchQueries still returns role terms when no skill was readable', () => {
  const queries = buildSearchQueries({ skills: [], titles: [] });
  assert.ok(queries.includes('Software Engineer'));
});

test('buildDorks quotes skills, groups them with OR and aims at every ATS', () => {
  const dorks = buildDorks({ skills: ['Node.js', 'Flutter', 'Spring Boot'], roles: ['Software Engineer'], limit: 8 });

  assert.ok(dorks.length > 0 && dorks.length <= 8);
  assert.ok(dorks.every((dork) => dork.startsWith('site:')), dorks.join(' | '));
  assert.ok(dorks.some((dork) => dork.includes('"Node.js" OR "Flutter" OR "Spring Boot"')), dorks.join(' | '));

  const sites = new Set(dorks.map((dork) => dork.split(' ')[0]));
  assert.ok(sites.size >= 3, `dorks should span several ATS hosts, got ${[...sites].join(', ')}`);
});

/* ------------------------------------------------------------------ */
/* Trusted domains & board parsing                                     */
/* ------------------------------------------------------------------ */

test('isTrustedJobUrl accepts ATS subdomains and rejects everything else', () => {
  assert.ok(isTrustedJobUrl('https://job-boards.greenhouse.io/acme/jobs/123'));
  assert.ok(isTrustedJobUrl('https://jobs.lever.co/acme/uuid'));
  assert.ok(isTrustedJobUrl('https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/x'));
  assert.ok(!isTrustedJobUrl('https://jobs-aggregator.example.com/greenhouse.io/acme'));
  assert.ok(!isTrustedJobUrl('javascript:alert(1)'));
  assert.ok(getTrustedDomains().includes('greenhouse.io'));
});

test('parseBoardUrl turns any ATS link into the board behind it', () => {
  assert.deepEqual(parseBoardUrl('https://job-boards.greenhouse.io/clickhouse/jobs/6107276004'), {
    platform: 'greenhouse',
    slug: 'clickhouse',
    boardUrl: 'https://job-boards.greenhouse.io/clickhouse',
    company: 'Clickhouse',
  });

  assert.equal(parseBoardUrl('https://jobs.lever.co/kpler/c84729bc-bd8b')?.slug, 'kpler');
  assert.equal(parseBoardUrl('https://jobs.ashbyhq.com/ramp/some-uuid')?.platform, 'ashby');
  assert.equal(
    parseBoardUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x')?.slug,
    'nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'
  );

  assert.equal(parseBoardUrl('https://www.linkedin.com/jobs/view/123'), null, 'not an ATS');
  assert.equal(parseBoardUrl('https://job-boards.greenhouse.io/embed/job_app?token=1'), null, 'reserved path');
});

test('extractBoardsFromResults reads boards out of a DuckDuckGo results page', () => {
  const html = `
    <div>
      <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fjob-boards.greenhouse.io%2Fvaltech%2Fjobs%2F44&rut=x">Valtech</a>
      <a href="https://jobs.lever.co/gohighlevel/1234">GoHighLevel</a>
      <a href="https://example.com/careers">Not an ATS</a>
      <span>https://jobs.ashbyhq.com/openai/abc-def</span>
    </div>`;

  const boards = extractBoardsFromResults(html);
  const ids = boards.map((board) => `${board.platform}:${board.slug}`).sort();

  assert.deepEqual(ids, ['ashby:openai', 'greenhouse:valtech', 'lever:gohighlevel']);
});

test('looksThrottled tells a refusal apart from an empty result page', () => {
  // DuckDuckGo's throttle screen: HTTP 202, short, and full of anomaly markup.
  assert.equal(looksThrottled('<html><body><div class="anomaly-modal">Please try again</div></body></html>'), true);
  assert.equal(looksThrottled('<html><body>No results found for your query.</body></html>'), false);
  // A genuine results page is far larger than any interstitial.
  assert.equal(looksThrottled(`<html>${'<div class="result">job</div>'.repeat(2000)}anomaly</html>`), false);
  assert.equal(looksThrottled(''), false);
});

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

test('termMatcher reports which of the candidate skills a posting hits', () => {
  const matches = termMatcher(['Node.js', 'Flutter', 'Go']);

  assert.deepEqual(matches({ title: 'Backend Engineer', description: 'Node.js and Postgres' }), ['Node.js']);
  assert.deepEqual(matches({ title: 'Flutter Developer', description: '' }), ['Flutter']);
  assert.deepEqual(matches({ title: 'Growth Manager at Google', description: 'go-getter' }), [], 'no substring hits');
});

test('filterJobs drops untrusted domains, off-stack roles and anything already stored', () => {
  const jobs = [
    { title: 'Node.js Engineer', applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/1', description: 'Node.js' },
    { title: 'Node.js Engineer', applyUrl: 'https://scraped-jobs.example.com/1', description: 'Node.js' },
    { title: 'Chief Marketing Officer', applyUrl: 'https://jobs.lever.co/acme/2', description: 'Brand strategy' },
    { title: 'Flutter Developer', applyUrl: 'https://jobs.lever.co/acme/3', description: 'Flutter' },
    { title: 'Flutter Developer', applyUrl: 'https://jobs.lever.co/acme/3', description: 'Flutter' },
  ];

  const { kept, skipped } = filterJobs(jobs, {
    matches: termMatcher(['Node.js', 'Flutter']),
    knownUrls: new Set(['https://job-boards.greenhouse.io/acme/jobs/1']),
    seen: new Set(),
  });

  assert.deepEqual(kept.map((job) => job.title), ['Flutter Developer']);
  assert.deepEqual(kept[0].matchedSkills, ['Flutter']);
  assert.equal(skipped.untrusted, 1);
  assert.equal(skipped.offStack, 1);
  assert.equal(skipped.duplicate, 2, 'one already in the database, one repeated in the batch');
});

test('filterJobs caps how much of one employer a run takes', () => {
  const jobs = Array.from({ length: 9 }, (_, i) => ({
    title: `Node.js Engineer ${i}`,
    company: i < 7 ? 'Bigcorp' : 'Smallcorp',
    applyUrl: `https://jobs.lever.co/acme/${i}`,
    description: 'Node.js',
  }));

  const perCompany = new Map();
  const { kept, skipped } = filterJobs(jobs, {
    matches: termMatcher(['Node.js']),
    knownUrls: new Set(),
    seen: new Set(),
    perCompany,
  });

  const fromBigcorp = kept.filter((job) => job.company === 'Bigcorp');
  assert.ok(fromBigcorp.length <= 5, `one employer took ${fromBigcorp.length} slots`);
  assert.equal(skipped.crowded, 7 - fromBigcorp.length);
  assert.equal(kept.filter((job) => job.company === 'Smallcorp').length, 2, 'the cap is per employer, not per batch');

  // The tally is the run's, so a second board cannot restart the same employer.
  const second = filterJobs(
    [{ title: 'Node.js Lead', company: 'Bigcorp', applyUrl: 'https://jobs.lever.co/acme/99', description: 'Node.js' }],
    { matches: termMatcher(['Node.js']), knownUrls: new Set(), seen: new Set(), perCompany }
  );
  assert.equal(second.kept.length, 0);
  assert.equal(second.skipped.crowded, 1);
});

test('htmlToText unwraps the escaped markup Greenhouse ships', () => {
  assert.equal(htmlToText('&lt;p&gt;We use &lt;b&gt;Node.js&lt;/b&gt;&lt;/p&gt;'), 'We use Node.js');
  assert.equal(htmlToText('<div><p>Plain  HTML</p></div>'), 'Plain HTML');
  assert.equal(htmlToText(''), '');
});

/* ------------------------------------------------------------------ */
/* The storage bar                                                     */
/* ------------------------------------------------------------------ */

test('verifyMatchShape insists on the fields the dashboard reads', () => {
  const complete = { job_type: 'Internship', best_resume_id: 4, score: 72, reason: 'Flutter overlap' };
  assert.deepEqual(verifyMatchShape(complete), { ok: true, missing: [] });

  assert.deepEqual(verifyMatchShape({ ...complete, job_type: 'Contract' }).missing, ['job_type']);
  assert.deepEqual(verifyMatchShape({ ...complete, score: 'high' }).missing, ['score']);
  assert.deepEqual(verifyMatchShape({ ...complete, reason: '  ' }).missing, ['reason']);
  assert.deepEqual(verifyMatchShape({ job_type: 'Full-Time Job', score: 10, reason: 'x' }).missing, ['best_resume_id']);
  assert.equal(verifyMatchShape(null).ok, false);

  // A user with no resumes gets a null id, and that row is still storable.
  assert.equal(verifyMatchShape({ ...complete, best_resume_id: null }).ok, true);
});

test('meetsMatchBar keeps 50 and above', () => {
  assert.equal(meetsMatchBar({ score: 50 }), true);
  assert.equal(meetsMatchBar({ score: 49 }), false);
  assert.equal(meetsMatchBar({ score: 0 }), false);
  assert.equal(meetsMatchBar({}), false);
  assert.equal(meetsMatchBar({ score: 30 }, 25), true, 'the bar is overridable');
});
