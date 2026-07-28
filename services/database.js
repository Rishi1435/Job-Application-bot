/**
 * PostgreSQL persistence layer (multi-tenant).
 *
 * Every row in `resumes` and `jobs` belongs to exactly one user, and *every*
 * query touching those tables filters by `user_id`. That is the only tenancy
 * boundary in the app, so it is enforced here rather than in the route
 * handlers: a route cannot accidentally read another tenant's data because no
 * function exposed below will run without a user id.
 *
 * `ats_boards` is the one deliberate exception. It holds career-page addresses
 * the crawler discovered - public facts about employers, containing nothing a
 * user typed or uploaded - and it is shared on purpose: a board found while
 * scraping for one user is a board every user's run can then search. Nothing in
 * it is served to the browser per tenant.
 *
 * All statements are parameterised ($1, $2, ...) - no string interpolation of
 * user input anywhere.
 */

const { Pool } = require('pg');

const CONNECTION_STRING = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

// Read here rather than importing it from the matcher: the matcher already
// imports this module, and a cycle would leave the constant undefined.
const MIN_MATCH_SCORE = Number(process.env.MIN_MATCH_SCORE || 50);

/**
 * Whether a database host is reachable only from inside a private network.
 *
 * Two shapes count. A private or loopback IP literal is obvious. The subtler one
 * is a single-label hostname - `db`, `postgres`, or the `dpg-cvab12...-a` that
 * Render's *internal* connection string uses: a name with no dot cannot be a
 * public DNS name, so it can only resolve on a private network.
 *
 * @param {string} host
 * @returns {boolean}
 */
function isPrivateHost(host) {
  if (!host) return false;
  if (/^(localhost|host\.docker\.internal)$/i.test(host)) return true;
  if (/\.(internal|local|localdomain)$/i.test(host)) return true;

  // 10/8, 172.16/12, 192.168/16, 127/8 - the RFC 1918 and loopback ranges.
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (host === '::1') return true;

  return !host.includes('.');
}

/**
 * Render's managed Postgres terminates TLS with a certificate the Node client
 * does not trust out of the box, so external connections need
 * `rejectUnauthorized: false`. Internal connections (and local Docker) do not
 * offer TLS at all, and asking for it there is not a downgrade but an outright
 * failure to boot: "The server does not support SSL connections". Force either
 * way with DATABASE_SSL=true|false.
 *
 * @returns {false|{rejectUnauthorized:boolean}}
 */
function resolveSsl() {
  const explicit = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (explicit === 'true') return { rejectUnauthorized: false };
  if (explicit === 'false') return false;

  if (!CONNECTION_STRING) return false;
  if (/sslmode=disable/i.test(CONNECTION_STRING)) return false;

  try {
    if (isPrivateHost(new URL(CONNECTION_STRING).hostname)) return false;
  } catch {
    // Not a parseable URL (a libpq keyword string, say) - fall through to the
    // safe default of asking for TLS.
  }

  return { rejectUnauthorized: false };
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

  // Career pages the crawler has discovered. Shared across tenants by design -
  // see the module header. `ok = false` marks a board whose API stopped
  // answering, so a dead slug is remembered rather than retried every night.
  `CREATE TABLE IF NOT EXISTS ats_boards (
     id              SERIAL PRIMARY KEY,
     platform        VARCHAR(32)  NOT NULL,
     slug            VARCHAR(255) NOT NULL,
     company         VARCHAR(255),
     board_url       VARCHAR(512),
     discovered_via  VARCHAR(64),
     job_count       INTEGER      NOT NULL DEFAULT 0,
     ok              BOOLEAN      NOT NULL DEFAULT TRUE,
     last_scraped_at TIMESTAMPTZ,
     created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ats_boards_platform_slug ON ats_boards (platform, LOWER(slug))`,
  // The scrape queue is "healthy boards, least recently visited first".
  `CREATE INDEX IF NOT EXISTS idx_ats_boards_queue ON ats_boards (ok, last_scraped_at NULLS FIRST)`,

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
/**
 * Whether a failed connection is worth trying again.
 *
 * DNS and refused connections are the shape of "not ready yet" - on a platform
 * where the app container and the database start together, the database's
 * hostname can briefly not resolve. Bad credentials or a missing database are
 * the shape of "wrong", and no amount of waiting fixes them.
 *
 * @param {Error & {code?:string}} error
 * @returns {boolean}
 */
function isTransientConnectionError(error) {
  const code = error?.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(code)) {
    return true;
  }
  // Postgres is up but still starting: "the database system is starting up".
  if (code === '57P03') return true;
  // pg wraps parallel address failures; the useful code is on the first error.
  if (error?.errors?.length) return error.errors.some(isTransientConnectionError);
  return false;
}

