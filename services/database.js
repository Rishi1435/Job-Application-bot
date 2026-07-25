/**
 * SQLite persistence layer.
 *
 * Responsibilities:
 *  - own the schema (and migrate older databases forward in place)
 *  - de-duplicate postings on their apply URL while still tracking "seen again"
 *  - expose a small promise-based API to the rest of the app
 *
 * The sqlite3 driver is callback based, so every query is wrapped in a promise
 * helper below. No other module should touch `db` directly.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.resolve(__dirname, '../jobs.sqlite');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('[db] Failed to open database:', err.message);
  } else {
    console.log(`[db] Connected to SQLite at ${DB_PATH}`);
  }
});

/* ------------------------------------------------------------------ */
/* Promise helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Runs a statement that does not return rows.
 * @param {string} sql
 * @param {Array<any>} [params]
 * @returns {Promise<{lastID:number, changes:number}>}
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * Runs a query returning many rows.
 * @param {string} sql
 * @param {Array<any>} [params]
 * @returns {Promise<Array<object>>}
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/**
 * Runs a query returning at most one row.
 * @param {string} sql
 * @param {Array<any>} [params]
 * @returns {Promise<object|undefined>}
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    company     TEXT,
    description TEXT,
    applyUrl    TEXT UNIQUE NOT NULL,
    datePosted  TEXT,
    score       INTEGER,
    reason      TEXT,
    sourceId    TEXT,
    sourceName  TEXT,
    firstSeenAt TEXT,
    lastSeenAt  TEXT,
    timesSeen   INTEGER DEFAULT 1
  )
`;

const RUNS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS scrape_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    startedAt   TEXT NOT NULL,
    finishedAt  TEXT,
    trigger     TEXT,
    status      TEXT,
    found       INTEGER DEFAULT 0,
    inserted    INTEGER DEFAULT 0,
    duplicates  INTEGER DEFAULT 0,
    scored      INTEGER DEFAULT 0,
    errors      TEXT
  )
`;

/** Columns added after the first release; applied to pre-existing databases. */
const MIGRATIONS = [
  { column: 'sourceId', ddl: 'ALTER TABLE jobs ADD COLUMN sourceId TEXT' },
  { column: 'sourceName', ddl: 'ALTER TABLE jobs ADD COLUMN sourceName TEXT' },
  { column: 'firstSeenAt', ddl: 'ALTER TABLE jobs ADD COLUMN firstSeenAt TEXT' },
  { column: 'lastSeenAt', ddl: 'ALTER TABLE jobs ADD COLUMN lastSeenAt TEXT' },
  { column: 'timesSeen', ddl: 'ALTER TABLE jobs ADD COLUMN timesSeen INTEGER DEFAULT 1' },
];

/**
 * Creates tables/indexes when missing and adds any columns introduced later.
 * Safe to call repeatedly; awaited once at startup by `server.js`.
 *
 * @returns {Promise<void>}
 */
async function initDatabase() {
  await run(JOBS_SCHEMA);
  await run(RUNS_SCHEMA);

  const columns = await all('PRAGMA table_info(jobs)');
  const existing = new Set(columns.map((c) => c.name));

  for (const migration of MIGRATIONS) {
    if (!existing.has(migration.column)) {
      await run(migration.ddl);
      console.log(`[db] Migrated: added jobs.${migration.column}`);
    }
  }

  await run('CREATE INDEX IF NOT EXISTS idx_jobs_score ON jobs (score DESC)');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_applyUrl ON jobs (applyUrl)');
}

/** Kicked off immediately so callers that forget to await `initDatabase` still work. */
const ready = initDatabase().catch((err) => {
  console.error('[db] Schema initialisation failed:', err.message);
});

/* ------------------------------------------------------------------ */
/* Job queries                                                         */
/* ------------------------------------------------------------------ */

/**
 * Checks whether a posting has already been stored.
 * Used by the scraper to skip LLM scoring for jobs it has seen before.
 *
 * @param {string} applyUrl canonical apply link
 * @returns {Promise<boolean>}
 */
async function jobExists(applyUrl) {
  await ready;
  const row = await get('SELECT 1 AS hit FROM jobs WHERE applyUrl = ?', [applyUrl]);
  return Boolean(row);
}

/**
 * Inserts a job, or records another sighting when the apply URL already exists.
 *
 * @param {object} job normalised job record
 * @returns {Promise<{status:'inserted'|'duplicate', id?:number}>}
 */
