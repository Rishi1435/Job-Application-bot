/**
 * Application entry point.
 *
 *  - serves the dashboard from /public
 *  - exposes the JSON API it consumes
 *  - schedules the daily scrape (00:00 by default) with node-cron
 *
 * Everything under /api/resumes, /api/jobs, /api/scrape and /api/status sits
 * behind `requireAuth`, so a request can only ever touch its own tenant's rows:
 * handlers pass `req.user.id` into the database layer, which filters by it.
 *
 * dotenv is loaded first so that every module below sees the configuration.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const multer = require('multer');
const cron = require('node-cron');

const db = require('./services/database');
const auth = require('./services/auth');
const { extractResumeText, detectResumeKind } = require('./services/parser');
const { runScraper, runScraperForUser, isRunning, runningFor, getLastRun } = require('./services/scraper');
const { MODEL, isLlmEnabled, buildSearchQueries, MIN_MATCH_SCORE } = require('./services/matcher');
const { buildCandidateProfile } = require('./services/relevance');
const { MIN_LPA_SALARY, MIN_LPA_CTC } = require('./services/compensation');
const { getEnabledChannels, getTrustedDomains } = require('./config/sources');
const { seedBoards } = require('./scripts/seed-boards');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 0 * * *'; // daily at midnight
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || undefined;
const RUN_ON_STARTUP = String(process.env.RUN_ON_STARTUP || 'false').toLowerCase() === 'true';

const MAX_RESUME_BYTES = Number(process.env.MAX_RESUME_BYTES || 5 * 1024 * 1024);
const MAX_RESUMES_PER_UPLOAD = Number(process.env.MAX_RESUMES_PER_UPLOAD || 10);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * Uploads stay in memory: the buffer goes straight to the PDF/DOCX extractor
 * and only the extracted text is persisted. Nothing is written to disk, which
 * is what makes the app safe on Render's ephemeral filesystem.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: MAX_RESUMES_PER_UPLOAD },
  fileFilter(req, file, callback) {
    if (detectResumeKind(file.originalname, file.mimetype)) return callback(null, true);
    callback(new Error(`"${file.originalname}" is not a PDF, DOCX or TXT file.`));
  },
});

/**
 * Wraps an async handler so a rejected promise reaches the error middleware
 * instead of hanging the request.
 *
 * @param {Function} handler
 * @returns {import('express').RequestHandler}
 */
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

/** POST /api/auth/register - create an account and return a JWT. */
app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    const result = await auth.register(String(username || '').trim(), String(password || ''));
    res.status(201).json(result);
  })
);

/** POST /api/auth/login - exchange credentials for a JWT. */
app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const { username, password } = req.body || {};
    const result = await auth.login(String(username || '').trim(), String(password || ''));
    res.json(result);
  })
);

/** GET /api/auth/me - who the current token belongs to. */
app.get('/api/auth/me', auth.requireAuth, (req, res) => res.json({ user: req.user }));

/* ------------------------------------------------------------------ */
/* Resumes (protected)                                                 */
/* ------------------------------------------------------------------ */

/** GET /api/resumes - this user's resumes (metadata only). */
app.get(
  '/api/resumes',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await db.getResumeSummaries(req.user.id));
  })
);

/**
 * POST /api/resumes - multipart upload of one or more resumes.
 *
 * Each file is parsed in memory; a file that cannot be read is reported in
 * `failed` while the readable ones are still saved, so one bad scan does not
 * lose the rest of the batch.
 */
app.post(
  '/api/resumes',
  auth.requireAuth,
  upload.array('resumes', MAX_RESUMES_PER_UPLOAD),
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files were uploaded.' });

    const saved = [];
    const failed = [];

    for (const file of files) {
      try {
        const parsed = await extractResumeText(file.buffer, file.originalname, file.mimetype);
        const row = await db.addResume(req.user.id, parsed.filename, parsed.text);
        saved.push({ ...row, kind: parsed.kind });
      } catch (error) {
        failed.push({ filename: file.originalname, error: error.message });
      }
    }

    res.status(saved.length ? 201 : 400).json({ saved, failed });
  })
);

