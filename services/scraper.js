const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { insertJob } = require('./database');
const { matchJob } = require('./matcher');

async function runScraper() {
    console.log("Starting job scraper...");
    try {
        const htmlPath = path.resolve(__dirname, '../mock-job-board.html');
        const html = fs.readFileSync(htmlPath, 'utf-8');
        const $ = cheerio.load(html);

        const jobsToProcess = [];

        $('.job-listing').each((index, element) => {
            const title = $(element).find('.job-title').text().trim();
            const company = $(element).find('.company-name').text().trim();
            const description = $(element).find('.job-description').text().trim();
            const datePosted = $(element).find('.date-posted').text().trim();
            const applyUrl = $(element).find('.apply-btn').attr('href');

            if (title && applyUrl) {
                jobsToProcess.push({
                    title,
                    company,
                    description,
                    datePosted,
                    applyUrl
                });
            }
        });

        console.log(`Found ${jobsToProcess.length} jobs to process.`);

        for (const job of jobsToProcess) {
            console.log(`\nProcessing: ${job.title} at ${job.company}`);

            const matchResult = await matchJob(job.description);
            job.score = matchResult.score;
            job.reason = matchResult.reason;

            const dbResult = await insertJob(job);

            if (dbResult.status === 'duplicate') {
                console.log(`Skipped duplicate job: ${job.applyUrl}`);
            } else {
                console.log(`Saved job with ID: ${dbResult.id}. Score: ${job.score}`);
            }
        }

        console.log("Scraping and matching complete.");

    } catch (error) {
        console.error("Error running scraper:", error.message);
    }
}

module.exports = {
    runScraper
};