/**
 * Turns a connection failure into a message that names its likely cause.
 *
 * `getaddrinfo ENOTFOUND dpg-...-a` is the one worth spelling out: it is not a
 * network blip but a hostname that does not exist for this container, which on a
 * managed platform nearly always means the database is in another region, or the
 * connection string was regenerated to point at a database that was replaced.
 *
 * @param {Error & {code?:string}} error
 * @returns {Error} the same error, with a fuller message when we can give one
 */
function describeConnectionFailure(error) {
  const host = (() => {
    try {
      return new URL(CONNECTION_STRING).hostname;
    } catch {
      return '';
    }
  })();

  if (error?.code === 'ENOTFOUND' && host && !host.includes('.')) {
    error.message =
      `${error.message} - "${host}" is a private hostname that does not resolve from here. ` +
      'On Render that means the database is in a different region from this service, or DATABASE_URL ' +
      'still points at a database that has been replaced. Use the database\'s External Connection String, ' +
      'or recreate one of the two so both sit in the same region.';
  }

  return error;
}

/**
 * Connects and creates the schema, waiting out a database that is not up yet.
 *
 * Exiting on the first failure makes a deploy fail for a condition that clears
 * itself in seconds: a container that starts before its database's hostname
 * resolves dies with `getaddrinfo ENOTFOUND`, the platform records a failed
 * deploy, and the next attempt succeeds for no visible reason.
 *
 * @param {{retries?:number, delayMs?:number}} [options]
 * @returns {Promise<void>}
 */
