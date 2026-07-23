const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { getAllJobs } = require('./services/database');
const { runScraper } = require('./services/scraper');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/jobs', async (req, res) => {
    try {
        const jobs = await getAllJobs();
        res.json(jobs);
    } catch (error) {
        console.error("Error fetching jobs:", error.message);
        res.status(500).json({ error: "Failed to retrieve jobs from the database." });
    }
});

cron.schedule('0 0 * * *', () => {
    console.log("Running scheduled job scraper...");
    runScraper();
});

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});