#!/usr/bin/env node
/**
 * Deployment verification: `npm run verify`.
 *
 * Exercises the three external dependencies the app cannot fake:
 *
 *   1. PostgreSQL - connects, applies the schema, then round-trips a throwaway
 *      tenant (user -> resume -> job with JSONB match_data) and asserts that a
 *      second tenant cannot see the first one's rows. Everything it creates is
 *      removed again, including on failure.
 *   2. Resume parsing - runs a generated PDF and a TXT buffer through the same
 *      in-memory extractor the upload endpoint uses.
 *   3. NVIDIA API - sends a mock job + mock resumes to the configured model and
 *      validates the strict JSON contract (category enum, a real resume id,
 *      a 0-100 score, a reason).
 *
 * Exit code is 0 only when every check that could run passed. Checks whose
 * configuration is missing are reported as SKIP, not failure, so the script is
 * useful before every secret has been provisioned.
 */

require('dotenv').config();

const assert = require('node:assert/strict');

const db = require('./../services/database');
const auth = require('../services/auth');
const { extractResumeText } = require('../services/parser');
const { matchJob, MODEL, BASE_URL, isLlmEnabled, JOB_TYPES } = require('../services/matcher');

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

const results = [];
const symbols = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

/**
 * Runs one named check and records its outcome.
 *
 * @param {string} name
 * @param {() => Promise<'skip'|string|void>} fn return 'skip' (or a
 *   `skip: reason` string) to mark the check as skipped
 * @returns {Promise<boolean>} false when the check failed
 */
async function check(name, fn) {
  process.stdout.write(`  ... ${name}\r`);
  try {
    const outcome = await fn();
    const skipped = typeof outcome === 'string' && outcome.startsWith('skip');
    const detail = skipped ? outcome.replace(/^skip:?\s*/, '') : outcome || '';
    results.push({ name, status: skipped ? 'skip' : 'pass', detail });
    console.log(`  ${skipped ? symbols.skip : symbols.pass}  ${name}${detail ? ` - ${detail}` : ''}`);
    return true;
  } catch (error) {
    results.push({ name, status: 'fail', detail: error.message });
    console.log(`  ${symbols.fail}  ${name}\n        ${error.message}`);
    return false;
  }
}

/** Section header. */
const section = (title) => console.log(`\n${title}\n${'-'.repeat(title.length)}`);

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Unique suffix so repeated runs never collide with each other. */
const RUN_ID = `verify_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

const MOCK_RESUMES = [
  {
    id: 101,
    filename: 'backend-resume.pdf',
    content: `RISHI - Backend Engineer
Skills: Node.js, Express, PostgreSQL, Docker, REST APIs, Redis, AWS.
Experience: Built multi-tenant SaaS backends handling 2M requests/day; designed
JSONB-heavy Postgres schemas; wrote Puppeteer scrapers for data ingestion.
Education: B.Tech Computer Science, 2024.`,
  },
  {
    id: 102,
    filename: 'mobile-resume.docx',
    content: `RISHI - Mobile Developer
Skills: Flutter, Dart, Android, Kotlin, Firebase, Material Design.
Experience: Shipped three Flutter apps to the Play Store; built offline-first
sync with SQLite; integrated Firebase auth and push notifications.
Education: B.Tech Computer Science, 2024.`,
  },
];

const MOCK_JOB = {
  title: 'Backend Engineering Intern - Summer 2026',
  company: 'Anthropic',
  description: `We are hiring a backend engineering intern for a 12-week summer programme.
