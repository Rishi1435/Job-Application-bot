#!/usr/bin/env node
/**
 * Loads a starting set of ATS boards into an empty registry.
 *
 * Discovery is cumulative: every run adds companies to `ats_boards`, and the
 * ATS channel walks what is already there. A brand-new database has none, so
 * the first runs can only see whatever the feeds happen to name that day -
 * which in practice is Hacker News' "Who is hiring?" thread, and that is almost
 * entirely US startups. A candidate outside the US then watches the location
 * gate reject nearly everything, and concludes the bot is broken.
 *
 * [data/boards.seed.json](../data/boards.seed.json) is not a source list: it is
 * the output of previous crawls, and every board in it was discovered by the
 * search and feed channels rather than chosen by hand. Seeding it just means a
 * new deployment does not have to rediscover the same companies before it can
 * be useful. The crawl keeps adding to it either way, and nothing here limits
 * what it may find.
 *
 * Usage:
 *   node scripts/seed-boards.js              # add any that are missing
 *   node scripts/seed-boards.js --dry-run    # report only
 *   node scripts/seed-boards.js --file x.json
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const db = require('../services/database');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'boards.seed.json');

/**
 * Parses the command line.
 * @returns {{file:string, dryRun:boolean}}
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--file');
  return {
    file: index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : DEFAULT_FILE,
    dryRun: args.includes('--dry-run'),
  };
}

/**
 * Reads the seed file.
 *
 * @param {string} file
 * @returns {Array<{platform:string, slug:string, company?:string, boardUrl?:string}>}
 */
function readSeed(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file} must contain an array of boards.`);
  return parsed.filter((board) => board?.platform && board?.slug);
}

/**
 * Adds every board in the seed file that the registry does not already have.
 *
 * Safe to run repeatedly: `recordBoards` upserts and never resets a board's
 * `last_scraped_at`, so seeding an established registry changes nothing about
 * the order boards are visited in.
 *
 * @param {{file?:string, dryRun?:boolean}} [options]
 * @returns {Promise<{seeded:number, added:number, total:number}>}
 */
async function seedBoards(options = {}) {
  const file = options.file || DEFAULT_FILE;
  const boards = readSeed(file);
  const before = await db.getBoardStats();

  if (options.dryRun) {
    return { seeded: boards.length, added: 0, total: before.total };
  }

  const added = await db.recordBoards(boards.map((board) => ({ ...board, via: 'seed' })));
  const after = await db.getBoardStats();
  return { seeded: boards.length, added, total: after.total };
}

/** Entry point. */
async function main() {
  const options = parseArgs();
  await db.initDatabase();

  const summary = await seedBoards(options);

  if (options.dryRun) {
    console.log(`DRY RUN - ${summary.seeded} board(s) in the seed, ${summary.total} already in the registry.`);
  } else {
    console.log(
      `Seeded ${summary.seeded} board(s): ${summary.added} new, ` +
        `${summary.seeded - summary.added} already known. Registry now holds ${summary.total}.`
    );
  }

  await db.close();
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[seed-boards] Failed:', error.message);
    process.exit(1);
  });
}

module.exports = { seedBoards, readSeed };
