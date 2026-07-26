#!/usr/bin/env node
/**
 * Deletes stored postings the current bars would never have saved.
 *
 * The write path only started refusing weak matches when MIN_MATCH_SCORE
 * arrived, and the crawl only started spreading across employers when the
 * per-company cap did. Everything stored before that is still in the table, and
 * on a database that has been crawled for a while it is the majority of it -
 * hundreds of 15% rows from a handful of companies. `getJobs()` hides them, so
 * this is housekeeping rather than a fix, but a board carrying ten times more
 * dead rows than live ones is slow to query and impossible to reason about.
 *
 * Nothing is deleted without `--apply`: a threshold is easy to set wrongly and
 * a posting cannot be re-fetched once its board takes it down.
 *
 * Usage:
 *   node scripts/prune.js                    # report what would go
 *   node scripts/prune.js --apply            # delete it
 *   node scripts/prune.js --user 24 --apply  # one tenant
 *   node scripts/prune.js --score 40 --apply # a floor other than MIN_MATCH_SCORE
 *   node scripts/prune.js --keep-per-company 5 --apply
 *                                            # also thin employers that dominate
 */

require('dotenv').config();

const db = require('../services/database');

const MIN_MATCH_SCORE = Number(process.env.MIN_MATCH_SCORE || 50);

/**
 * Parses the command line.
 * @returns {{userId:number|null, apply:boolean, score:number, keepPerCompany:number|null}}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const perCompany = Number(value('--keep-per-company'));
  const score = Number(value('--score'));

  return {
    userId: args.includes('--user') ? Number(value('--user')) : null,
    apply: args.includes('--apply'),
    score: Number.isFinite(score) ? score : MIN_MATCH_SCORE,
    keepPerCompany: Number.isFinite(perCompany) && perCompany > 0 ? perCompany : null,
  };
}

/**
 * Rows scoring under the floor, per tenant and company, so the report says what
 * is actually being removed rather than a single number.
 *
 * @param {number|null} userId
 * @param {number} score
 * @returns {Promise<Array<{user_id:number, company:string, n:number, worst:number, best:number}>>}
 */
async function weakRows(userId, score) {
  const { rows } = await db.query(
    `SELECT user_id, COALESCE(company, '(unknown)') AS company, COUNT(*)::int AS n,
            MIN(COALESCE((match_data->>'score')::numeric, 0))::int AS worst,
            MAX(COALESCE((match_data->>'score')::numeric, 0))::int AS best
       FROM jobs
      WHERE COALESCE((match_data->>'score')::numeric, 0) < $1
        AND ($2::int IS NULL OR user_id = $2)
      GROUP BY user_id, company
      ORDER BY n DESC`,
    [score, userId]
  );
  return rows;
}

/**
 * Ids beyond the Nth best-scoring posting of each employer, for a tenant.
 *
 * Kept separate from the score sweep because it is the more opinionated of the
 * two: these rows cleared the bar, they are only crowding the board.
 *
 * @param {number|null} userId
 * @param {number} keep
 * @returns {Promise<Array<{id:number, user_id:number, company:string}>>}
 */
async function crowdedRows(userId, keep) {
  const { rows } = await db.query(
    `WITH ranked AS (
       SELECT id, user_id, COALESCE(company, '(unknown)') AS company,
              ROW_NUMBER() OVER (
                PARTITION BY user_id, LOWER(COALESCE(company, ''))
                ORDER BY COALESCE((match_data->>'score')::numeric, 0) DESC, created_at DESC
              ) AS rank
         FROM jobs
        WHERE ($2::int IS NULL OR user_id = $2)
     )
     SELECT id, user_id, company FROM ranked WHERE rank > $1`,
    [keep, userId]
  );
  return rows;
}

/** Entry point. */
async function main() {
  const options = parseArgs();

  await db.initDatabase();

  if (options.userId !== null && !Number.isFinite(options.userId)) {
    console.error('--user needs a numeric user id.');
    process.exitCode = 1;
    await db.close();
    return;
  }

  const before = await db.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT company)::int AS companies FROM jobs
      WHERE ($1::int IS NULL OR user_id = $1)`,
    [options.userId]
  );
  console.log(`${before.rows[0].n} posting(s) stored across ${before.rows[0].companies} compan(ies).\n`);

  /* --- under the score floor ---------------------------------------- */
  const weak = await weakRows(options.userId, options.score);
  const weakTotal = weak.reduce((sum, row) => sum + row.n, 0);

  console.log(`Under the ${options.score}% bar: ${weakTotal} posting(s)`);
  weak.slice(0, 12).forEach((row) => {
    console.log(`  user ${row.user_id}  ${String(row.n).padStart(4)}x  ${row.company} (${row.worst}-${row.best}%)`);
  });
  if (weak.length > 12) console.log(`  ... and ${weak.length - 12} more employer(s)`);

  /* --- over the per-company cap -------------------------------------- */
  let crowded = [];
  if (options.keepPerCompany) {
    crowded = await crowdedRows(options.userId, options.keepPerCompany);
    const employers = new Set(crowded.map((row) => `${row.user_id}:${row.company}`));
    console.log(
      `\nOver ${options.keepPerCompany} per employer: ${crowded.length} posting(s) across ${employers.size} employer(s)`
    );
  }

  if (!options.apply) {
    console.log('\nDRY RUN - nothing deleted. Re-run with --apply to remove these rows.');
    await db.close();
    return;
  }

  /* --- delete --------------------------------------------------------- */
  const weakDeleted = await db.query(
    `DELETE FROM jobs
      WHERE COALESCE((match_data->>'score')::numeric, 0) < $1
        AND ($2::int IS NULL OR user_id = $2)`,
    [options.score, options.userId]
  );

  let crowdedDeleted = 0;
  if (crowded.length) {
    // Re-selected after the score sweep so the ranking reflects what survives.
    const remaining = await crowdedRows(options.userId, options.keepPerCompany);
    if (remaining.length) {
      const result = await db.query('DELETE FROM jobs WHERE id = ANY($1::int[])', [remaining.map((row) => row.id)]);
      crowdedDeleted = result.rowCount;
    }
  }

  const after = await db.query(
    `SELECT COUNT(*)::int AS n, COUNT(DISTINCT company)::int AS companies FROM jobs
      WHERE ($1::int IS NULL OR user_id = $1)`,
    [options.userId]
  );

  console.log(
    `\nDeleted ${weakDeleted.rowCount} weak + ${crowdedDeleted} crowding row(s). ` +
      `${after.rows[0].n} posting(s) left across ${after.rows[0].companies} compan(ies).`
  );

  await db.close();
}

main().catch((error) => {
  console.error('[prune] Failed:', error.message);
  process.exit(1);
});