You will work in Node.js and TypeScript on our API platform, writing PostgreSQL
queries, containerising services with Docker and deploying to AWS. Ideal for
students graduating in 2026 or later. Experience with REST API design and
relational schema modelling is required; mobile development is not part of this role.`,
};

/** Full-time postings used to exercise the pay bar end to end. */
const PAY_FIXTURES = [
  {
    label: 'CTC below the 15 LPA bar',
    job: {
      title: 'Backend Developer',
      company: 'Fintech Core Systems',
      description: 'Node.js and PostgreSQL backend role. CTC: 12 LPA (fixed + variable). Bengaluru, hybrid.',
    },
    expect: { meets: false, type: 'ctc' },
  },
  {
    label: 'CTC above the 15 LPA bar',
    job: {
      title: 'Senior Backend Developer',
      company: 'Fintech Core Systems',
      description: 'Node.js, PostgreSQL, Docker, AWS. CTC: 22-28 LPA. Bengaluru, hybrid.',
    },
    expect: { meets: true, type: 'ctc' },
  },
  {
    label: 'salary below the 10 LPA bar',
    job: {
      title: 'Junior Node.js Developer',
      company: 'Data Systems LLC',
      description: 'Express and PostgreSQL work. Salary: 7 LPA. No CTC breakdown given.',
    },
    expect: { meets: false, type: 'salary' },
  },
  {
    label: 'salary between the two bars (passes as salary, would fail as CTC)',
    job: {
      title: 'Node.js Developer',
      company: 'Data Systems LLC',
      description: 'Express, PostgreSQL, Docker. Annual salary 12 LPA, plus benefits.',
    },
    expect: { meets: true, type: 'salary' },
  },
  {
    label: 'no pay stated (kept, not dropped)',
    job: {
      title: 'Platform Engineer',
      company: 'Discord',
      description: 'Node.js and Go services at scale. Compensation is discussed during the process.',
    },
    expect: { meets: true, type: 'none' },
  },
];

/**
 * Builds a small but structurally valid PDF (one page, one text run) so the
 * PDF path can be verified without shipping a binary fixture.
 *
 * @param {string} text
 * @returns {Buffer}
 */
function buildPdf(text) {
  const escaped = text.replace(/([()\\])/g, '\\$1');
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/* ------------------------------------------------------------------ */
/* 1. PostgreSQL                                                       */
/* ------------------------------------------------------------------ */

/**
 * Connects, applies the schema and round-trips a throwaway tenant.
 * @returns {Promise<boolean>} whether every database check passed
 */
async function verifyDatabase() {
  section('1. PostgreSQL');

  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    await check('connection', async () => 'skip: DATABASE_URL is not set');
    return true;
  }

  let ok = true;
  /** @type {Array<number>} user ids to clean up */
  const created = [];

  try {
    ok = (await check('connects and reports server version', async () => {
      const { rows } = await db.query('SELECT version() AS version');
      return String(rows[0].version).split(',')[0];
    })) && ok;

    ok = (await check('schema applies (users, resumes, jobs)', async () => {
      await db.initDatabase();
      const { rows } = await db.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name IN ('users','resumes','jobs')
          ORDER BY table_name`
      );
      assert.deepEqual(rows.map((row) => row.table_name), ['jobs', 'resumes', 'users']);
      return '3 tables';
    })) && ok;

    ok = (await check('jobs.match_data is JSONB', async () => {
      const { rows } = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'match_data'`
      );
      assert.equal(rows[0]?.data_type, 'jsonb', 'match_data must be a JSONB column');
      return 'jsonb';
    })) && ok;

    ok = (await check('user round-trip (bcrypt hash + lookup)', async () => {
      const user = await db.createUser(`${RUN_ID}_a`, await auth.hashPassword('correct horse battery'));
      created.push(user.id);

      const found = await db.findUserByUsername(`${RUN_ID}_a`);
      assert.equal(found.id, user.id);
      assert.ok(found.password_hash.startsWith('$2'), 'password must be stored as a bcrypt hash');
      assert.ok(await auth.verifyPassword('correct horse battery', found.password_hash));
      assert.equal(await auth.verifyPassword('wrong password', found.password_hash), false);
      return `user #${user.id}`;
    })) && ok;

    ok = (await check('resume insert + tenant-scoped read', async () => {
      const [userId] = created;
      const resume = await db.addResume(userId, 'verify-resume.pdf', MOCK_RESUMES[0].content);
      const resumes = await db.getResumes(userId);
      assert.equal(resumes.length, 1);
      assert.equal(resumes[0].id, resume.id);
      assert.ok(resumes[0].content.includes('Node.js'));
      return `resume #${resume.id}`;
    })) && ok;

    ok = (await check('job upsert stores match_data as JSONB', async () => {
      const [userId] = created;
      const matchData = {
        job_type: JOB_TYPES.INTERNSHIP,
        best_resume_id: (await db.getResumes(userId))[0].id,
        best_resume_name: 'verify-resume.pdf',
        score: 87,
        reason: 'Node.js and PostgreSQL overlap with the posting requirements.',
      };

      const first = await db.upsertJob(userId, {
        title: MOCK_JOB.title,
        company: MOCK_JOB.company,
        description: MOCK_JOB.description,
        applyUrl: `https://example.com/jobs/${RUN_ID}`,
        matchData,
        sourceId: 'verify',
      });
      assert.equal(first.inserted, true, 'first write must insert');

      // Same tenant + same URL must update rather than duplicate.
      const second = await db.upsertJob(userId, {
        title: MOCK_JOB.title,
        company: MOCK_JOB.company,
        applyUrl: `https://example.com/jobs/${RUN_ID}`,
      });
      assert.equal(second.inserted, false, 'second write must update, not insert');
      assert.equal(second.id, first.id);

      const [job] = await db.getJobs(userId);
      assert.equal(typeof job.match_data, 'object', 'match_data must come back parsed');
      assert.equal(job.match_data.job_type, JOB_TYPES.INTERNSHIP);
      assert.equal(job.match_data.score, 87);
      return `job #${job.id}`;
    })) && ok;

    ok = (await check('JSONB filtering powers the dashboard tabs', async () => {
      const [userId] = created;
      const internships = await db.getJobs(userId, { jobType: JOB_TYPES.INTERNSHIP });
      const fullTime = await db.getJobs(userId, { jobType: JOB_TYPES.FULL_TIME });
      assert.equal(internships.length, 1);
      assert.equal(fullTime.length, 0);

      const stats = await db.getStats(userId);
      assert.equal(stats.total, 1);
      assert.equal(stats.internships, 1);
      assert.equal(stats.strongMatches, 1);
      return `avg score ${stats.averageScore}`;
    })) && ok;

    ok = (await check('tenant isolation: a second user sees nothing', async () => {
      const other = await db.createUser(`${RUN_ID}_b`, await auth.hashPassword('another password'));
      created.push(other.id);

      assert.deepEqual(await db.getJobs(other.id), [], 'jobs must not leak across users');
      assert.deepEqual(await db.getResumes(other.id), [], 'resumes must not leak across users');
      assert.equal((await db.getStats(other.id)).total, 0);

      // Cross-tenant writes must be no-ops, not silent successes.
      const [ownerId] = created;
      const [job] = await db.getJobs(ownerId);
      assert.equal(await db.deleteJob(other.id, job.id), false, 'user B must not delete user A rows');
      assert.equal(await db.updateJobMatchData(other.id, job.id, { score: 0 }), false);
      return 'no cross-tenant reads or writes';
    })) && ok;

    ok = (await check('JWT round-trip', async () => {
      const [userId] = created;
      const token = auth.signToken({ id: userId, username: `${RUN_ID}_a` });
      const identity = auth.verifyToken(token);
      assert.equal(identity.id, userId);
      assert.throws(() => auth.verifyToken(`${token}tampered`), /invalid|jwt/i);
      return 'signed and verified';
    })) && ok;
  } finally {
    // Cascades remove the tenant's resumes and jobs with the user row.
    for (const userId of created) {
      await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
    }
    if (created.length) console.log(`  ...  cleaned up ${created.length} temporary user(s).`);
  }

  return ok;
}

