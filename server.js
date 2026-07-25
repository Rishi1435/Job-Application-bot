/**
 * Application entry point.
 *
 *  - serves the dashboard from /public
 *  - exposes the JSON API consumed by the dashboard
 *  - schedules the daily scrape (00:00 by default) with node-cron
 *
 * dotenv is loaded first so that every module below sees the configuration.
 */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cron = require('node-cron');

const { getAllJobs, getStats, getLastRun, initDatabase, close: closeDatabase } = require('./services/database');
const { runScraper, isRunning } = require('./services/scraper');
const { MODEL, TARGET_ROLE, isLlmEnabled } = require('./services/matcher');
const { getEnabledSources } = require('./config/sources');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 0 * * *'; // daily at midnight
const CRON_TIMEZONE = process.env.CRON_TIMEZONE || undefined;
const RUN_ON_STARTUP = String(process.env.RUN_ON_STARTUP || 'false').toLowerCase() === 'true';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/jobs
 * Query params: `minScore` (number), `q` (title/company search), `limit` (number).
 * Rows come back sorted by match score, highest first.
 */
app.get('/api/jobs', async (req, res) => {
  try {
    const minScore = Number(req.query.minScore);
    const limit = Number(req.query.limit);

    const jobs = await getAllJobs({
      minScore: Number.isFinite(minScore) ? minScore : undefined,
      search: req.query.q ? String(req.query.q) : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });

    res.json(jobs);
  } catch (error) {
    console.error('[api] /api/jobs failed:', error.message);
    res.status(500).json({ error: 'Failed to retrieve jobs from the database.' });
  }
});

/** GET /api/stats - aggregate counters for the dashboard header. */
app.get('/api/stats', async (req, res) => {
  try {
    res.json(await getStats());
  } catch (error) {
    console.error('[api] /api/stats failed:', error.message);
    res.status(500).json({ error: 'Failed to compute statistics.' });
  }
});

/** GET /api/status - scraper/scheduler state plus the last run summary. */
app.get('/api/status', async (req, res) => {
  try {
    res.json({
      running: isRunning(),
      cronSchedule: CRON_SCHEDULE,
      timezone: CRON_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      matcher: { model: MODEL, targetRole: TARGET_ROLE, llmEnabled: isLlmEnabled() },
      sources: getEnabledSources().map((s) => ({ id: s.id, name: s.name, mode: s.mode })),
      lastRun: await getLastRun(),
    });
  } catch (error) {
    console.error('[api] /api/status failed:', error.message);
    res.status(500).json({ error: 'Failed to read scraper status.' });
  }
});

/**
 * POST /api/scrape - triggers a scrape immediately instead of waiting for cron.
 * Returns 409 while another run is in flight.
 */
app.post('/api/scrape', async (req, res) => {
  if (isRunning()) {
    return res.status(409).json({ error: 'A scrape is already running.' });
  }

  try {
    const summary = await runScraper({ trigger: 'manual' });
    res.json(summary);
  } catch (error) {
    console.error('[api] /api/scrape failed:', error.message);
    res.status(500).json({ error: 'Scrape failed.', detail: error.message });
  }
});

/** GET /api/health - liveness probe. */
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

/** Unknown API routes get JSON, not the SPA shell. */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

/** Last-resort error handler so a thrown error never kills the process. */
app.use((error, req, res, next) => {
  console.error('[api] Unhandled error:', error.message);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error.' });
});

/* ------------------------------------------------------------------ */
/* Startup                                                             */
/* ------------------------------------------------------------------ */

/**
 * Boots the HTTP server, then registers the daily cron job.
 * @returns {Promise<void>}
 */
async function start() {
  await initDatabase();

  const server = app.listen(PORT, () => {
    console.log(`[server] Dashboard ready at http://localhost:${PORT}`);
    console.log(`[server] Matcher: ${isLlmEnabled() ? MODEL : 'keyword fallback (no NVIDIA_API_KEY)'}`);
  });

  let task = null;
  if (cron.validate(CRON_SCHEDULE)) {
    task = cron.schedule(
      CRON_SCHEDULE,
      async () => {
        console.log('[cron] Running scheduled job scrape...');
        try {
          await runScraper({ trigger: 'cron' });
        } catch (error) {
          console.error('[cron] Scheduled run failed:', error.message);
        }
      },
      CRON_TIMEZONE ? { timezone: CRON_TIMEZONE } : undefined
    );
    console.log(`[cron] Daily scrape scheduled with "${CRON_SCHEDULE}".`);
  } else {
    console.error(`[cron] Invalid CRON_SCHEDULE "${CRON_SCHEDULE}" - the scheduler is disabled.`);
  }

  if (RUN_ON_STARTUP) {
    console.log('[server] RUN_ON_STARTUP=true - kicking off an initial scrape.');
    runScraper({ trigger: 'startup' }).catch((error) => console.error('[server] Startup scrape failed:', error.message));
  }

  /** Closes the scheduler, HTTP server and database on SIGINT/SIGTERM. */
  const shutdown = async (signal) => {
    console.log(`\n[server] ${signal} received - shutting down.`);
    try {
      if (task) await task.stop();
      server.close();
      await closeDatabase();
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
    console.error('[server] Failed to start:', error);
    process.exit(1);
  });
}

module.exports = { app, start };
