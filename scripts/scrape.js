#!/usr/bin/env node
/**
 * One-off scrape from the command line: `npm run scrape`.
 *
 * Runs the same pipeline as the nightly cron job and exits non-zero when the
 * run fails outright, so it can be wired to an OS cron entry or a Render cron
 * job without any extra glue.
 *
 * Usage:
 *   npm run scrape                    every registered user
 *   npm run scrape -- --user alice    one user (id or username)
 *   npm run scrape -- --rescore       re-run the matcher over stored postings
 *                                     that never got a match_data verdict
 */

require('dotenv').config();

const db = require('./../services/database');
const { runScraper } = require('../services/scraper');
const { matchJobsForUser } = require('../services/matcher');

/**
 * Minimal flag parser: `--user alice`, `--rescore`.
 * @param {Array<string>} argv
 * @returns {{user:string|null, rescore:boolean}}
 */
function parseArgs(argv) {
  const args = { user: null, rescore: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--user') args.user = argv[i + 1] || null;
    if (argv[i] === '--rescore') args.rescore = true;
  }
  return args;
}

/**
 * Resolves `--user` (id or username) to a user id.
 *
 * @param {string|null} value
 * @returns {Promise<Array<number>|null>} ids to process, or null for "all"
 */
async function resolveUsers(value) {
  if (!value) return null;

  if (/^\d+$/.test(value)) {
    const user = await db.findUserById(Number(value));
    if (!user) throw new Error(`No user with id ${value}.`);
    return [user.id];
  }

  const user = await db.findUserByUsername(value);
  if (!user) throw new Error(`No user named "${value}".`);
  return [user.id];
}

/**
 * Feeds previously unscored postings back through the matcher (e.g. rows saved
 * while the LLM was down, or before any resume had been uploaded).
 *
 * @param {Array<number>} userIds
 * @returns {Promise<number>} rows updated
 */
async function rescore(userIds) {
  let updated = 0;

  for (const userId of userIds) {
    const pending = await db.getUnmatchedJobs(userId, Number(process.env.RESCORE_LIMIT || 50));
    if (!pending.length) continue;

    const jobs = pending.map((row) => ({ title: row.title, company: row.company, description: row.description }));
    const verdicts = await matchJobsForUser(userId, jobs);

    for (let i = 0; i < pending.length; i += 1) {
      const { engine, ...matchData } = verdicts[i] || {};
      if (!matchData.job_type) continue;
      await db.updateJobMatchData(userId, pending[i].id, matchData);
      updated += 1;
    }

    console.log(`[rescore] user ${userId}: ${pending.length} posting(s) re-matched.`);
  }

  return updated;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  try {
    await db.initDatabase();

    const explicit = await resolveUsers(args.user);
    const userIds = explicit || (await db.listUsers()).map((user) => user.id);

    if (!userIds.length) {
      console.error('No users are registered yet - create an account in the dashboard first.');
      await db.close();
      process.exit(1);
    }

    if (args.rescore) {
      const updated = await rescore(userIds);
      console.log(`\nRe-scored ${updated} posting(s).`);
      await db.close();
      process.exit(0);
    }

    const summary = await runScraper({ trigger: 'manual', userIds });

    console.log('\n--- Scrape summary ---------------------------');
    console.log(`Status       : ${summary.status}`);
    console.log(`Postings     : ${summary.found} found across the trusted sources`);
    console.log(`Stored       : ${summary.inserted} new, ${summary.updated} refreshed`);
    console.log(`LLM scored   : ${summary.scored}`);
    console.log(`Users        : ${summary.users}`);
    if (summary.errors.length) {
      console.log('Errors       :');
      summary.errors.forEach((error) => console.log(`  - ${error}`));
    }

    for (const userId of userIds) {
      const stats = await db.getStats(userId);
      console.log(
        `\nUser ${userId}: ${stats.total} job(s) - ${stats.internships} internship(s), ` +
          `${stats.fullTime} full-time, ${stats.strongMatches} scoring 70+.`
      );
    }

    await db.close();
    process.exit(summary.status === 'failed' ? 1 : 0);
  } catch (error) {
    console.error('Scrape crashed:', error.message);
    await db.close().catch(() => {});
    process.exit(1);
  }
})();
