#!/usr/bin/env node
/**
 * Re-screens postings already in the database.
 *
 * Rows stored before the relevance gate existed carry no `match_data.relevance`
 * key, and `getJobs()` deliberately treats a missing key as "show it" so an
 * upgrade never blanks someone's board. The consequence is that an existing
 * board keeps showing the Director and sales roles the gate would now reject,
 * until this script backfills them.
 *
 * It also repairs two things that only the scraper used to handle:
 *   - apply URLs on hosts that 301 elsewhere, canonicalised in place
 *   - postings whose apply URL is unreachable by construction (*.example.com,
 *     reserved by RFC 2606), which came from the bundled demo board
 *
 * Scores are recomputed from the gate only - no LLM calls are made, so this is
 * free and instant. A capped row keeps whatever the model originally said in its
 * reason, prefixed with why the cap applied.
 *
 * Usage:
 *   node scripts/rescreen.js                 # every user
 *   node scripts/rescreen.js --user 24       # one tenant
 *   node scripts/rescreen.js --dry-run       # report only, change nothing
 *   node scripts/rescreen.js --keep-dead     # do not delete unreachable links
 */

require('dotenv').config();

const db = require('../services/database');
const { buildCandidateProfile, assessRelevance } = require('../services/relevance');
const { normalizeApplyUrl } = require('../services/scraper');

/** Hosts that cannot resolve, so a stored posting using one can never be applied to. */
const UNREACHABLE = /(^|\.)(example\.(com|org|net)|invalid|test|localhost)$/i;

/**
 * Parses the command line.
 * @returns {{userId:number|null, dryRun:boolean, keepDead:boolean}}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const userIndex = args.indexOf('--user');
  return {
    userId: userIndex >= 0 ? Number(args[userIndex + 1]) : null,
    dryRun: args.includes('--dry-run'),
    keepDead: args.includes('--keep-dead'),
  };
}

/**
 * Whether a stored apply URL points somewhere that can never load.
 * @param {string} url
 * @returns {boolean}
 */
function isUnreachable(url) {
  try {
    return UNREACHABLE.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/**
 * Re-screens one tenant's board.
 *
 * @param {{id:number, username:string}} user
 * @param {{dryRun:boolean, keepDead:boolean}} options
 * @returns {Promise<{screened:number, changed:number, deleted:number, relinked:number}>}
 */
async function rescreenUser(user, options) {
  const resumes = await db.getResumes(user.id);
  const jobs = await db.getJobs(user.id, { includeBelowBar: true, includeMismatch: true });
  const summary = { screened: 0, changed: 0, deleted: 0, relinked: 0 };

  console.log(`\n[user ${user.id}] ${user.username} - ${jobs.length} posting(s), ${resumes.length} resume(s)`);

  if (!resumes.length) {
    console.log('  no resumes uploaded; nothing to screen against.');
    return summary;
  }

  const profile = buildCandidateProfile(resumes);
  console.log(`  profile: ${profile.levelLabel}, families [${profile.families.join(', ')}]${profile.location ? `, ${profile.location}` : ''}`);

  const tally = {};

  for (const job of jobs) {
    /* --- dead links ------------------------------------------------ */
    if (!options.keepDead && isUnreachable(job.apply_url)) {
      if (!options.dryRun) await db.deleteJob(user.id, job.id);
      summary.deleted += 1;
      continue;
    }

    /* --- canonical links ------------------------------------------- */
    const canonical = normalizeApplyUrl(job.apply_url);
    if (canonical && canonical !== job.apply_url) {
      // A canonical URL can already exist on this tenant's board, and
      // (user_id, apply_url) is unique - so a collision means this row is the
      // duplicate and the other one is already correct.
      if (!options.dryRun) {
        const clash = await db.jobExists(user.id, canonical);
        if (clash) {
          await db.deleteJob(user.id, job.id);
          summary.deleted += 1;
          continue;
        }
        await db.query('UPDATE jobs SET apply_url = $3, updated_at = NOW() WHERE user_id = $1 AND id = $2', [
          user.id,
          job.id,
          canonical,
        ]);
      }
      summary.relinked += 1;
    }

    /* --- relevance -------------------------------------------------- */
    const relevance = assessRelevance(
      { title: job.title, description: job.description, location: job.location },
      profile
    );
    tally[relevance.fit] = (tally[relevance.fit] || 0) + 1;
    summary.screened += 1;

    const match = job.match_data || {};
    const previousScore = Number(match.score || 0);
    const cap = Number.isFinite(relevance.cap) ? relevance.cap : null;
    const score = cap === null ? previousScore : Math.min(previousScore, cap);

    let reason = String(match.reason || '');
    if (cap !== null && previousScore > cap && !reason.startsWith(relevance.note)) {
      reason = `${relevance.note} ${reason}`.trim().slice(0, 600);
    }

    const unchanged = match.relevance?.fit === relevance.fit && score === previousScore && reason === match.reason;
    if (unchanged) continue;

    if (!options.dryRun) {
      await db.updateJobMatchData(user.id, job.id, { ...match, score, reason, relevance });
    }
    summary.changed += 1;
  }

  const parts = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([fit, count]) => `${fit} ${count}`)
    .join(', ');

  console.log(`  screened ${summary.screened}: ${parts || 'nothing'}`);
  console.log(
    `  ${summary.changed} row(s) updated, ${summary.relinked} link(s) canonicalised, ${summary.deleted} unreachable row(s) removed`
  );

  return summary;
}

/** Entry point. */
async function main() {
  const options = parseArgs();

  if (options.dryRun) console.log('DRY RUN - no changes will be written.\n');

  await db.initDatabase();

  const users = await db.listUsers();
  const targets = options.userId ? users.filter((user) => user.id === options.userId) : users;

  if (!targets.length) {
    console.error(options.userId ? `No user with id ${options.userId}.` : 'No registered users.');
    process.exitCode = 1;
    await db.close();
    return;
  }

  const totals = { screened: 0, changed: 0, deleted: 0, relinked: 0 };
  for (const user of targets) {
    const summary = await rescreenUser(user, options);
    for (const key of Object.keys(totals)) totals[key] += summary[key];
  }

  console.log(
    `\nDone. ${totals.screened} posting(s) screened, ${totals.changed} updated, ` +
      `${totals.relinked} relinked, ${totals.deleted} removed.`
  );

  await db.close();
}

main().catch((error) => {
  console.error('[rescreen] Failed:', error.message);
  process.exit(1);
});