/* ------------------------------------------------------------------ */
/* 2. Resume parsing                                                   */
/* ------------------------------------------------------------------ */

/**
 * Runs generated buffers through the in-memory extractor.
 * @returns {Promise<boolean>}
 */
async function verifyParsing() {
  section('2. Resume parsing (in memory)');
  let ok = true;

  ok = (await check('TXT buffer', async () => {
    const parsed = await extractResumeText(Buffer.from(MOCK_RESUMES[0].content, 'utf-8'), 'resume.txt', 'text/plain');
    assert.ok(parsed.text.includes('PostgreSQL'));
    return `${parsed.characters} chars`;
  })) && ok;

  ok = (await check('PDF buffer via pdf-parse', async () => {
    const pdf = buildPdf('Rishi - Backend Engineer. Node.js Express PostgreSQL Docker REST APIs AWS Redis.');
    const parsed = await extractResumeText(pdf, 'resume.pdf', 'application/pdf');
    assert.ok(/PostgreSQL/i.test(parsed.text), `extracted text was: ${parsed.text.slice(0, 120)}`);
    return `${parsed.characters} chars`;
  })) && ok;

  ok = (await check('unsupported types are rejected', async () => {
    await assert.rejects(
      () => extractResumeText(Buffer.from('binary'), 'resume.png', 'image/png'),
      /not a supported resume format/i
    );
    return 'rejected .png';
  })) && ok;

  return ok;
}

/* ------------------------------------------------------------------ */
/* 3. NVIDIA API                                                       */
/* ------------------------------------------------------------------ */

/**
 * Sends the mock payload to the configured NVIDIA model and validates the
 * strict JSON contract the app depends on.
 *
 * @returns {Promise<boolean>}
 */
