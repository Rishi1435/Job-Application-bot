/**
 * Unit tests for the relevance gate and apply-link canonicalisation.
 *
 * These cover the two things that made the board unusable: postings from the
 * wrong field or several levels above the candidate being scored as good
 * matches, and "Apply" links that did not open the posting.
 *
 * Run with `npm test` (node:test, no extra dependencies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCandidateProfile,
  assessRelevance,
  assessLocation,
  detectPostingLevel,
  detectRoleFamily,
} = require('../services/relevance');
const { parseMatchData, gatedMatch } = require('../services/matcher');
const { normalizeApplyUrl } = require('../services/scraper');

/** An entry-level backend/mobile resume - the case the gate was built for. */
const JUNIOR_RESUME = [
  {
    filename: 'junior.pdf',
    content: `Software Developer with 10+ months of internship experience building mobile
      applications (Flutter), full-stack systems (Node.js, Spring Boot) and cloud-native
      architectures on AWS. Skills: Java, JavaScript, Dart, SQL, MongoDB, Docker, Kubernetes.
      Shipped UI modules and REST API integrations. Collaborated on cross-functional
      communication within an Agile team. Seeking an entry-level software engineering role.
      Phone: +91 9290015858`,
  },
];

/* ------------------------------------------------------------------ */
/* Candidate profile                                                   */
/* ------------------------------------------------------------------ */

test('buildCandidateProfile reads seniority from the resume, not its keywords', () => {
  const profile = buildCandidateProfile(JUNIOR_RESUME);

  assert.equal(profile.levelLabel, 'Entry level');
  assert.ok(profile.years < 1, `${profile.years} years should be under one`);
  assert.equal(profile.location, 'India');
  assert.ok(profile.skills.includes('flutter') && profile.skills.includes('spring boot'));

  // The regression this guards: matching a resume against *title* patterns read
  // "shipped UI modules" as design work and "communication" as marketing, and
  // each phantom family opened the gate to a whole category of wrong postings.
  assert.deepEqual(profile.families, ['engineering'], 'prose must not invent extra families');
});

/**
 * A non-engineering resume that shares tooling with the one above: both name
 * Python and SQL. This is the pair that exposed the bug where two people in
 * genuinely different fields were shown the same jobs.
 */
const ANALYST_RESUME = [
  {
    filename: 'analyst.pdf',
    content: `TEJASWINI PEDIREDLA. Kakinada, Andhra Pradesh. +91-8555046369
      EDUCATION: MBA - Business Analytics, JNTU Kakinada, 2024-2026. B.Sc Mathematics,
      Economics and Computer Science.
      EXPERIENCE: Project Intern at APSSDC, Role - Data Analyst Intern. Applied machine
      learning techniques like trend analysis modeling for data insights. Automated
      processes by developing data pipelines.
      PROJECTS: Weather Forecasting using Python - Data Science, Time Series. Implemented
      predictive models using pandas, numpy and scikit-learn.
      TECHNICAL SKILLS: Python, C, SQL, MS Office, DBMS, Tally ERP9, PowerBI, Tableau.
      Data Analysis, Machine Learning, Marketing, Finance, HR Analytics.`,
  },
];

test('two resumes in different fields produce different profiles', () => {
  const engineer = buildCandidateProfile(JUNIOR_RESUME);
  const analyst = buildCandidateProfile(ANALYST_RESUME);

  assert.deepEqual(engineer.families, ['engineering']);

  // The analyst names Python and SQL, which an earlier rule ("3+ recognised
  // skills means engineering") read as proof of software engineering - so an
  // MBA in Business Analytics was screened against a backend engineer's board.
  assert.ok(analyst.families.includes('data'), `expected data, got ${analyst.families}`);
  assert.ok(!analyst.families.includes('engineering'), 'shared tooling is not a shared career');

  assert.notDeepEqual(engineer.families, analyst.families);
});

test('a field is never assumed when the resume does not state one', () => {
  const vague = buildCandidateProfile([{ filename: 'vague.pdf', content: 'Hard working graduate. References available.' }]);

  // The old fallback was `families.add('engineering')`, which screened every
  // unrecognised resume - including non-technical ones - as an engineer's.
  assert.deepEqual(vague.families, [], 'unknown must stay unknown');

  // And an unknown field disables the field gate rather than rejecting
  // everything, so the board is still usable.
  const verdict = assessRelevance(
    { title: 'Marketing Executive', description: 'Own campaigns.', location: 'Mumbai, India' },
    vague
  );
  assert.notEqual(verdict.fit, 'mismatch');
  assert.equal(verdict.worthScoring, true);
});