async function initDatabase(options = {}) {
  if (!CONNECTION_STRING) {
    throw new Error('DATABASE_URL is not set - point it at a PostgreSQL instance.');
  }

  const retries = Number.isFinite(options.retries) ? options.retries : Number(process.env.DB_CONNECT_RETRIES || 6);
  let delay = Number.isFinite(options.delayMs) ? options.delayMs : Number(process.env.DB_CONNECT_DELAY_MS || 1000);

  for (let attempt = 1; ; attempt += 1) {
    try {
      const client = await pool.connect();
      try {
        for (const statement of SCHEMA) {
          await client.query(statement);
        }
        console.log('[db] PostgreSQL schema ready.');
        return;
      } finally {
        client.release();
      }
    } catch (error) {
      if (attempt > retries || !isTransientConnectionError(error)) {
        throw describeConnectionFailure(error);
      }

      console.warn(
        `[db] ${error.code || error.message} - database not reachable yet ` +
          `(attempt ${attempt}/${retries}), retrying in ${delay}ms.`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 15000);
    }
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
 * Every apply URL these tenants have already stored.
 *
 * This is the deduplication set the crawler filters against *before* it opens
 * detail pages or calls the LLM. Checking one URL at a time with `jobExists`
 * would be a round trip per posting on a run that now discovers thousands, and
 * it happened after the expensive work rather than before it.
 *
 * @param {Array<number>} userIds tenants the run is storing for
 * @returns {Promise<Set<string>>}
 */
async function getKnownApplyUrls(userIds = []) {
  if (!userIds.length) return new Set();
  const { rows } = await query('SELECT DISTINCT apply_url FROM jobs WHERE user_id = ANY($1::int[])', [userIds]);
  return new Set(rows.map((row) => row.apply_url));
}

/**
 * Apply URLs that *every* tenant in the run already stores.
 *
 * The crawl is shared, so a posting can only be dropped before scoring when it
 * would be a duplicate for all of them - dropping URLs one tenant happens to
 * have would silently deny the posting to everyone else on the run.
 *
 * @param {Array<number>} userIds tenants the run is storing for
 * @returns {Promise<Set<string>>}
 */
async function getSharedApplyUrls(userIds = []) {
  if (!userIds.length) return new Set();
  const { rows } = await query(
    `SELECT apply_url
       FROM jobs
      WHERE user_id = ANY($1::int[])
      GROUP BY apply_url
     HAVING COUNT(DISTINCT user_id) = $2`,
    [userIds, userIds.length]
  );
  return new Set(rows.map((row) => row.apply_url));
}

/**
 * Company names these tenants already have postings from - used by
 * `scripts/scrape.js` to report how many genuinely new employers a run reached.
 *
 * @param {Array<number>} userIds
 * @returns {Promise<Set<string>>}
 */
async function getKnownCompanies(userIds = []) {
  if (!userIds.length) return new Set();
  const { rows } = await query(
    `SELECT DISTINCT LOWER(company) AS company FROM jobs WHERE user_id = ANY($1::int[]) AND company IS NOT NULL`,
    [userIds]
  );
  return new Set(rows.map((row) => row.company));
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
 * Weak matches are excluded the same way. The write path stopped storing them
 * when MIN_MATCH_SCORE arrived, but rows written before that are still in the
 * table - and a database that has been crawled for a while is mostly those.
 * Reading applies the floor too, so lowering the bar or importing older rows
 * cannot flood the board. Pass `minScore: 0` to audit everything.
 *
 * @param {number} userId
 * @param {{jobType?:string, minScore?:number, search?:string, limit?:number, includeBelowBar?:boolean, includeMismatch?:boolean}} [options]
 * @returns {Promise<Array<object>>}
 */
async function getJobs(userId, options = {}) {
  const params = [userId];
  const clauses = ['user_id = $1'];
  const floor = Number.isFinite(options.minScore) ? options.minScore : MIN_MATCH_SCORE;

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

  if (floor > 0) {
    params.push(floor);
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
          AND COALESCE((match_data->>'score')::numeric, 0) >= $2
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
            (SELECT COUNT(*) FROM jobs
              WHERE user_id = $1 AND COALESCE((match_data->>'score')::numeric, 0) < $2)::int            AS below_match_bar,
            (SELECT MAX(updated_at) FROM jobs WHERE user_id = $1)                                       AS last_updated_at`,
    [userId, MIN_MATCH_SCORE]
  );

  const row = rows[0] || {};
  return {
    total: row.total || 0,
    internships: row.internships || 0,
    fullTime: row.full_time || 0,
    strongMatches: row.strong_matches || 0,
    averageScore: row.average_score === null || row.average_score === undefined ? null : Number(row.average_score),
    belowPayBar: row.below_pay_bar || 0,
    belowMatchBar: row.below_match_bar || 0,
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

/* ------------------------------------------------------------------ */
/* Discovered ATS boards (shared, not per tenant)                      */
/* ------------------------------------------------------------------ */

/**
 * Records career pages the crawler found.
 *
 * Re-discovering a known board is the normal case (a dork returns the same
 * company every month), so the insert is a no-op upsert that only fills in
 * details the first discovery missed - it must never reset `last_scraped_at`,
 * or a board rediscovered nightly would be scraped nightly while the rest of
 * the registry starved.
 *
 * @param {Array<{platform:string, slug:string, company?:string, boardUrl?:string, via?:string}>} boards
 * @returns {Promise<number>} boards that were new to the registry
 */
async function recordBoards(boards = []) {
  let added = 0;

  for (const board of boards) {
    if (!board?.platform || !board?.slug) continue;
    const { rows } = await query(
      `INSERT INTO ats_boards (platform, slug, company, board_url, discovered_via)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform, LOWER(slug)) DO UPDATE
          SET company   = COALESCE(ats_boards.company, EXCLUDED.company),
              board_url = COALESCE(ats_boards.board_url, EXCLUDED.board_url)
       RETURNING (xmax = 0) AS inserted`,
      [
        String(board.platform).slice(0, 32),
        String(board.slug).slice(0, 255),
        board.company ? String(board.company).slice(0, 255) : null,
        board.boardUrl ? String(board.boardUrl).slice(0, 512) : null,
        board.via ? String(board.via).slice(0, 64) : null,
      ]
    );
    if (rows[0]?.inserted) added += 1;
  }

  return added;
}

/**
 * The next boards to visit: healthy ones, least recently scraped first, so the
 * registry is walked round-robin across runs instead of the same first N boards
 * being re-scraped every night.
 *
 * @param {{limit?:number, platforms?:Array<string>}} [options]
 * @returns {Promise<Array<{id:number, platform:string, slug:string, company:string|null, board_url:string|null}>>}
 */
async function getBoardsToScrape(options = {}) {
  const params = [Math.max(1, options.limit || 40)];
  let platformClause = '';

  if (options.platforms?.length) {
    params.push(options.platforms);
    platformClause = `AND platform = ANY($${params.length}::text[])`;
  }

  const { rows } = await query(
    `SELECT id, platform, slug, company, board_url
       FROM ats_boards
      WHERE ok = TRUE ${platformClause}
      ORDER BY last_scraped_at NULLS FIRST, job_count DESC, id
      LIMIT $1`,
    params
  );
  return rows;
}

/**
 * Marks a board visited. A board whose API answers but returns nothing is left
 * healthy (companies do pause hiring); only a hard failure retires it.
 *
 * @param {string} platform
 * @param {string} slug
 * @param {{jobCount?:number, ok?:boolean, company?:string}} [result]
 * @returns {Promise<void>}
 */
async function markBoardScraped(platform, slug, result = {}) {
  await query(
    `UPDATE ats_boards
        SET last_scraped_at = NOW(),
            job_count       = COALESCE($3, job_count),
            ok              = COALESCE($4, ok),
            company         = COALESCE($5, company)
      WHERE platform = $1 AND LOWER(slug) = LOWER($2)`,
    [
      platform,
      slug,
      Number.isFinite(result.jobCount) ? result.jobCount : null,
      typeof result.ok === 'boolean' ? result.ok : null,
      result.company ? String(result.company).slice(0, 255) : null,
    ]
  );
}

/**
 * Registry size, for the status endpoint and the CLI summary.
 *
 * @returns {Promise<{total:number, healthy:number, scraped:number, byPlatform:Record<string, number>}>}
 */
async function getBoardStats() {
  const { rows } = await query(
    `SELECT platform,
            COUNT(*)::int                                        AS total,
            COUNT(*) FILTER (WHERE ok)::int                      AS healthy,
            COUNT(*) FILTER (WHERE last_scraped_at IS NOT NULL)::int AS scraped
       FROM ats_boards
      GROUP BY platform`
  );

  const stats = { total: 0, healthy: 0, scraped: 0, byPlatform: {} };
  for (const row of rows) {
    stats.total += row.total;
    stats.healthy += row.healthy;
    stats.scraped += row.scraped;
    stats.byPlatform[row.platform] = row.total;
  }
  return stats;
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
  isTransientConnectionError,
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
  getKnownApplyUrls,
  getSharedApplyUrls,
  getKnownCompanies,
  updateJobMatchData,
  getJobs,
  getUnmatchedJobs,
  getStats,
  deleteJob,
  deleteAllJobs,
  // discovered boards
  recordBoards,
  getBoardsToScrape,
  markBoardScraped,
  getBoardStats,
  close,
};
