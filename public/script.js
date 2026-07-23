document.addEventListener('DOMContentLoaded', () => {
    const jobsTableBody = document.getElementById('jobsTableBody');
    const exportBtn = document.getElementById('exportBtn');

    let currentJobs = [];

    async function fetchJobs() {
        try {
            const response = await fetch('/api/jobs');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const jobs = await response.json();

            currentJobs = jobs.sort((a, b) => b.score - a.score);
            renderTable(currentJobs);
        } catch (error) {
            console.error('Error fetching jobs:', error);
            jobsTableBody.innerHTML = '<tr><td colspan="5">Failed to load jobs.</td></tr>';
        }
    }

    function renderTable(jobs) {
        jobsTableBody.innerHTML = '';

        if (jobs.length === 0) {
            jobsTableBody.innerHTML = '<tr><td colspan="5">No jobs found.</td></tr>';
            return;
        }

        jobs.forEach(job => {
            const tr = document.createElement('tr');

            tr.innerHTML = `
                <td>${job.title}</td>
                <td>${job.company}</td>
                <td>
                    <span class="reason-tooltip" title="${job.reason || 'No reason provided'}">
                        ${job.score}%
                    </span>
                </td>
                <td>${job.datePosted || 'N/A'}</td>
                <td>
                    <a href="${job.applyUrl}" target="_blank" class="apply-link">Apply</a>
                </td>
            `;

            jobsTableBody.appendChild(tr);
        });
    }

    exportBtn.addEventListener('click', () => {
        if (currentJobs.length === 0) {
            alert('No data to export.');
            return;
        }

        const exportData = currentJobs.map(job => ({
            'Job Title': job.title,
            'Company': job.company,
            'Match Score (%)': job.score,
            'Reason': job.reason,
            'Date Posted': job.datePosted,
            'Apply Link': job.applyUrl,
            'Description': job.description
        }));

        const worksheet = XLSX.utils.json_to_sheet(exportData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");

        XLSX.writeFile(workbook, 'job_matches.xlsx');
    });

    fetchJobs();
});