test('each candidate is screened into their own field', () => {
  const engineer = buildCandidateProfile(JUNIOR_RESUME);
  const analyst = buildCandidateProfile(ANALYST_RESUME);

  const backendRole = { title: 'Backend Software Engineer', description: 'Node.js services.', location: 'Bengaluru, India' };
  const analystRole = { title: 'Business Analyst, Growth', description: 'SQL and dashboards.', location: 'Bengaluru, India' };

  // The engineer gets the backend role; the analyst does not.
  assert.notEqual(assessRelevance(backendRole, engineer).fit, 'mismatch');
  assert.equal(assessRelevance(backendRole, analyst).fit, 'mismatch');

  // The analyst gets the analytics role.
  assert.notEqual(assessRelevance(analystRole, analyst).fit, 'mismatch');
});

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

test('detectPostingLevel ranks titles and honours a stated years requirement', () => {
  const level = (title, description = '') => detectPostingLevel(title, description).label;

  assert.equal(level('Software Engineering Intern, Summer 2026'), 'Intern');
  assert.equal(level('Junior Backend Developer'), 'Entry level');
  assert.equal(level('Software Engineer, Distributed Systems'), 'Mid level');
  assert.equal(level('Senior Software Engineer'), 'Senior');
  assert.equal(level('Staff Software Engineer, Data Platform'), 'Staff');
  assert.equal(level('Engineering Manager, Inference'), 'Staff');
  assert.equal(level('Director, Business Systems'), 'Director');
  assert.equal(level('Head of Platform'), 'Executive');

  // A plain title with a demanding body is not a mid-level role.
  assert.equal(level('Software Engineer', 'You have 8+ years of experience shipping backends.'), 'Staff');
  // ...but the body can never demote a senior title.
  assert.equal(level('Director, IT', 'Requires 3+ years of experience managing teams.'), 'Director');
});

test('detectRoleFamily separates engineering from the jobs that merely sound like it', () => {
  const family = (title) => detectRoleFamily(title).id;

  assert.equal(family('Backend Software Engineer'), 'engineering');
  // "Engineering Manager" only classifies correctly because the pattern matches
  // `engineer(ing)?`; a bare `\bengineer\b` silently missed every EM posting.
  assert.equal(family('Engineering Manager, Social Commerce'), 'engineering');
  assert.equal(family('Site Reliability Engineer (Kubernetes)'), 'engineering');

  assert.equal(family('Client Partner - Emerging & Scaled (UK)'), 'sales');
  assert.equal(family('US Agency Development Lead'), 'sales');
  assert.equal(family('Senior Growth Manager, UK'), 'marketing');
  assert.equal(family('Manager, IT Operations'), 'support');
  assert.equal(family('Data Operations Manager, Human Data'), 'operations');
  assert.equal(family('Filmmaker, Customer Stories'), 'media');
  assert.equal(family('Data Scientist, Analytics'), 'data');
});

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

test('assessRelevance rejects the wrong field outright and caps over-senior roles', () => {
  const profile = buildCandidateProfile(JUNIOR_RESUME);
  const verdict = (title, description = '') => assessRelevance({ title, description }, profile);

  const intern = verdict('Software Engineering Intern (Backend) - Summer 2026');
  assert.equal(intern.fit, 'match');
  assert.equal(intern.cap, null, 'a real match is never capped');
  assert.equal(intern.worthScoring, true);

  const stretch = verdict('Software Engineer, Distributed Systems');
  assert.equal(stretch.fit, 'stretch');
  assert.equal(stretch.cap, 75);
  assert.equal(stretch.worthScoring, true, 'a stretch still deserves a real score');

  // Two rungs up: knowable from the title, so it never reaches the model.
  const senior = verdict('Staff Software Engineer, Data Platform');
  assert.equal(senior.fit, 'overreach');
  assert.equal(senior.cap, 25);
  assert.equal(senior.worthScoring, false);

  // A different line of work is a harder no than a seniority gap.
  const sales = verdict('Client Partner - Emerging & Scaled (UK)');
  assert.equal(sales.fit, 'mismatch');
  assert.equal(sales.cap, 15);
  assert.equal(sales.worthScoring, false);
});

test('an unclassifiable title is a rejection, not the benefit of the doubt', () => {
  const profile = buildCandidateProfile(JUNIOR_RESUME);

  // Reaching the `other` family means no signal from *any* family matched the
  // title or the body. Treating that as "adjacent" is what put roles like
  // "Cluster Head Middle Mile" on an engineer's board.
  const verdict = assessRelevance(
    { title: 'Cluster Head Middle Mile - Bhubaneswar', description: 'Own the hub network.', location: 'Odisha, India' },
    profile
  );

  assert.equal(verdict.family, 'other');
  assert.equal(verdict.fit, 'mismatch');
  assert.equal(verdict.worthScoring, false);
});

test('gatedMatch answers a rejected posting without calling the model', () => {
  const profile = buildCandidateProfile(JUNIOR_RESUME);
  const job = {
    title: 'Director of Engineering, Platform',
    description: 'Lead the platform org. 12+ years of experience required.',
    location: 'Bengaluru, India',
  };

  const relevance = assessRelevance(job, profile);
  assert.equal(relevance.fit, 'overreach', 'a director role is several rungs up');

  const verdict = gatedMatch(job, [{ id: 7, filename: 'junior.pdf' }], relevance);
  assert.equal(verdict.engine, 'gate', 'no LLM call was made');
  assert.equal(verdict.score, relevance.cap);
  assert.equal(verdict.best_resume_id, 7);
  assert.match(verdict.reason, /too senior/i);
});

