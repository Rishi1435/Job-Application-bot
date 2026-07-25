/**
 * Dashboard front-end.
 *
 *  - loads jobs + stats from the API
 *  - client-side search, minimum-score filter and column sorting
 *  - exports whatever is currently on screen to .xlsx (SheetJS), with a CSV
 *    fallback if the SheetJS CDN is unavailable
 *
 * Rows are built with DOM APIs and textContent rather than innerHTML, because
 * every value here originates from a third-party job board.
 */

document.addEventListener('DOMContentLoaded', () => {
    const els = {
        tableBody: document.getElementById('jobsTableBody'),
        table: document.getElementById('jobsTable'),
        exportBtn: document.getElementById('exportBtn'),
        scrapeBtn: document.getElementById('scrapeBtn'),
        search: document.getElementById('searchInput'),
        minScore: document.getElementById('minScore'),
        minScoreValue: document.getElementById('minScoreValue'),
        resultCount: document.getElementById('resultCount'),
        subtitle: document.getElementById('subtitle'),
        footerStatus: document.getElementById('footerStatus'),
        toast: document.getElementById('toast'),
        statTotal: document.getElementById('statTotal'),
        statStrong: document.getElementById('statStrong'),
        statAverage: document.getElementById('statAverage'),
        statLastRun: document.getElementById('statLastRun'),
    };

    /** Every job returned by the API. */
    let allJobs = [];
    /** The filtered + sorted subset currently rendered (and exported). */
    let visibleJobs = [];
    /** Active sort; the dashboard opens on best-match-first. */
    let sort = { key: 'score', direction: 'desc' };

    /* -------------------------------------------------- helpers */

    /**
     * Shows a transient message in the bottom-right corner.
     * @param {string} message
     * @param {'info'|'error'} [type]
     */
    function toast(message, type = 'info') {
        els.toast.textContent = message;
        els.toast.classList.toggle('error', type === 'error');
        els.toast.classList.add('show');
        clearTimeout(toast.timer);
        toast.timer = setTimeout(() => els.toast.classList.remove('show'), 4000);
    }

    /**
     * Formats an ISO timestamp as a readable local date-time.
     * @param {string|null} value
     * @returns {string}
     */
    function formatDateTime(value) {
        if (!value) return 'Never';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    }

    /**
     * Maps a score onto a badge colour class.
     * @param {number|null} score
     * @returns {string}
     */
    function scoreClass(score) {
        if (!Number.isFinite(score)) return 'score-none';
        if (score >= 70) return 'score-high';
        if (score >= 45) return 'score-mid';
        return 'score-low';
    }

    /** Safe anchor targets only - never render a scraped `javascript:` URL. */
    function safeUrl(url) {
        try {
            const parsed = new URL(url, window.location.origin);
            return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
        } catch {
            return null;
        }
    }

    /* -------------------------------------------------- data */

    /**
     * Loads jobs and header statistics from the API.
     * @returns {Promise<void>}
     */
    async function loadJobs() {
        try {
            const [jobsRes, statsRes] = await Promise.all([fetch('/api/jobs'), fetch('/api/stats')]);
            if (!jobsRes.ok) throw new Error(`HTTP ${jobsRes.status}`);

            allJobs = await jobsRes.json();
            applyFilters();

            if (statsRes.ok) renderStats(await statsRes.json());
            els.footerStatus.textContent = `Loaded ${allJobs.length} job(s) at ${new Date().toLocaleTimeString()}.`;
        } catch (error) {
            console.error('Error fetching jobs:', error);
            renderEmpty('Failed to load jobs. Is the server running?');
            toast('Could not reach the API.', 'error');
        }
    }

    /** Loads scraper/scheduler metadata for the subtitle line. */
    async function loadStatus() {
        try {
            const response = await fetch('/api/status');
            if (!response.ok) return;
            const status = await response.json();
            const engine = status.matcher.llmEnabled ? status.matcher.model : 'offline keyword scoring';
            els.subtitle.textContent =
                `Target role: ${status.matcher.targetRole} · Scored by ${engine} · Cron "${status.cronSchedule}"`;
        } catch {
            /* Non-critical - leave the default subtitle in place. */
        }
    }

    /**
     * @param {{total:number, strongMatches:number, averageScore:number|null, lastSeenAt:string|null}} stats
     */
    function renderStats(stats) {
        els.statTotal.textContent = stats.total;
        els.statStrong.textContent = stats.strongMatches;
        els.statAverage.textContent = stats.averageScore === null ? '-' : `${stats.averageScore}%`;
        els.statLastRun.textContent = formatDateTime(stats.lastSeenAt);
    }

    /* -------------------------------------------------- filtering + sorting */

    /** Applies the search box and score slider, then re-sorts and renders. */
    function applyFilters() {
        const needle = els.search.value.trim().toLowerCase();
        const minScore = Number(els.minScore.value);

        visibleJobs = allJobs.filter((job) => {
            const score = Number(job.score) || 0;
            if (score < minScore) return false;
            if (!needle) return true;
            return (
                String(job.title || '').toLowerCase().includes(needle) ||
                String(job.company || '').toLowerCase().includes(needle)
            );
        });

        sortJobs();
        renderTable();
    }

    /** Sorts `visibleJobs` in place according to the active sort state. */
    function sortJobs() {
        const { key, direction } = sort;
        const factor = direction === 'asc' ? 1 : -1;

        visibleJobs.sort((a, b) => {
            if (key === 'score') {
                return ((Number(a.score) || 0) - (Number(b.score) || 0)) * factor;
            }
            if (key === 'datePosted') {
                const av = Date.parse(a.datePosted || a.firstSeenAt || '') || 0;
                const bv = Date.parse(b.datePosted || b.firstSeenAt || '') || 0;
                return (av - bv) * factor;
            }
            return String(a[key] || '').localeCompare(String(b[key] || '')) * factor;
        });
    }

    /* -------------------------------------------------- rendering */

    /** @param {string} message */
    function renderEmpty(message) {
        els.tableBody.replaceChildren();
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 5;
        cell.className = 'empty';
        cell.textContent = message;
        row.appendChild(cell);
        els.tableBody.appendChild(row);
        els.resultCount.textContent = '';
    }

    /** Renders `visibleJobs` into the table body. */
    function renderTable() {
        if (visibleJobs.length === 0) {
            renderEmpty(
                allJobs.length === 0
                    ? 'No jobs stored yet - hit "Run Scrape Now" to fetch and score some postings.'
                    : 'No jobs match the current filters.'
            );
            return;
        }

        const fragment = document.createDocumentFragment();

        visibleJobs.forEach((job) => {
            const row = document.createElement('tr');

            // --- Title (+ match reason and source badge)
            const titleCell = document.createElement('td');
            const title = document.createElement('span');
            title.className = 'job-title';
            title.textContent = job.title || 'Untitled role';
            titleCell.appendChild(title);

            if (job.reason) {
                const reason = document.createElement('span');
                reason.className = 'job-reason';
                reason.textContent = job.reason;
                titleCell.appendChild(reason);
            }

            if (job.sourceName) {
                const source = document.createElement('span');
                source.className = 'job-source';
                source.textContent = job.sourceName;
                titleCell.appendChild(source);
            }
            row.appendChild(titleCell);

            // --- Company
            const companyCell = document.createElement('td');
            companyCell.textContent = job.company || 'Unknown';
            row.appendChild(companyCell);

            // --- Score
            const scoreCell = document.createElement('td');
            const badge = document.createElement('span');
            const score = Number(job.score);
            badge.className = `score-badge ${scoreClass(score)}`;
            badge.textContent = Number.isFinite(score) ? `${score}%` : 'n/a';
            if (job.reason) badge.title = job.reason;
            scoreCell.appendChild(badge);
            row.appendChild(scoreCell);

            // --- Date
            const dateCell = document.createElement('td');
            dateCell.className = 'date-cell';
            dateCell.textContent = job.datePosted || (job.firstSeenAt ? job.firstSeenAt.slice(0, 10) : 'N/A');
            row.appendChild(dateCell);

            // --- Apply action
            const actionCell = document.createElement('td');
            const href = safeUrl(job.applyUrl);
            if (href) {
                const link = document.createElement('a');
                link.className = 'apply-link';
                link.href = href;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = 'Apply →';
                actionCell.appendChild(link);
            } else {
                actionCell.textContent = '—';
            }
            row.appendChild(actionCell);

            fragment.appendChild(row);
        });

        els.tableBody.replaceChildren(fragment);
        els.resultCount.textContent = `Showing ${visibleJobs.length} of ${allJobs.length} job(s)`;
    }

    /** Reflects the active sort in the table header arrows. */
    function updateSortIndicators() {
        els.table.querySelectorAll('th.sortable').forEach((th) => {
            th.classList.remove('sorted-asc', 'sorted-desc');
            if (th.dataset.sort === sort.key) {
                th.classList.add(sort.direction === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });
    }

    /* -------------------------------------------------- export */

    /**
     * Shapes the visible jobs into flat rows for the spreadsheet.
     * @returns {Array<object>}
     */
    function buildExportRows() {
        return visibleJobs.map((job) => ({
            'Job Title': job.title || '',
            Company: job.company || '',
            'Match Score (%)': Number.isFinite(Number(job.score)) ? Number(job.score) : '',
            'Match Reason': job.reason || '',
            'Date Posted': job.datePosted || '',
            'Apply Link': job.applyUrl || '',
            Source: job.sourceName || '',
            'First Seen': job.firstSeenAt || '',
            Description: job.description || '',
        }));
    }

    /** Downloads the visible jobs as .xlsx, or CSV when SheetJS is unavailable. */
    function exportJobs() {
        if (visibleJobs.length === 0) {
            toast('Nothing to export - the table is empty.', 'error');
            return;
        }

        const rows = buildExportRows();
        const filename = `job-matches-${new Date().toISOString().slice(0, 10)}`;

        if (typeof XLSX === 'undefined') {
            exportCsv(rows, `${filename}.csv`);
            toast('SheetJS did not load; exported CSV instead.');
            return;
        }

        const worksheet = XLSX.utils.json_to_sheet(rows);
        worksheet['!cols'] = [
            { wch: 42 }, { wch: 24 }, { wch: 15 }, { wch: 60 },
            { wch: 13 }, { wch: 46 }, { wch: 22 }, { wch: 22 }, { wch: 80 },
        ];

        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Job Matches');
        XLSX.writeFile(workbook, `${filename}.xlsx`);
        toast(`Exported ${rows.length} job(s) to Excel.`);
    }

    /**
     * Minimal RFC-4180 CSV writer used as the offline fallback.
     * @param {Array<object>} rows
     * @param {string} filename
     */
    function exportCsv(rows, filename) {
        const headers = Object.keys(rows[0]);
        const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const csv = [headers.join(','), ...rows.map((row) => headers.map((h) => escape(row[h])).join(','))].join('\r\n');

        const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    }

    /* -------------------------------------------------- events */

    els.search.addEventListener('input', applyFilters);

    els.minScore.addEventListener('input', () => {
        els.minScoreValue.textContent = els.minScore.value;
        applyFilters();
    });

    els.table.querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (sort.key === key) {
                sort.direction = sort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                // Scores read best high-to-low; text columns read best A-Z.
                sort = { key, direction: key === 'score' || key === 'datePosted' ? 'desc' : 'asc' };
            }
            updateSortIndicators();
            sortJobs();
            renderTable();
        });
    });

    els.exportBtn.addEventListener('click', exportJobs);

    els.scrapeBtn.addEventListener('click', async () => {
        els.scrapeBtn.disabled = true;
        els.scrapeBtn.textContent = 'Scraping...';
        els.footerStatus.textContent = 'Scraping and scoring - this can take a minute.';

        try {
            const response = await fetch('/api/scrape', { method: 'POST' });
            const result = await response.json();

            if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);

            toast(`Scrape ${result.status}: ${result.inserted} new, ${result.duplicates} already seen.`);
            if (result.errors?.length) {
                console.warn('Scrape reported errors:', result.errors);
                els.footerStatus.textContent = `Completed with ${result.errors.length} source error(s) - see server logs.`;
            }
            await loadJobs();
        } catch (error) {
            console.error(error);
            toast(`Scrape failed: ${error.message}`, 'error');
            els.footerStatus.textContent = `Scrape failed: ${error.message}`;
        } finally {
            els.scrapeBtn.disabled = false;
            els.scrapeBtn.textContent = 'Run Scrape Now';
        }
    });

    /* -------------------------------------------------- boot */

    updateSortIndicators();
    loadJobs();
    loadStatus();
});