/**
 * GET /api/resumes/profile - the seniority/role profile derived from this
 * user's resumes.
 *
 * The board silently drops postings that fail the relevance gate, so the
 * dashboard shows what the gate believes about the candidate. If it reads
 * someone as entry-level when they are senior, that is the number to look at.
 */
app.get(
  '/api/resumes/profile',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const resumes = await db.getResumes(req.user.id);
    const profile = buildCandidateProfile(resumes);
    res.json({
      level: profile.level,
      levelLabel: profile.levelLabel,
      years: profile.years,
      families: profile.families,
      skills: profile.skills,
      location: profile.location,
      resumeCount: resumes.length,
    });
  })
);

/** DELETE /api/resumes/:id - remove one of this user's resumes. */
app.delete(
  '/api/resumes/:id',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const removed = await db.deleteResume(req.user.id, Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Resume not found.' });
    res.json({ ok: true });
  })
);

/* ------------------------------------------------------------------ */
/* Jobs (protected)                                                    */
/* ------------------------------------------------------------------ */

/**
 * GET /api/jobs
 * Query params: `jobType` ("Internship" | "Full-Time Job"), `minScore`, `q`,
 * `limit`, `includeBelowBar` (postings under the pay bar are hidden by default).
 * Rows come back best match first.
 */
app.get(
  '/api/jobs',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const minScore = Number(req.query.minScore);
    const limit = Number(req.query.limit);

    const jobs = await db.getJobs(req.user.id, {
      jobType: req.query.jobType ? String(req.query.jobType) : undefined,
      minScore: Number.isFinite(minScore) ? minScore : undefined,
      search: req.query.q ? String(req.query.q) : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
      includeBelowBar: String(req.query.includeBelowBar || '').toLowerCase() === 'true',
      includeMismatch: String(req.query.includeMismatch || '').toLowerCase() === 'true',
    });

    res.json(jobs);
  })
);

/** GET /api/jobs/stats - counters for the dashboard header. */
app.get(
  '/api/jobs/stats',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    res.json(await db.getStats(req.user.id));
  })
);

/** DELETE /api/jobs/:id - drop one posting from this user's board. */
app.delete(
  '/api/jobs/:id',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const removed = await db.deleteJob(req.user.id, Number(req.params.id));
    if (!removed) return res.status(404).json({ error: 'Job not found.' });
    res.json({ ok: true });
  })
);

/** DELETE /api/jobs - clear this user's board. */
app.delete(
  '/api/jobs',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ removed: await db.deleteAllJobs(req.user.id) });
  })
);

/* ------------------------------------------------------------------ */
/* Scraping (protected)                                                */
/* ------------------------------------------------------------------ */

/**
 * POST /api/scrape - start a run for the calling user and answer immediately.
 *
 * A crawl takes minutes; a hosting proxy gives a request about one. Holding the
 * connection open until the run finished meant the browser was shown a timeout
 * while the scrape carried on invisibly - the worst of both. The run is now
 * fired and left to finish, and the client follows it through `GET /api/status`
 * (`running`, then `lastRun`), which is also what a page reload mid-run sees.
 */
app.post(
  '/api/scrape',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    if (isRunning()) {
      const minutes = Math.floor(runningFor() / 60000);
      return res.status(409).json({
        error: minutes
          ? `A scrape has been running for ${minutes} minute(s). It will finish on its own.`
          : 'A scrape is already running.',
      });
    }

    // Deliberately not awaited. `runScraperForUser` handles its own errors and
    // records them on `lastRun`; nothing here can act on a rejection anyway.
    runScraperForUser(req.user.id).catch((error) => {
      console.error('[server] Manual scrape failed:', error.message);
    });

    res.status(202).json({ status: 'started' });
  })
);

/**
 * GET /api/status - scheduler state, the discovery channels, and what *this*
 * user's next run will search for. There is no source list any more: the
 * equivalent answer to "where do the jobs come from?" is the channel set plus
 * the size of the discovered-board registry.
 */
