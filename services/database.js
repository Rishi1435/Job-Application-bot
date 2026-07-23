const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../jobs.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.run(`
            CREATE TABLE IF NOT EXISTS jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                company TEXT NOT NULL,
                description TEXT,
                applyUrl TEXT UNIQUE NOT NULL,
                datePosted TEXT,
                score INTEGER,
                reason TEXT
            )
        `);
    }
});

function insertJob(job) {
    return new Promise((resolve, reject) => {
        const sql = `
            INSERT INTO jobs (title, company, description, applyUrl, datePosted, score, reason)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        db.run(sql, [job.title, job.company, job.description, job.applyUrl, job.datePosted, job.score, job.reason], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    resolve({ status: 'duplicate', message: 'Job already exists' });
                } else {
                    reject(err);
                }
            } else {
                resolve({ status: 'inserted', id: this.lastID });
            }
        });
    });
}

function getAllJobs() {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM jobs ORDER BY score DESC, datePosted DESC`;
        db.all(sql, [], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

module.exports = {
    insertJob,
    getAllJobs,
    db
};