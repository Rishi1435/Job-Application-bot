/**
 * PostgreSQL persistence layer (multi-tenant).
 *
 * Every row in `resumes` and `jobs` belongs to exactly one user, and *every*
 * query in this file filters by `user_id`. That is the only tenancy boundary in
 * the app, so it is enforced here rather than in the route handlers: a route
 * cannot accidentally read another tenant's data because no function exposed
 * below will run without a user id.
 *
 * All statements are parameterised ($1, $2, ...) - no string interpolation of
 * user input anywhere.
 */

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

/**
 * Render's managed Postgres terminates TLS with a certificate the Node client
 * does not trust out of the box, so external connections need
 * `rejectUnauthorized: false`. Internal connections (and local Docker) do not
 * use TLS at all. Force either way with DATABASE_SSL=true|false.
 *
 * @returns {false|{rejectUnauthorized:boolean}}
 */
function resolveSsl() {
  const explicit = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (explicit === 'true') return { rejectUnauthorized: false };
  if (explicit === 'false') return false;

  if (/sslmode=disable/i.test(CONNECTION_STRING)) return false;
  if (/localhost|127\.0\.0\.1|\.internal|host\.docker\.internal/i.test(CONNECTION_STRING)) return false;
  return CONNECTION_STRING ? { rejectUnauthorized: false } : false;
}

const pool = new Pool({
  connectionString: CONNECTION_STRING,
  ssl: resolveSsl(),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
});

// A dropped backend connection must never take the process down with it.
pool.on('error', (error) => console.error('[db] Idle client error:', error.message));

/**
 * Runs a parameterised statement.
 *
 * @param {string} text SQL with $1-style placeholders
 * @param {Array<any>} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params = []) {
  return pool.query(text, params);
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
     id            SERIAL PRIMARY KEY,
     username      VARCHAR(64)  NOT NULL UNIQUE,
     password_hash VARCHAR(255) NOT NULL,
     created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS resumes (
     id         SERIAL PRIMARY KEY,
     user_id    INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     filename   VARCHAR(255) NOT NULL,
     content    TEXT         NOT NULL,
     created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS jobs (
     id          SERIAL PRIMARY KEY,
     user_id     INTEGER       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     title       VARCHAR(512)  NOT NULL,
     company     VARCHAR(255),
     description TEXT,
     apply_url   VARCHAR(1024) NOT NULL,
     location    VARCHAR(255),
     match_data  JSONB,
     source_id   VARCHAR(128),
     date_posted VARCHAR(64),
     created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
     updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
   )`,

  // Older databases created before match_data / bookkeeping columns existed.
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS match_data JSONB`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_id VARCHAR(128)`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS date_posted VARCHAR(64)`,
  // The office the posting names. Needed as a column, not just inside
  // match_data, so `scripts/rescreen.js` can re-run the location gate without
  // re-scraping the board.
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS location VARCHAR(255)`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,

  // One copy of a posting per tenant; re-scraping updates instead of inserting.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_user_apply_url ON jobs (user_id, apply_url)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_resumes_user ON resumes (user_id)`,
  // Keeps the "Internships" / "Full-Time" tab queries off a sequential scan.
  `CREATE INDEX IF NOT EXISTS idx_jobs_match_data ON jobs USING GIN (match_data)`,
];

/**
 * Creates tables, columns and indexes when missing. Safe to call repeatedly;
 * awaited once at startup by `server.js` and by `scripts/scrape.js`.
 *
 * @returns {Promise<void>}
 */