app.get(
  '/api/status',
  auth.requireAuth,
  asyncRoute(async (req, res) => {
    const resumes = await db.getResumes(req.user.id);

    res.json({
      running: isRunning(),
      runningForMs: runningFor(),
      cronSchedule: CRON_SCHEDULE,
      timezone: CRON_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      matcher: { model: MODEL, llmEnabled: isLlmEnabled(), minScore: MIN_MATCH_SCORE },
      payBar: { salaryLpa: MIN_LPA_SALARY, ctcLpa: MIN_LPA_CTC },
      channels: getEnabledChannels(),
      trustedDomains: getTrustedDomains(),
      boards: await db.getBoardStats(),
      search: { queries: buildSearchQueries(resumes).slice(0, 10) },
      lastRun: getLastRun(),
    });
  })
);

/** GET /api/health - liveness probe (public, used by Render). */
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/** Unknown API routes get JSON, not the SPA shell. */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/**
 * Central error handler. Errors carrying a `.status` (thrown by the auth
 * service) keep it; multer's upload limits are translated into 400/413.
 */
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    const tooBig = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig ? `Each resume must be under ${Math.round(MAX_RESUME_BYTES / 1024 / 1024)} MB.` : error.message,
    });
  }

  const status = Number(error.status) || 500;
  if (status >= 500) console.error('[api] Unhandled error:', error);

  res.status(status).json({ error: status >= 500 ? 'Internal server error.' : error.message });
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

/**
 * Boots the HTTP server, then registers the daily cron job.
 * @returns {Promise<void>}
 */
async function start() {
  if (!auth.isConfigured()) {
    throw new Error('JWT_SECRET must be set to a random string of at least 16 characters.');
  }

  await db.initDatabase();

  // Run on every boot rather than only on an empty registry. A registry can be
  // populated and still be missing everything that matters - a database seeded
  // by the feeds alone holds US startups and nothing hiring where the candidate
  // lives - and a hosted instance usually has no shell to run the script from.
  // `recordBoards` upserts and never resets `last_scraped_at`, so repeating it
  // costs a few dozen no-op queries and changes nothing about scrape order.
  try {
    const seeded = await seedBoards();
    if (seeded.added) {
      console.log(`[server] Seeded ${seeded.added} previously discovered board(s); registry holds ${seeded.total}.`);
    }
  } catch (error) {
    console.warn(`[server] Could not seed the board registry: ${error.message}`);
  }

  const server = app.listen(PORT, () => {
    console.log(`[server] Dashboard ready at http://localhost:${PORT}`);
    console.log(`[server] Matcher: ${isLlmEnabled() ? MODEL : 'keyword fallback (no NVIDIA_API_KEY)'}`);
  });

  let task = null;
  if (cron.validate(CRON_SCHEDULE)) {
    task = cron.schedule(
      CRON_SCHEDULE,
      async () => {
        console.log('[cron] Running scheduled scrape for all users...');
        try {
          await runScraper({ trigger: 'cron' });
        } catch (error) {
          console.error('[cron] Scheduled run failed:', error.message);
        }
      },
      CRON_TIMEZONE ? { timezone: CRON_TIMEZONE } : undefined
    );
    console.log(`[cron] Scrape scheduled with "${CRON_SCHEDULE}" (${CRON_TIMEZONE || 'server time'}).`);
  } else {
    console.error(`[cron] Invalid CRON_SCHEDULE "${CRON_SCHEDULE}" - the scheduler is disabled.`);
  }

  if (RUN_ON_STARTUP) {
    console.log('[server] RUN_ON_STARTUP=true - kicking off an initial scrape.');
    runScraper({ trigger: 'startup' }).catch((error) => console.error('[server] Startup scrape failed:', error.message));
  }

  /** Closes the scheduler, HTTP server and pool on SIGINT/SIGTERM. */
  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received - shutting down.`);
    try {
      if (task) await task.stop();
      server.close();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Keep unexpected async failures visible instead of silently crashing.
process.on('unhandledRejection', (reason) => console.error('[server] Unhandled rejection:', reason));

if (require.main === module) {
  start().catch((error) => {
    console.error('[server] Failed to start:', error.message);
    process.exit(1);
  });
}

module.exports = { app, start };