test('parseMatchData enforces the cap the prompt cannot', () => {
  const resumes = [{ id: 3, filename: 'junior.pdf' }];
  const raw = { job_type: 'Full-Time Job', best_resume_id: 3, score: 88, reason: 'Strong Java overlap.' };
  const relevance = { fit: 'overreach', cap: 25, note: 'Too senior - a staff opening.' };

  const capped = parseMatchData(raw, resumes, { title: 'Staff Engineer' }, relevance);
  assert.equal(capped.score, 25, 'a generous model score is clamped to the cap');
  assert.match(capped.reason, /^Too senior/, 'the reason explains the clamp');

  // Without a gate verdict the model's score stands.
  const free = parseMatchData(raw, resumes, { title: 'Staff Engineer' }, null);
  assert.equal(free.score, 88);
});

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

test('assessLocation keeps India and remote roles, rejects other countries', () => {
  const check = (text) => assessLocation(text, 'India');

  // The exact strings the supported boards emit.
  assert.equal(check('Bengaluru-VTP, India').eligible, true);
  assert.equal(check('bengaluru').eligible, true);
  assert.equal(check('Hyderabad').eligible, true);
  assert.equal(check('Remote').eligible, true, 'remote is open to India');
  assert.equal(check('Remote - India').eligible, true);
  assert.equal(check('Remote Globally').eligible, true);

  // "Remote" attached to a named foreign office is a foreign role that allows
  // working from home - not a role open to India.
  assert.equal(check('Engineering • New York, NY (HQ); Remote').eligible, false);
  assert.equal(check('London, UK; Ontario, CAN; Remote').eligible, false);
  assert.equal(check('Engineering • Remote (Buenos Aires)').eligible, false);

  assert.equal(check('San Francisco, California, United States').eligible, false);
  assert.equal(check('London, UK').eligible, false);
  assert.equal(check('Singapore').eligible, false);

  // The rule is an allow-list, so places no block-list would have thought to
  // include are still rejected - all three slipped through the earlier version.
  assert.equal(check('Pompano Beach, FL').eligible, false);
  assert.equal(check('Basking Ridge, New Jersey').eligible, false);
  assert.equal(check('Istanbul').eligible, false);

  // A multi-office posting is eligible if any office is one they can work from.
  assert.equal(check('India; Ireland; United Kingdom').eligible, true);

  // The one concession: a posting is not disqualified by the scraper failing to
  // read its location.
  assert.equal(check('').eligible, true);

  // The gate only reasons about India; anyone else is left alone.
  assert.equal(assessLocation('London, UK', null).eligible, true);
  assert.equal(assessLocation('London, UK', 'United Kingdom').eligible, true);
});

test('assessRelevance rejects a perfect role in the wrong country', () => {
  const profile = buildCandidateProfile(JUNIOR_RESUME);
  assert.equal(profile.location, 'India');

  const job = { title: 'Software Engineer, Backend', description: 'Node.js and AWS.' };

  const bengaluru = assessRelevance({ ...job, location: 'Bengaluru, India' }, profile);
  assert.notEqual(bengaluru.fit, 'elsewhere');
  assert.equal(bengaluru.locationEligible, true);

  // Same title, same stack, different country - and country is checked first.
  const sanFrancisco = assessRelevance({ ...job, location: 'San Francisco, CA' }, profile);
  assert.equal(sanFrancisco.fit, 'elsewhere');
  assert.equal(sanFrancisco.worthScoring, false, 'no LLM call for a job they cannot take');
  assert.match(sanFrancisco.note, /not India/i);
});

/* ------------------------------------------------------------------ */
/* Apply-link canonicalisation                                         */
/* ------------------------------------------------------------------ */

test('normalizeApplyUrl canonicalises redirecting hosts and strips tracking', () => {
  // boards.greenhouse.io answers every posting URL with a 301, and the query
  // string does not always survive the hop - which is how "Apply" landed on a
  // board index instead of the job.
  assert.equal(
    normalizeApplyUrl('https://boards.greenhouse.io/figma/jobs/6104563004?gh_jid=6104563004'),
    'https://job-boards.greenhouse.io/figma/jobs/6104563004'
  );

  assert.equal(
    normalizeApplyUrl('https://jobs.lever.co/spotify/abc-123?utm_source=x&gh_src=y#top'),
    'https://jobs.lever.co/spotify/abc-123'
  );

  // Anything that is not http(s) must never reach an anchor's href.
  assert.equal(normalizeApplyUrl('javascript:alert(1)'), null);
  assert.equal(normalizeApplyUrl('not a url'), null);
  assert.equal(normalizeApplyUrl(''), null);
});
