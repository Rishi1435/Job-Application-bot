/**
 * Dashboard front-end (vanilla JS, no build step).
 *
 *  - login / registration, keeping the JWT in localStorage
 *  - resume uploads (multi-file PDF / DOCX / TXT)
 *  - the candidate profile the relevance gate screens against
 *  - a tabbed card board (Internships vs Full-Time) with search, score filter,
 *    sorting, and toggles for the two things the server hides by default
 *  - Excel export of the *active tab only*, via SheetJS (CSV fallback)
 *
 * Cards are built with DOM APIs and textContent rather than innerHTML, because
 * every job value here originates from a third-party career page.
 *
 * Every API call goes through `api()`, which attaches the bearer token and
 * signs the user out on a 401, so an expired session cannot leave the UI in a
 * half-authenticated state.
 *
 * Animation lives in motion.js (`window.Motion`) - see the notes there on why
 * the Framer Motion primitives are reimplemented rather than imported.
 */

(() => {
    'use strict';

    const TOKEN_KEY = 'jobbot.token';
    const THEME_KEY = 'jobbot.theme';
    const TABS = { INTERNSHIP: 'Internship', FULL_TIME: 'Full-Time Job' };
    /** How often the open dashboard checks whether the scheduled scrape stored anything new. */
    const REFRESH_INTERVAL_MS = 60000;
    /** How closely a manually started scrape is followed, and for how long. */
    const SCRAPE_POLL_MS = 4000;
    const SCRAPE_TIMEOUT_MS = 600000;

    const M = window.Motion;

    const state = {
        token: localStorage.getItem(TOKEN_KEY),
        user: null,
        /** @type {Array<object>} the whole board; tabs filter it client-side */
        jobs: [],
        profile: null,
        tab: TABS.INTERNSHIP,
        sort: 'score',
        authMode: 'login',
        /** `updated_at` high-water mark, so a poll only redraws on real change. */
        lastUpdatedAt: null,
        refreshTimer: null,
        /** Suppresses entrance animations on a redraw the user did not initiate. */
        firstRender: true,
    };

    const $ = (id) => document.getElementById(id);

    const el = {
        bootView: $('bootView'),
        authView: $('authView'),
        authForm: $('authForm'),
        authUsername: $('authUsername'),
        authPassword: $('authPassword'),
        authError: $('authError'),
        authSubmit: $('authSubmit'),
        authHint: $('authHint'),
        authThumb: $('authThumb'),

        appView: $('appView'),
        userChip: $('userChip'),
        avatar: $('avatar'),
        subtitle: $('subtitle'),
        logoutBtn: $('logoutBtn'),
        scrapeBtn: $('scrapeBtn'),
        exportBtn: $('exportBtn'),
        themeBtn: $('themeBtn'),
        themeIcon: $('themeIcon'),

        profileStrip: $('profileStrip'),
        profileLevel: $('profileLevel'),
        profileChips: $('profileChips'),
        profileNote: $('profileNote'),

        statTotal: $('statTotal'),
        statInternships: $('statInternships'),
        statFullTime: $('statFullTime'),
        statStrong: $('statStrong'),
        statAverage: $('statAverage'),
        statFiltered: $('statFiltered'),

        fileDrop: $('fileDrop'),
        resumeInput: $('resumeInput'),
        uploadBtn: $('uploadBtn'),
        resumeList: $('resumeList'),
        resumeCount: $('resumeCount'),

        jobThumb: $('jobThumb'),
        searchInput: $('searchInput'),
        minScore: $('minScore'),
        minScoreValue: $('minScoreValue'),
        sortSelect: $('sortSelect'),
        includeBelowBar: $('includeBelowBar'),
        includeMismatch: $('includeMismatch'),
        payBarLabel: $('payBarLabel'),
        resultCount: $('resultCount'),
        jobList: $('jobList'),
        tabCountInternship: $('tabCountInternship'),
        tabCountFullTime: $('tabCountFullTime'),
        footerStatus: $('footerStatus'),
        toastStack: $('toastStack'),
    };

    /* -------------------------------------------------------------- */
    /* Utilities                                                       */
    /* -------------------------------------------------------------- */

    const TOAST_ICONS = { success: '✓', error: '!', info: 'i' };

    /**
     * Shows a transient message. Toasts stack and expire independently, so a
     * batch upload reporting three bad files shows three of them.
     *
     * @param {string} message
     * @param {'info'|'success'|'error'} [type]
     */
    function toast(message, type = 'info') {
        const node = element('div', { className: `toast toast-${type}` });
        node.append(
            element('span', { className: 'toast-icon', text: TOAST_ICONS[type] || TOAST_ICONS.info }),
            element('span', { text: message })
        );

        el.toastStack.append(node);
        M.enter(node, { from: { opacity: 0, transform: 'translateX(24px) scale(0.96)' }, to: { opacity: 1, transform: 'none' } });

        setTimeout(() => {
            M.exit(node, { from: { opacity: 0, transform: 'translateX(24px)' }, to: { opacity: 1, transform: 'none' } });
        }, 4500);
    }

    /**
     * Creates an element with text and classes in one call.
     * @param {string} tag
     * @param {{text?:string, className?:string, attrs?:Record<string,string>}} [options]
     * @returns {HTMLElement}
     */
    function element(tag, options = {}) {
        const node = document.createElement(tag);
        if (options.className) node.className = options.className;
        if (options.text !== undefined) node.textContent = options.text;
        for (const [name, value] of Object.entries(options.attrs || {})) node.setAttribute(name, value);
        return node;
    }

    /**
     * Fetch wrapper: adds the bearer token, parses JSON and turns API errors
     * into thrown `Error`s so callers can just try/catch.
     *
     * @param {string} path
     * @param {RequestInit} [options]
     * @returns {Promise<any>}
     */
    async function api(path, options = {}) {
        const headers = { ...(options.headers || {}) };
        if (state.token) headers.Authorization = `Bearer ${state.token}`;
        // FormData must set its own multipart boundary.
        if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';

        const response = await fetch(path, { ...options, headers });

        if (response.status === 401 && state.token) {
            signOut('Session expired - please sign in again.');
            throw new Error('Session expired.');
        }

        const payload = response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
        return payload;
    }

    /** `match_data` is JSONB and is absent on rows stored before scoring. */
    const matchOf = (job) => job.match_data || {};

    /**
     * Pay as shown on the card and in the export. Mirrors `formatCompensation()`
     * on the server so both read identically.
     *
     * @param {object} job
     * @returns {string}
     */
    function payLabel(job) {
        const comp = matchOf(job).compensation || {};
        if (!comp.stated || !Number.isFinite(Number(comp.max_lpa))) return 'Pay not stated';

        // A US salary converted at 88 INR/USD lands around 150-390 LPA, and
        // "151.4-387.2" reads as noise. Whole lakhs are as precise as an FX
        // conversion deserves; the quoted source text is on the tooltip.
        const round = (value) => {
            const number = Number(value);
            if (!Number.isFinite(number)) return null;
            return number >= 10 ? Math.round(number) : Math.round(number * 10) / 10;
        };

        const min = round(comp.min_lpa);
        const max = round(comp.max_lpa);
        const range = min === null || min === max ? `${max}` : `${min}-${max}`;
        const kind = comp.type === 'ctc' ? ' CTC' : comp.type === 'stipend' ? ' stipend' : '';
        return `${range} LPA${kind}`;
    }

    /** Tooltip for the pay figure: the bar verdict plus the text it came from. */
    function payTitle(job) {
        const match = matchOf(job);
        const raw = match.compensation?.raw;
        return [match.pay_note, raw ? `Quoted as: ${raw}` : ''].filter(Boolean).join('\n');
    }

    /** Numeric pay for sorting; unstated pay sorts last. */
    const payValue = (job) => Number(matchOf(job).compensation?.max_lpa ?? -1);

    /* -------------------------------------------------------------- */
    /* Theme                                                           */
    /* -------------------------------------------------------------- */

    /**
     * Applies a theme and remembers it.
     * @param {'dark'|'light'} theme
     */
    function setTheme(theme) {
        document.documentElement.dataset.theme = theme;
        localStorage.setItem(THEME_KEY, theme);
        el.themeIcon.textContent = theme === 'dark' ? '🌙' : '☀️';
    }

    /** Restores the saved theme, falling back to the OS preference. */
    function initTheme() {
        const saved = localStorage.getItem(THEME_KEY);
        const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
        setTheme(saved || (prefersLight ? 'light' : 'dark'));
    }

    /* -------------------------------------------------------------- */
    /* Authentication                                                  */
    /* -------------------------------------------------------------- */

    /**
     * Switches between the sign-in and register forms.
     * @param {'login'|'register'} mode
     */
    function setAuthMode(mode) {
        state.authMode = mode;
        el.authError.hidden = true;
        el.authSubmit.querySelector('.btn-label').textContent = mode === 'login' ? 'Sign in' : 'Create account';
        el.authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
        el.authHint.innerHTML =
            mode === 'login'
                ? 'New here? Switch to <strong>Create account</strong> to get started.'
                : 'Passwords need at least 8 characters. Your resumes stay private to your account.';

        let active = null;
        document.querySelectorAll('[data-auth-tab]').forEach((tab) => {
            const isActive = tab.dataset.authTab === mode;
            tab.classList.toggle('is-active', isActive);
            tab.setAttribute('aria-selected', String(isActive));
            if (isActive) active = tab;
        });

        M.moveIndicator(el.authThumb, active);
    }

    /**
     * Submits the login/registration form.
     * @param {SubmitEvent} event
     */
    async function onAuthSubmit(event) {
        event.preventDefault();

        const username = el.authUsername.value.trim();
        const password = el.authPassword.value;
        const label = el.authSubmit.querySelector('.btn-label');

        el.authError.hidden = true;
        el.authSubmit.disabled = true;
        label.textContent = state.authMode === 'login' ? 'Signing in…' : 'Creating account…';

        try {
            const result = await api(`/api/auth/${state.authMode}`, {
                method: 'POST',
                body: JSON.stringify({ username, password }),
            });

            state.token = result.token;
            state.user = result.user;
            localStorage.setItem(TOKEN_KEY, result.token);

            el.authForm.reset();
            await showDashboard();
            toast(`Welcome, ${result.user.username}.`, 'success');
        } catch (error) {
            // Signing in with credentials that were never registered is the
            // commonest way to land here, and "Sign in" is the default tab.
            const wrongTab = state.authMode === 'login' && /invalid username or password/i.test(error.message);
            el.authError.textContent = wrongTab
                ? `${error.message} If you have not registered yet, switch to "Create account" above.`
                : error.message;
            el.authError.hidden = false;
        } finally {
            // Restore the button directly rather than via setAuthMode(), which
            // clears the error banner - doing that here would wipe the message
            // this handler just displayed, leaving a failed submit silent.
            el.authSubmit.disabled = false;
            label.textContent = state.authMode === 'login' ? 'Sign in' : 'Create account';
        }
    }

    /**
     * Clears the session and returns to the auth screen.
     * @param {string} [message]
     */
    function signOut(message) {
        clearInterval(state.refreshTimer);
        state.refreshTimer = null;
        state.token = null;
        state.user = null;
        state.jobs = [];
        state.profile = null;
        state.lastUpdatedAt = null;
        state.firstRender = true;
        localStorage.removeItem(TOKEN_KEY);

        M.transitionView(el.appView, el.authView).then(() => setAuthMode(state.authMode));
        if (message) toast(message, 'error');
    }

    /* -------------------------------------------------------------- */
    /* Resumes & candidate profile                                     */
    /* -------------------------------------------------------------- */

    /** Loads and renders this user's resumes. */
    async function loadResumes() {
        const resumes = await api('/api/resumes');
        el.resumeCount.textContent = resumes.length ? `${resumes.length} uploaded` : 'none yet';
        el.resumeList.replaceChildren();

        if (!resumes.length) {
            el.resumeList.append(
                element('li', {
                    className: 'empty',
                    text: 'No resumes yet - upload at least one so postings can be scored.',
                })
            );
            return;
        }

        for (const resume of resumes) {
            const item = element('li');
            item.append(
                element('span', { className: 'resume-name', text: resume.filename }),
                element('span', {
                    className: 'resume-meta',
                    text: `${Number(resume.characters).toLocaleString()} chars`,
                }),
                element('button', {
                    className: 'btn-remove',
                    text: 'Remove',
                    attrs: { type: 'button', 'data-delete-resume': String(resume.id), title: 'Delete this resume' },
                })
            );
            el.resumeList.append(item);
        }

        M.stagger(el.resumeList.children, 'slideRight', { step: 34 });
    }

    /**
     * Loads the profile the relevance gate screens against, and shows it.
     *
     * This is the honest version of "why am I not seeing more jobs?": the board
     * hides whole categories of posting based on these two values, so they are
     * on screen rather than buried in a log.
     */
    async function loadProfile() {
        const profile = await api('/api/resumes/profile');
        state.profile = profile;

        if (!profile.resumeCount) {
            el.profileStrip.hidden = true;
            return;
        }

        el.profileStrip.hidden = false;
        el.profileLevel.textContent = profile.levelLabel;
        el.profileChips.replaceChildren();

        const chips = [];
        if (profile.years !== null && profile.years !== undefined) {
            const years = Number(profile.years);
            chips.push({
                text: years < 1 ? `${Math.round(years * 12)} months experience` : `${years}+ years experience`,
                className: 'pill pill-accent',
            });
        }
        const families = profile.families || [];
        for (const family of families) chips.push({ text: family, className: 'pill' });
        if (!families.length) chips.push({ text: 'field not detected', className: 'pill pill-warn' });

        if (profile.location) chips.push({ text: profile.location, className: 'pill pill-quiet' });

        const skills = profile.skills || [];
        if (skills.length) chips.push({ text: `${skills.length} skills detected`, className: 'pill pill-quiet' });

        for (const chip of chips) el.profileChips.append(element('span', chip));
        M.stagger(el.profileChips.children, 'pop', { step: 24, duration: 240 });

        // Say which filters are actually running: a board that silently hides
        // most of what it scraped should explain itself.
        el.profileNote.textContent = families.length
            ? 'Postings in another field, more than one level above this, or outside your country are filtered out. Toggle "Show filtered-out" to see them.'
            : 'Your resume did not name a field, so nothing is filtered on it - only seniority and location apply.';
    }

    /** Uploads whatever is selected in the file input. */
    async function uploadResumes() {
        const files = el.resumeInput.files;
        if (!files || !files.length) return;

        const form = new FormData();
        Array.from(files).forEach((file) => form.append('resumes', file));

        const label = el.uploadBtn.querySelector('.btn-label');
        el.uploadBtn.disabled = true;
        label.textContent = 'Uploading…';

        try {
            const result = await api('/api/resumes', { method: 'POST', body: form });
            const saved = result.saved?.length || 0;

            if (saved) toast(`${saved} resume${saved === 1 ? '' : 's'} parsed and saved.`, 'success');
            // Report unreadable files individually - the rest of the batch still saved.
            (result.failed || []).forEach((failure) => toast(`${failure.filename}: ${failure.error}`, 'error'));

            el.resumeInput.value = '';
            el.fileDrop.querySelector('.file-drop-title').textContent = 'Drop resumes here, or click to browse';
            await Promise.all([loadResumes(), loadProfile()]);
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            el.uploadBtn.disabled = !el.resumeInput.files?.length;
            label.textContent = 'Upload';
        }
    }

    /* -------------------------------------------------------------- */
    /* Jobs                                                            */
    /* -------------------------------------------------------------- */

    /**
     * Fetches the whole board once; the tabs filter it client-side.
     * Below-bar and gate-rejected postings are excluded server-side unless the
     * matching toggle is on.
     */
    async function loadJobs() {
        const query = new URLSearchParams();
        if (el.includeBelowBar.checked) query.set('includeBelowBar', 'true');
        if (el.includeMismatch.checked) query.set('includeMismatch', 'true');

        const suffix = query.toString() ? `?${query}` : '';
        state.jobs = await api(`/api/jobs${suffix}`);
        renderTabCounts();
        renderBoard();
    }

    /**
     * Polls for work done by the scheduled scrape and redraws only when the
     * board actually changed, so an idle tab does nothing but one cheap stats
     * request a minute. Skipped while the tab is hidden or a manual scrape is
     * already running.
     */
    async function checkForUpdates() {
        if (!state.token || document.hidden || el.scrapeBtn.disabled) return;

        try {
            const previous = state.lastUpdatedAt;
            const stats = await loadStats();
            if (!previous || stats.lastUpdatedAt === previous) return;

            await loadJobs();
            toast('New postings from the scheduled scrape.', 'success');
        } catch {
            // A failed poll is not worth interrupting the user for; the next
            // tick retries, and a dead session is handled by api()'s 401 path.
        }
    }

    /**
     * Refreshes the header counters.
     * @returns {Promise<object>} the stats payload
     */
    async function loadStats() {
        const stats = await api('/api/jobs/stats');
        state.lastUpdatedAt = stats.lastUpdatedAt;

        M.countUp(el.statTotal, stats.total);
        M.countUp(el.statInternships, stats.internships);
        M.countUp(el.statFullTime, stats.fullTime);
        M.countUp(el.statStrong, stats.strongMatches);
        M.countUp(el.statAverage, stats.averageScore ?? 0, { decimals: 1 });
        M.countUp(el.statFiltered, (stats.filteredOut || 0) + (stats.belowPayBar || 0) + (stats.belowMatchBar || 0));

        el.payBarLabel.title = `${stats.belowPayBar} posting(s) hidden: salary under 10 LPA, or CTC under 15 LPA.`;

        el.subtitle.textContent = stats.lastUpdatedAt
            ? `Last updated ${new Date(stats.lastUpdatedAt).toLocaleString()}`
            : 'No postings yet - upload a resume, then run a scrape.';

        return stats;
    }

    /** Cards for the active tab, after search + score filtering and sorting. */
    function visibleJobs() {
        const needle = el.searchInput.value.trim().toLowerCase();
        const minScore = Number(el.minScore.value);

        const rows = state.jobs.filter((job) => {
            const match = matchOf(job);
            // Anything the model did not categorise is treated as full-time.
            if ((match.job_type || TABS.FULL_TIME) !== state.tab) return false;
            if (Number(match.score || 0) < minScore) return false;
            if (!needle) return true;
            return `${job.title} ${job.company || ''}`.toLowerCase().includes(needle);
        });

        const key = state.sort;
        const descending = key === 'score' || key === 'pay';
        const valueOf = (job) => {
            if (key === 'score') return Number(matchOf(job).score || 0);
            if (key === 'pay') return payValue(job);
            return String(job[key] || '').toLowerCase();
        };

        return rows.sort((a, b) => {
            const left = valueOf(a);
            const right = valueOf(b);
            if (left < right) return descending ? 1 : -1;
            if (left > right) return descending ? -1 : 1;
            return 0;
        });
    }

    /** Bucket for a score, driving both the ring colour and the number. */
    const scoreTone = (score) => (score >= 70 ? 'is-high' : score >= 45 ? 'is-mid' : 'is-low');

    /**
     * The animated score ring on the left of each card.
     * @param {number} score
     * @returns {HTMLElement}
     */
    function buildScoreRing(score) {
        const wrap = element('div', { className: `score-ring ${scoreTone(score)}` });
        wrap.title = `Match score: ${score}/100`;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 46 46');

        const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        track.setAttribute('class', 'ring-track');
        track.setAttribute('cx', '23');
        track.setAttribute('cy', '23');
        track.setAttribute('r', '18');

        const value = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        value.setAttribute('class', 'ring-value');
        value.setAttribute('cx', '23');
        value.setAttribute('cy', '23');
        value.setAttribute('r', '18');

        svg.append(track, value);
        wrap.append(svg, element('span', { className: 'score-number', text: String(score) }));

        // Deferred so the node is in the document and can be measured/animated.
        requestAnimationFrame(() => M.drawRing(value, score, 18));
        return wrap;
    }

    /**
     * Badges describing why a posting is (or is not) worth applying to.
     * @param {object} match
     * @returns {Array<HTMLElement>}
     */
    function buildBadges(match) {
        const badges = [];
        const relevance = match.relevance;

        if (relevance) {
            const tone =
                relevance.fit === 'match'
                    ? 'pill-good'
                    : relevance.fit === 'stretch'
                      ? 'pill-warn'
                      : 'pill-bad';
            const label =
                relevance.fit === 'match'
                    ? 'Good fit'
                    : relevance.fit === 'stretch'
                      ? 'Stretch'
                      : relevance.fit === 'overreach'
                        ? 'Too senior'
                        : relevance.fit === 'elsewhere'
                          ? 'Outside India'
                          : 'Wrong field';

            const badge = element('span', { className: `pill ${tone}`, text: label });
            badge.title = relevance.note || '';
            badges.push(badge);

            if (relevance.levelLabel) {
                badges.push(element('span', { className: 'pill', text: relevance.levelLabel }));
            }
        }

        if (match.meets_pay_bar === false) {
            const badge = element('span', { className: 'pill pill-bad', text: 'Under pay bar' });
            badge.title = match.pay_note || '';
            badges.push(badge);
        }

        return badges;
    }

    /**
     * Builds one job card.
     * @param {object} job
     * @returns {HTMLElement}
     */
    function buildCard(job) {
        const match = matchOf(job);
        const score = Number(match.score || 0);
        const filtered =
            ['mismatch', 'overreach', 'elsewhere'].includes(match.relevance?.fit) || match.meets_pay_bar === false;

        const card = element('article', { className: `job-card${filtered ? ' is-filtered' : ''}` });
        // Identity for FLIP: the same posting keeps the same key across sorts.
        card.dataset.flipKey = String(job.id);

        /* --- score --- */
        card.append(buildScoreRing(score));

        /* --- body --- */
        const body = element('div', { className: 'job-body' });

        body.append(element('h3', { className: 'job-title', text: job.title }));

        const meta = element('div', { className: 'job-meta' });
        meta.append(element('span', { className: 'job-company', text: job.company || 'Unknown company' }));

        const place = job.location || match.relevance?.location;
        if (place && place !== 'Not stated') {
            meta.append(
                element('span', { className: 'job-dot', text: '·' }),
                element('span', { className: 'job-location', text: `📍 ${place}` })
            );
        }

        if (job.date_posted) {
            meta.append(element('span', { className: 'job-dot', text: '·' }), element('span', { text: job.date_posted }));
        }
        body.append(meta);

        const badges = buildBadges(match);
        if (badges.length) {
            const row = element('div', { className: 'job-badges' });
            badges.forEach((badge) => row.append(badge));
            body.append(row);
        }

        if (match.reason) {
            const reason = element('p', { className: 'job-reason', text: match.reason });
            reason.title = match.reason;
            body.append(reason);
        }

        if (match.best_resume_name) {
            const resume = element('span', { className: 'job-resume', text: 'Best resume: ' });
            resume.append(element('strong', { text: match.best_resume_name }));
            body.append(resume);
        }

        card.append(body);

        /* --- actions --- */
        const actions = element('div', { className: 'job-actions' });

        const comp = match.compensation || {};
        actions.append(
            element('span', {
                className: `job-pay ${match.meets_pay_bar === false ? 'pay-low' : comp.stated ? 'pay-ok' : 'pay-unknown'}`,
                text: payLabel(job),
                attrs: { title: payTitle(job) },
            })
        );

        const usable = /^https?:\/\//i.test(job.apply_url || '');
        const link = element('a', { className: `apply-link${usable ? '' : ' is-dead'}` });
        link.append(element('span', { text: usable ? 'Apply' : 'No link' }));
        if (usable) link.append(element('span', { className: 'arrow', text: '↗' }));

        if (usable) {
            // Assigning via the property (not setAttribute) keeps javascript:
            // URLs out of the DOM even if a board ever slipped one past the
            // scraper's normaliser.
            link.href = job.apply_url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = job.apply_url;
        } else {
            link.title = 'This posting was stored without a usable application link.';
        }

        actions.append(link);
        card.append(actions);

        return card;
    }

    /**
     * Renders the board for the active tab.
     *
     * Re-sorting and re-filtering go through `Motion.flip`, so surviving cards
     * slide to their new positions instead of the list blinking into a new
     * order; genuinely new cards get a staggered entrance.
     */
    function renderBoard() {
        const rows = visibleJobs();
        el.resultCount.textContent = `${rows.length} role${rows.length === 1 ? '' : 's'}`;

        const paint = () => {
            el.jobList.replaceChildren();

            if (!rows.length) {
                el.jobList.append(buildEmptyState());
                return;
            }

            const fragment = document.createDocumentFragment();
            rows.forEach((job) => fragment.append(buildCard(job)));
            el.jobList.append(fragment);
        };

        if (state.firstRender) {
            paint();
            M.stagger(el.jobList.children, 'fadeUp', { step: 26 });
            state.firstRender = false;
            return;
        }

        M.flip(el.jobList, paint, { selector: '.job-card' });
    }

    /**
     * The message shown when the active tab has nothing in it - specific about
     * *why*, because "no results" after a silent filter is the single most
     * confusing state this UI can be in.
     *
     * @returns {HTMLElement}
     */
    function buildEmptyState() {
        const node = element('div', { className: 'empty-state' });
        const isIntern = state.tab === TABS.INTERNSHIP;
        const filtering = !el.includeMismatch.checked || !el.includeBelowBar.checked;
        const searching = el.searchInput.value.trim() || Number(el.minScore.value) > 0;

        node.append(element('span', { className: 'empty-icon', text: isIntern ? '🎓' : '💼' }));
        node.append(element('strong', { text: `No ${isIntern ? 'internships' : 'full-time roles'} here` }));

        let hint;
        if (searching) {
            hint = 'Nothing matches the current search and score filter. Try clearing them.';
        } else if (!state.jobs.length && filtering) {
            hint = 'Everything scraped so far was filtered out as the wrong field, too senior, or under the pay bar. Turn on the toggles above to see it.';
        } else if (!state.jobs.length) {
            hint = 'Upload a resume, then run a scrape to fill the board.';
        } else {
            hint = `Nothing in this tab yet - check the ${isIntern ? 'Full-time' : 'Internships'} tab.`;
        }

        node.append(element('span', { text: hint }));
        return node;
    }

    /** Updates the counts shown on the tabs themselves. */
    function renderTabCounts() {
        const counts = state.jobs.reduce(
            (acc, job) => {
                const key = matchOf(job).job_type === TABS.INTERNSHIP ? 'internship' : 'fullTime';
                acc[key] += 1;
                return acc;
            },
            { internship: 0, fullTime: 0 }
        );

        el.tabCountInternship.textContent = counts.internship;
        el.tabCountFullTime.textContent = counts.fullTime;
    }

    /**
     * Switches the active tab.
     * @param {string} tab one of TABS
     */
    function setTab(tab) {
        state.tab = tab;

        let active = null;
        document.querySelectorAll('[data-tab]').forEach((button) => {
            const isActive = button.dataset.tab === tab;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', String(isActive));
            if (isActive) active = button;
        });

        M.moveIndicator(el.jobThumb, active);

        // A tab switch replaces the whole set, so entrance beats FLIP here.
        state.firstRender = true;
        renderBoard();
    }

    /* -------------------------------------------------------------- */
    /* Export                                                          */
    /* -------------------------------------------------------------- */

    /**
     * Exports the cards currently shown in the active tab - deliberately not the
     * whole board, so the two tabs produce two different files.
     */
    function exportActiveTab() {
        const rows = visibleJobs();
        if (!rows.length) {
            toast('Nothing to export in this tab.', 'error');
            return;
        }

        const sheetRows = rows.map((job) => {
            const match = matchOf(job);
            return {
                'Job Title': job.title,
                Company: job.company || '',
                'Job Type': match.job_type || '',
                Location: job.location || match.relevance?.location || '',
                Fit: match.relevance?.fit || '',
                Level: match.relevance?.levelLabel || '',
                'Recommended Resume': match.best_resume_name || '',
                Pay: payLabel(job),
                'Pay Note': match.pay_note || '',
                Score: Number(match.score || 0),
                Reason: match.reason || '',
                'Apply Link': job.apply_url,
            };
        });

        const label = state.tab === TABS.INTERNSHIP ? 'Internships' : 'Full-Time';
        const filename = `job-matches-${label.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;

        if (typeof XLSX === 'undefined') {
            downloadCsv(sheetRows, `${filename}.csv`);
            toast('SheetJS did not load - exported CSV instead.', 'error');
            return;
        }

        const sheet = XLSX.utils.json_to_sheet(sheetRows);
        sheet['!cols'] = [
            { wch: 42 }, { wch: 18 }, { wch: 14 }, { wch: 26 }, { wch: 10 }, { wch: 13 },
            { wch: 26 }, { wch: 16 }, { wch: 42 }, { wch: 8 }, { wch: 60 }, { wch: 50 },
        ];

        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, label);
        XLSX.writeFile(book, `${filename}.xlsx`);
        toast(`Exported ${rows.length} ${label.toLowerCase()} role(s).`, 'success');
    }

    /**
     * CSV fallback for when the SheetJS CDN is blocked.
     * @param {Array<object>} rows
     * @param {string} filename
     */
    function downloadCsv(rows, filename) {
        const headers = Object.keys(rows[0]);
        const escapeCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
        const csv = [
            headers.join(','),
            ...rows.map((row) => headers.map((key) => escapeCell(row[key])).join(',')),
        ].join('\n');

        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
        const link = Object.assign(document.createElement('a'), { href: url, download: filename });
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    /* -------------------------------------------------------------- */
    /* Scraping                                                        */
    /* -------------------------------------------------------------- */

    /**
     * Waits for the run started by `runScrape` to finish, and returns its
     * summary.
     *
     * The scrape is not held open by the request that started it - a crawl
     * outlives any hosting proxy's patience - so progress is followed through
     * `/api/status`. A `lastRun` that finished after we started is the run we
     * asked for; anything older belongs to the scheduler.
     *
     * @param {number} startedAt epoch ms, taken before the POST
     * @returns {Promise<object|null>} the run summary, or null if it outlasted us
     */
    async function awaitScrape(startedAt) {
        const deadline = startedAt + SCRAPE_TIMEOUT_MS;

        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, SCRAPE_POLL_MS));

            let status;
            try {
                status = await api('/api/status');
            } catch {
                continue; // a free instance can drop a request while it works
            }

            const finished = status.lastRun?.finishedAt ? Date.parse(status.lastRun.finishedAt) : 0;
            if (!status.running && finished >= startedAt) return status.lastRun;
        }

        return null;
    }

    /** Triggers a scrape for the signed-in user and reloads the board. */
    async function runScrape() {
        const label = el.scrapeBtn.querySelector('.btn-label');
        el.scrapeBtn.disabled = true;
        el.scrapeBtn.classList.add('is-busy');
        label.textContent = 'Scraping…';
        el.footerStatus.textContent = 'Searching job boards for your skills - this can take a few minutes.';

        const startedAt = Date.now();

        try {
            await api('/api/scrape', { method: 'POST' });
            const summary = await awaitScrape(startedAt);

            if (!summary) {
                toast('The scrape is taking a while - it will keep running, and the board updates itself.', 'info');
            } else {
                toast(
                    `Scrape ${summary.status}: ${summary.found} posting(s) found, ${summary.inserted} new.`,
                    summary.status === 'failed' ? 'error' : 'success'
                );
                if (summary.errors?.length) console.warn('[scrape] errors:', summary.errors);
            }

            await Promise.all([loadJobs(), loadStats()]);
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            el.scrapeBtn.disabled = false;
            el.scrapeBtn.classList.remove('is-busy');
            label.textContent = 'Run scrape';
            el.footerStatus.textContent = 'Ready.';
        }
    }

    /* -------------------------------------------------------------- */
    /* Wiring                                                          */
    /* -------------------------------------------------------------- */

    /** Swaps to the dashboard and loads everything it needs. */
    async function showDashboard() {
        const name = state.user?.username || '';
        el.userChip.textContent = name;
        el.avatar.textContent = name.slice(0, 1) || '?';

        el.bootView.hidden = true;
        await M.transitionView(el.authView, el.appView);

        state.firstRender = true;
        await Promise.all([loadResumes(), loadProfile(), loadJobs(), loadStats()]);

        // Open on the tab that actually has something in it. Internships is the
        // more useful default for this audience, but landing on an empty board
        // when the full-time tab has twenty roles reads as "it found nothing".
        const counts = state.jobs.reduce(
            (acc, job) => {
                const key = matchOf(job).job_type === TABS.INTERNSHIP ? 'intern' : 'full';
                acc[key] += 1;
                return acc;
            },
            { intern: 0, full: 0 }
        );
        if (counts.intern === 0 && counts.full > 0) setTab(TABS.FULL_TIME);

        M.revealOnScroll();
        M.moveIndicator(el.jobThumb, document.querySelector(`[data-tab="${CSS.escape(state.tab)}"]`));

        // Pick up whatever the scheduled scrape stores while this tab is open.
        clearInterval(state.refreshTimer);
        state.refreshTimer = setInterval(checkForUpdates, REFRESH_INTERVAL_MS);
    }

    function bindEvents() {
        document
            .querySelectorAll('[data-auth-tab]')
            .forEach((tab) => tab.addEventListener('click', () => setAuthMode(tab.dataset.authTab)));
        el.authForm.addEventListener('submit', onAuthSubmit);
        el.logoutBtn.addEventListener('click', () => signOut('Signed out.'));

        el.themeBtn.addEventListener('click', () => {
            setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
        });

        document
            .querySelectorAll('[data-tab]')
            .forEach((button) => button.addEventListener('click', () => setTab(button.dataset.tab)));

        el.searchInput.addEventListener('input', renderBoard);
        el.sortSelect.addEventListener('change', () => {
            state.sort = el.sortSelect.value;
            renderBoard();
        });
        el.minScore.addEventListener('input', () => {
            el.minScoreValue.textContent = el.minScore.value;
            renderBoard();
        });

        // Both of these are server-side filters, so they need a refetch.
        [el.includeBelowBar, el.includeMismatch].forEach((toggle) =>
            toggle.addEventListener('change', async () => {
                try {
                    await loadJobs();
                } catch (error) {
                    toast(error.message, 'error');
                }
            })
        );

        el.fileDrop.addEventListener('click', () => el.resumeInput.click());
        el.resumeInput.addEventListener('change', () => {
            const count = el.resumeInput.files.length;
            el.uploadBtn.disabled = count === 0;
            el.fileDrop.querySelector('.file-drop-title').textContent = count
                ? `${count} file${count === 1 ? '' : 's'} selected`
                : 'Drop resumes here, or click to browse';
        });
        el.uploadBtn.addEventListener('click', uploadResumes);

        ['dragenter', 'dragover'].forEach((name) =>
            el.fileDrop.addEventListener(name, (event) => {
                event.preventDefault();
                el.fileDrop.classList.add('is-dragging');
            })
        );
        ['dragleave', 'drop'].forEach((name) =>
            el.fileDrop.addEventListener(name, (event) => {
                event.preventDefault();
                el.fileDrop.classList.remove('is-dragging');
            })
        );
        el.fileDrop.addEventListener('drop', (event) => {
            el.resumeInput.files = event.dataTransfer.files;
            el.resumeInput.dispatchEvent(new Event('change'));
        });

        el.resumeList.addEventListener('click', async (event) => {
            const id = event.target?.dataset?.deleteResume;
            if (!id) return;
            try {
                await api(`/api/resumes/${id}`, { method: 'DELETE' });
                await Promise.all([loadResumes(), loadProfile()]);
                toast('Resume removed.', 'success');
            } catch (error) {
                toast(error.message, 'error');
            }
        });

        el.scrapeBtn.addEventListener('click', runScrape);
        el.exportBtn.addEventListener('click', exportActiveTab);

        // Coming back to a backgrounded tab should not wait out the interval.
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) checkForUpdates();
        });

        // Keep the sliding tab indicators aligned when the layout reflows.
        window.addEventListener('resize', () => {
            M.moveIndicator(el.authThumb, document.querySelector('[data-auth-tab].is-active'));
            M.moveIndicator(el.jobThumb, document.querySelector('[data-tab].is-active'));
        });

        M.pressable();
    }

    /** Reveals the signed-out screen, dismissing the boot spinner. */
    function showAuth() {
        el.bootView.hidden = true;
        el.authView.hidden = false;
        setAuthMode('login');
        M.enter(el.authView, 'scaleIn');
        M.revealOnScroll();
    }

    /** Restores an existing session, or shows the auth screen. */
    async function init() {
        initTheme();
        bindEvents();
        setTab(TABS.INTERNSHIP);

        if (!state.token) {
            showAuth();
            return;
        }

        try {
            const { user } = await api('/api/auth/me');
            state.user = user;
            el.authView.hidden = true;
            await showDashboard();
        } catch {
            state.token = null;
            localStorage.removeItem(TOKEN_KEY);
            showAuth();
        }
    }

    document.addEventListener('DOMContentLoaded', init);
})();