async function verifyNvidia() {
  section('3. NVIDIA API (matching + categorisation)');

  if (!isLlmEnabled()) {
    await check('mock payload', async () => 'skip: NVIDIA_API_KEY is not set');
    return true;
  }

  console.log(`  model: ${MODEL}\n  endpoint: ${BASE_URL}`);
  let ok = true;
  let verdict = null;

  ok = (await check('mock payload returns a valid match object', async () => {
    verdict = await matchJob(MOCK_JOB, MOCK_RESUMES);

    assert.ok(verdict, 'no verdict returned');
    assert.equal(verdict.engine, 'llm', `fell back to keyword scoring: ${verdict.reason}`);
    assert.ok(
      [JOB_TYPES.INTERNSHIP, JOB_TYPES.FULL_TIME].includes(verdict.job_type),
      `job_type must be one of the two categories, got "${verdict.job_type}"`
    );
    assert.ok(
      MOCK_RESUMES.some((resume) => resume.id === verdict.best_resume_id),
      `best_resume_id ${verdict.best_resume_id} is not one of the ids that were sent`
    );
    assert.equal(typeof verdict.score, 'number');
    assert.ok(verdict.score >= 0 && verdict.score <= 100, 'score must be 0-100');
    assert.ok(String(verdict.reason).length > 5, 'reason must be a sentence');

    return `${verdict.job_type}, resume ${verdict.best_resume_id}, score ${verdict.score}`;
  })) && ok;

  if (verdict?.engine === 'llm') {
    ok = (await check('applies the pay bar to live model output', async () => {
      const outcomes = [];

      for (const fixture of PAY_FIXTURES) {
        const result = await matchJob(fixture.job, MOCK_RESUMES);
        const comp = result.compensation || {};

        assert.equal(
          result.meets_pay_bar,
          fixture.expect.meets,
          `${fixture.label}: expected meets_pay_bar=${fixture.expect.meets}, got ${result.meets_pay_bar} (${result.pay_note})`
        );
        assert.equal(comp.type, fixture.expect.type, `${fixture.label}: compensation type`);

        outcomes.push(`${fixture.expect.meets ? 'keep' : 'drop'} ${comp.type}`);
      }

      return outcomes.join(', ');
    })) && ok;

    ok = (await check('does not invent pay the posting never stated', async () => {
      const result = await matchJob(PAY_FIXTURES[4].job, MOCK_RESUMES);
      assert.equal(result.compensation.stated, false, `model supplied a figure from nowhere: ${JSON.stringify(result.compensation)}`);
      return 'compensation.stated = false';
    })) && ok;

    // Soft assertions: the mock posting is unambiguous, so a correct model
    // picks the internship category and the backend resume. A miss is worth
    // knowing about but is a model-quality signal, not a wiring failure.
    ok = (await check('categorises the mock internship correctly', async () => {
      assert.equal(verdict.job_type, JOB_TYPES.INTERNSHIP, `expected an Internship, got "${verdict.job_type}"`);
      return verdict.job_type;
    })) && ok;

    ok = (await check('prefers the backend resume over the mobile one', async () => {
      assert.equal(
        verdict.best_resume_id,
        101,
        `expected backend-resume.pdf (101), got ${verdict.best_resume_id} (${verdict.best_resume_name})`
      );
      return verdict.best_resume_name;
    })) && ok;

    console.log(`  reason: "${verdict.reason}"`);
  }

  return ok;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

(async () => {
  console.log('Job Application Bot - deployment verification');
  console.log(`Node ${process.version} on ${process.platform}`);

  let ok = true;

  try {
    ok = (await verifyDatabase()) && ok;
    ok = (await verifyParsing()) && ok;
    ok = (await verifyNvidia()) && ok;
  } catch (error) {
    console.error('\nVerification crashed:', error);
    ok = false;
  } finally {
    await db.close().catch(() => {});
  }

  const counts = results.reduce((acc, result) => ({ ...acc, [result.status]: (acc[result.status] || 0) + 1 }), {});
  section('Summary');
  console.log(`  ${counts.pass || 0} passed, ${counts.fail || 0} failed, ${counts.skip || 0} skipped`);

  if (counts.skip) {
    console.log('\n  Skipped checks need configuration in .env:');
    results.filter((result) => result.status === 'skip').forEach((result) => console.log(`    - ${result.name}: ${result.detail}`));
  }

  process.exit(ok ? 0 : 1);
})();
