#!/usr/bin/env node
/**
 * One-off scrape from the command line: `npm run scrape`.
 *
 * Runs exactly the same pipeline as the nightly cron job, prints a summary and
 * exits with a non-zero code when the run fails outright. Useful for seeding
 * the database before starting the server, or for a cron entry at the OS level.
 */

require('dotenv').config();

const { runScraper } = require('../services/scraper');
const { initDatabase, getStats, close } = require('../services/database');

(async () => {
  try {
    await initDatabase();
    const summary = await runScraper({ trigger: 'manual' });
    const stats = await getStats();

    console.log('\n--- Scrape summary ---------------------------');
    console.log(`Status      : ${summary.status}`);
    console.log(`Found       : ${summary.found}`);
    console.log(`New saved   : ${summary.inserted}`);
    console.log(`Already seen: ${summary.duplicates}`);
    console.log(`LLM scored  : ${summary.scored}`);
    if (summary.errors.length) {
      console.log('Errors      :');
      summary.errors.forEach((error) => console.log(`  - ${error}`));
    }
    console.log(`\nDatabase now holds ${stats.total} job(s), ${stats.strongMatches} scoring 70+.`);

    await close();
    process.exit(summary.status === 'failed' ? 1 : 0);
  } catch (error) {
    console.error('Scrape crashed:', error);
    process.exit(1);
  }
})();