async function insertJob(job) {
  await ready;
  const now = new Date().toISOString();

  const existing = await get('SELECT id FROM jobs WHERE applyUrl = ?', [job.applyUrl]);
  if (existing) {
    await run('UPDATE jobs SET lastSeenAt = ?, timesSeen = COALESCE(timesSeen, 1) + 1 WHERE id = ?', [
      now,
      existing.id,
    ]);
    return { status: 'duplicate', id: existing.id };
  }

  const sql = `
    INSERT INTO jobs
      (title, company, description, applyUrl, datePosted, score, reason,
       sourceId, sourceName, firstSeenAt, lastSeenAt, timesSeen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `;

  try {
    const result = await run(sql, [
      job.title,
      job.company || null,
      job.description || null,
      job.applyUrl,
      job.datePosted || null,
      Number.isFinite(job.score) ? job.score : null,
      job.reason || null,
      job.sourceId || null,
      job.sourceName || null,
      now,
      now,
    ]);
    return { status: 'inserted', id: result.lastID };
  } catch (error) {
    // A concurrent run can win the race between the SELECT and the INSERT.
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return { status: 'duplicate' };
    }
    throw error;
  }
}

/**
 * Fetches stored jobs, highest match score first.
 *
 * @param {{minScore?:number, search?:string, limit?:number}} [options]
 * @returns {Promise<Array<object>>}
 */
async function getAllJobs(options = {}) {
  await ready;
  const clauses = [];
  const params = [];

  if (Number.isFinite(options.minScore)) {
    clauses.push('COALESCE(score, 0) >= ?');
    params.push(options.minScore);
  }

  if (options.search) {
    clauses.push('(LOWER(title) LIKE ? OR LOWER(company) LIKE ?)');
    const needle = `%${String(options.search).toLowerCase()}%`;
    params.push(needle, needle);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  let sql = `
    SELECT id, title, company, description, applyUrl, datePosted, score, reason,
           sourceId, sourceName, firstSeenAt, lastSeenAt, timesSeen
    FROM jobs
    ${where}
    ORDER BY COALESCE(score, -1) DESC, COALESCE(datePosted, firstSeenAt) DESC
  `;

  if (Number.isFinite(options.limit)) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  return all(sql, params);
}

/**
 * Aggregate counters for the dashboard header.
 * @returns {Promise<{total:number, strongMatches:number, averageScore:number|null, lastSeenAt:string|null}>}
 */
async function getStats() {
  await ready;
  const row = await get(`
    SELECT COUNT(*)                                        AS total,
           SUM(CASE WHEN score >= 70 THEN 1 ELSE 0 END)    AS strongMatches,
           ROUND(AVG(score), 1)                            AS averageScore,
           MAX(lastSeenAt)                                 AS lastSeenAt
    FROM jobs
  `);
  return {
    total: row?.total || 0,
    strongMatches: row?.strongMatches || 0,
    averageScore: row?.averageScore ?? null,
    lastSeenAt: row?.lastSeenAt || null,
  };
}

/* ------------------------------------------------------------------ */
/* Scrape run bookkeeping                                              */
/* ------------------------------------------------------------------ */

/**
 * Opens a row in `scrape_runs` for the run that is starting.
 * @param {'cron'|'manual'|'startup'} trigger what kicked the run off
 * @returns {Promise<number>} run id
 */
async function startRun(trigger) {
  await ready;
  const result = await run('INSERT INTO scrape_runs (startedAt, trigger, status) VALUES (?, ?, ?)', [
    new Date().toISOString(),
    trigger,
    'running',
  ]);
  return result.lastID;
}

/**
 * Closes out a run row with its final counters.
 *
 * @param {number} runId id returned by `startRun`
 * @param {{status:string, found?:number, inserted?:number, duplicates?:number, scored?:number, errors?:Array<string>}} summary
 * @returns {Promise<void>}
 */
async function finishRun(runId, summary) {
  await ready;
  await run(
    `UPDATE scrape_runs
        SET finishedAt = ?, status = ?, found = ?, inserted = ?, duplicates = ?, scored = ?, errors = ?
      WHERE id = ?`,
    [
      new Date().toISOString(),
      summary.status,
      summary.found || 0,
      summary.inserted || 0,
      summary.duplicates || 0,
      summary.scored || 0,
      summary.errors && summary.errors.length ? JSON.stringify(summary.errors) : null,
      runId,
    ]
  );
}

/**
 * Returns the most recent finished-or-running scrape run, or null.
 * @returns {Promise<object|null>}
 */
async function getLastRun() {
  await ready;
  const row = await get('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1');
  if (!row) return null;
  return { ...row, errors: row.errors ? JSON.parse(row.errors) : [] };
}

/**
 * Closes the database handle (used on graceful shutdown).
 * @returns {Promise<void>}
 */
function close() {
  return new Promise((resolve) => db.close(() => resolve()));
}

module.exports = {
  db,
  DB_PATH,
  ready,
  initDatabase,
  jobExists,
  insertJob,
  getAllJobs,
  getStats,
  startRun,
  finishRun,
  getLastRun,
  close,
};