async function initDatabase() {
  if (!CONNECTION_STRING) {
    throw new Error('DATABASE_URL is not set - point it at a PostgreSQL instance.');
  }

  const client = await pool.connect();
  try {
    for (const statement of SCHEMA) {
      await client.query(statement);
    }
    console.log('[db] PostgreSQL schema ready.');
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

/**
 * @param {string} username
 * @param {string} passwordHash bcrypt hash - never a plaintext password
 * @returns {Promise<{id:number, username:string, created_at:Date}>}
 */
async function createUser(username, passwordHash) {
  const { rows } = await query(
    `INSERT INTO users (username, password_hash)
     VALUES ($1, $2)
     RETURNING id, username, created_at`,
    [username, passwordHash]
  );
  return rows[0];
}

/**
 * @param {string} username
 * @returns {Promise<{id:number, username:string, password_hash:string}|null>}
 */
async function findUserByUsername(username) {
  const { rows } = await query(
    'SELECT id, username, password_hash, created_at FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );
  return rows[0] || null;
}

/**
 * @param {number} id
 * @returns {Promise<{id:number, username:string}|null>}
 */
async function findUserById(id) {
  const { rows } = await query('SELECT id, username, created_at FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * Every user id in the system - used by the scheduled scrape, which matches
 * each freshly scraped posting against every tenant's resumes.
 *
 * @returns {Promise<Array<{id:number, username:string}>>}
 */
async function listUsers() {
  const { rows } = await query('SELECT id, username FROM users ORDER BY id');
  return rows;
}

/* ------------------------------------------------------------------ */
/* Resumes                                                             */
/* ------------------------------------------------------------------ */

/**
 * Stores extracted resume text. Files themselves are never written to disk.
 *
 * @param {number} userId owner
 * @param {string} filename original upload name
 * @param {string} content extracted plain text
 * @returns {Promise<{id:number, filename:string, created_at:Date}>}
 */
async function addResume(userId, filename, content) {
  const { rows } = await query(
    `INSERT INTO resumes (user_id, filename, content)
     VALUES ($1, $2, $3)
     RETURNING id, filename, created_at, LENGTH(content) AS characters`,
    [userId, filename, content]
  );
  return rows[0];
}

/**
 * Full resume records for one tenant, including text (the matcher needs it).
 *
 * @param {number} userId
 * @returns {Promise<Array<{id:number, filename:string, content:string}>>}
 */
async function getResumes(userId) {
  const { rows } = await query(
    'SELECT id, filename, content, created_at FROM resumes WHERE user_id = $1 ORDER BY id',
    [userId]
  );
  return rows;
}

/**
 * Metadata only - what the dashboard lists (resume text can be megabytes).
 *
 * @param {number} userId
 * @returns {Promise<Array<{id:number, filename:string, characters:number}>>}
 */
async function getResumeSummaries(userId) {
  const { rows } = await query(
    `SELECT id, filename, created_at, LENGTH(content) AS characters
       FROM resumes
      WHERE user_id = $1
      ORDER BY id`,
    [userId]
  );
  return rows;
}

/**
 * @param {number} userId
 * @param {number} resumeId
 * @returns {Promise<object|null>}
 */
async function getResumeById(userId, resumeId) {
  const { rows } = await query('SELECT id, filename, content FROM resumes WHERE user_id = $1 AND id = $2', [
    userId,
    resumeId,
  ]);
  return rows[0] || null;
}

/**
 * @param {number} userId
 * @param {number} resumeId
 * @returns {Promise<boolean>} whether a row was removed
 */
async function deleteResume(userId, resumeId) {
  const { rowCount } = await query('DELETE FROM resumes WHERE user_id = $1 AND id = $2', [userId, resumeId]);
  return rowCount > 0;
}

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

/**
 * Inserts a posting for one tenant, or refreshes the stored copy when that
 * tenant has already seen the apply URL.
 *
 * @param {number} userId owner
 * @param {{title:string, company?:string, description?:string, applyUrl:string, matchData?:object, sourceId?:string, datePosted?:string}} job
 * @returns {Promise<{id:number, inserted:boolean}>}
 */
async function upsertJob(userId, job) {
  const { rows } = await query(
    `INSERT INTO jobs (user_id, title, company, description, apply_url, location, match_data, source_id, date_posted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, apply_url) DO UPDATE
        SET title       = EXCLUDED.title,
            company     = EXCLUDED.company,
            description = COALESCE(EXCLUDED.description, jobs.description),
            location    = COALESCE(EXCLUDED.location, jobs.location),
            match_data  = COALESCE(EXCLUDED.match_data, jobs.match_data),
            source_id   = COALESCE(EXCLUDED.source_id, jobs.source_id),
            date_posted = COALESCE(EXCLUDED.date_posted, jobs.date_posted),
            updated_at  = NOW()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      userId,
      String(job.title).slice(0, 512),
      job.company ? String(job.company).slice(0, 255) : null,
      job.description || null,
      String(job.applyUrl).slice(0, 1024),
      job.location ? String(job.location).slice(0, 255) : null,
      job.matchData ? JSON.stringify(job.matchData) : null,
      job.sourceId || null,
      job.datePosted || null,
    ]
  );
  return { id: rows[0].id, inserted: rows[0].inserted };
}

/**
 * Whether this tenant already stores a posting (used to skip re-scoring).
 *
 * @param {number} userId
 * @param {string} applyUrl
 * @returns {Promise<boolean>}
 */
async function jobExists(userId, applyUrl) {
  const { rows } = await query('SELECT 1 FROM jobs WHERE user_id = $1 AND apply_url = $2', [userId, applyUrl]);
  return rows.length > 0;
}

/**
 * Writes the LLM verdict into the JSONB column.
 *
 * @param {number} userId
 * @param {number} jobId
 * @param {object} matchData `{job_type, best_resume_id, best_resume_name, score, reason}`
 * @returns {Promise<boolean>}
 */
async function updateJobMatchData(userId, jobId, matchData) {
  const { rowCount } = await query(
    'UPDATE jobs SET match_data = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2',
    [userId, jobId, JSON.stringify(matchData)]
  );
  return rowCount > 0;
}

/**
 * Tenant-scoped job listing, best match first.
 *
 * Postings that fail the compensation bar are stored but excluded by default -
 * they are still there for auditing (and survive a change of thresholds without
 * a re-scrape), they are simply not recommended. Pass `includeBelowBar` to see
 * them. `IS NOT FALSE` keeps rows saved before the bar existed, whose
 * `meets_pay_bar` key is absent rather than false.
 *
 * Postings the relevance gate rejected (wrong field, or several levels above the
 * candidate) are hidden the same way and for the same reason: kept for auditing,
 * excluded from the board unless `includeMismatch` is passed.
 *
 * @param {number} userId
 * @param {{jobType?:string, minScore?:number, search?:string, limit?:number, includeBelowBar?:boolean, includeMismatch?:boolean}} [options]
 * @returns {Promise<Array<object>>}
 */
async function getJobs(userId, options = {}) {
  const params = [userId];
  const clauses = ['user_id = $1'];

  if (!options.includeBelowBar) {
    clauses.push(`(match_data->>'meets_pay_bar')::boolean IS NOT FALSE`);
  }

  if (!options.includeMismatch) {
    // `NOT IN` rather than `= 'match'` so rows stored before the gate existed,
    // whose `relevance` key is absent, keep showing.
    clauses.push(`COALESCE(match_data->'relevance'->>'fit', 'match') NOT IN ('mismatch', 'overreach', 'elsewhere')`);
  }

  if (options.jobType) {
    params.push(options.jobType);
    clauses.push(`match_data->>'job_type' = $${params.length}`);
  }

  if (Number.isFinite(options.minScore)) {
    params.push(options.minScore);
    clauses.push(`COALESCE((match_data->>'score')::numeric, 0) >= $${params.length}`);
  }

  if (options.search) {
    params.push(`%${String(options.search).toLowerCase()}%`);
    clauses.push(`(LOWER(title) LIKE $${params.length} OR LOWER(COALESCE(company, '')) LIKE $${params.length})`);
  }

  let sql = `
    SELECT id, title, company, description, apply_url, location, match_data, source_id, date_posted, created_at, updated_at
      FROM jobs
     WHERE ${clauses.join(' AND ')}
     ORDER BY COALESCE((match_data->>'score')::numeric, -1) DESC, created_at DESC`;

  if (Number.isFinite(options.limit)) {
    params.push(options.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Postings this tenant has stored but never scored (e.g. saved during an LLM
 * outage). `scripts/scrape.js --rescore` feeds these back through the matcher.
 *
 * @param {number} userId
 * @param {number} [limit]
 * @returns {Promise<Array<object>>}
 */
async function getUnmatchedJobs(userId, limit = 50) {
  const { rows } = await query(
    `SELECT id, title, company, description, apply_url
       FROM jobs
      WHERE user_id = $1 AND (match_data IS NULL OR match_data->>'score' IS NULL)
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

/**
 * Header counters for the dashboard, scoped to one tenant.
 *
 * Counts describe the *recommended* board (pay bar applied); `belowPayBar`
 * reports how many postings the bar is holding back.
 *
 * @param {number} userId
 * @returns {Promise<{total:number, internships:number, fullTime:number, strongMatches:number, averageScore:number|null, belowPayBar:number, lastUpdatedAt:string|null}>}
 */
async function getStats(userId) {
  const { rows } = await query(
    `WITH recommended AS (
       SELECT * FROM jobs
        WHERE user_id = $1
          AND (match_data->>'meets_pay_bar')::boolean IS NOT FALSE
          AND COALESCE(match_data->'relevance'->>'fit', 'match') NOT IN ('mismatch', 'overreach', 'elsewhere')
     )
     SELECT (SELECT COUNT(*) FROM recommended)::int                                                     AS total,
            (SELECT COUNT(*) FROM recommended WHERE match_data->>'job_type' = 'Internship')::int        AS internships,
            (SELECT COUNT(*) FROM recommended WHERE match_data->>'job_type' = 'Full-Time Job')::int     AS full_time,
            (SELECT COUNT(*) FROM recommended WHERE (match_data->>'score')::numeric >= 70)::int         AS strong_matches,
            (SELECT ROUND(AVG((match_data->>'score')::numeric), 1) FROM recommended)                    AS average_score,
            (SELECT COUNT(*) FROM jobs
              WHERE user_id = $1 AND (match_data->>'meets_pay_bar')::boolean IS FALSE)::int             AS below_pay_bar,
            (SELECT COUNT(*) FROM jobs
              WHERE user_id = $1
                AND match_data->'relevance'->>'fit' IN ('mismatch', 'overreach', 'elsewhere'))::int                  AS filtered_out,
            (SELECT MAX(updated_at) FROM jobs WHERE user_id = $1)                                       AS last_updated_at`,
    [userId]
  );

  const row = rows[0] || {};
  return {
    total: row.total || 0,
    internships: row.internships || 0,
    fullTime: row.full_time || 0,
    strongMatches: row.strong_matches || 0,
    averageScore: row.average_score === null || row.average_score === undefined ? null : Number(row.average_score),
    belowPayBar: row.below_pay_bar || 0,
    filteredOut: row.filtered_out || 0,
    lastUpdatedAt: row.last_updated_at || null,
  };
}

/**
 * @param {number} userId
 * @param {number} jobId
 * @returns {Promise<boolean>}
 */
async function deleteJob(userId, jobId) {
  const { rowCount } = await query('DELETE FROM jobs WHERE user_id = $1 AND id = $2', [userId, jobId]);
  return rowCount > 0;
}

/**
 * Clears one tenant's board (used by the dashboard's "clear" action).
 *
 * @param {number} userId
 * @returns {Promise<number>} rows removed
 */
async function deleteAllJobs(userId) {
  const { rowCount } = await query('DELETE FROM jobs WHERE user_id = $1', [userId]);
  return rowCount;
}

/**
 * Closes the pool (graceful shutdown, and so test scripts can exit).
 * @returns {Promise<void>}
 */
async function close() {
  await pool.end();
}

module.exports = {
  pool,
  query,
  initDatabase,
  // users
  createUser,
  findUserByUsername,
  findUserById,
  listUsers,
  // resumes
  addResume,
  getResumes,
  getResumeSummaries,
  getResumeById,
  deleteResume,
  // jobs
  upsertJob,
  jobExists,
  updateJobMatchData,
  getJobs,
  getUnmatchedJobs,
  getStats,
  deleteJob,
  deleteAllJobs,
  close,
};
