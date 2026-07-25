/**
 * Candidate profile configuration.
 *
 * Everything the matching engine knows about *you* lives here, so the LLM
 * prompt can be tuned without touching `services/matcher.js`.
 *
 * The resume can be supplied in three ways (first one wins):
 *   1. `RESUME_PATH` env var pointing at a plain-text file.
 *   2. A `resume.txt` file in the project root.
 *   3. The `DEFAULT_RESUME_TEXT` fallback below.
 */

const fs = require('fs');
const path = require('path');

/** The role you are actually hunting for - drives how the LLM weighs skills. */
const TARGET_ROLE = process.env.TARGET_ROLE || 'Full Stack / Mobile Developer';

/** Plain-text resume used as the "candidate stack" side of the comparison. */
const DEFAULT_RESUME_TEXT = `
Full Stack / Mobile Developer with production experience across backend, web and mobile.

BACKEND
- Node.js (Express, REST APIs, JWT auth, background jobs, WebSockets)
- Java / Spring Boot (Spring MVC, Spring Data JPA, Spring Security, microservices)
- SQL (PostgreSQL, MySQL, SQLite) and NoSQL (MongoDB, Firebase Firestore)
- API design, pagination, caching, rate limiting, integration with third-party APIs

MOBILE
- Flutter / Dart (cross-platform iOS + Android, BLoC & Provider state management,
  offline-first storage, push notifications, Play Store / App Store releases)

FRONTEND
- JavaScript / TypeScript, HTML5, CSS3, React fundamentals, responsive layouts

TOOLING & PLATFORM
- Git / GitHub, GitHub Actions CI, Docker basics, Postman, Jest, JUnit
- Cloud deployments (AWS EC2/S3 basics, Firebase, Render, Vercel)
- Agile / Scrum delivery, code review, technical documentation

STRENGTHS
- Owning a feature end-to-end: Flutter client -> Node/Spring API -> relational database
- Comfortable in polyglot codebases and picking up new frameworks quickly

GAPS (be honest about these when scoring)
- No deep experience with Python/Django, Go, Rust, .NET, or data engineering stacks
- Limited exposure to Kubernetes, Terraform and large-scale DevOps ownership
- Not a designer; no native Swift/Kotlin app shipped solo
`.trim();

/**
 * Reads the resume text from disk when available, otherwise falls back to the
 * inline default. Never throws - a missing file just means "use the default".
 *
 * @returns {string} plain-text resume
 */
function loadResumeText() {
  const candidates = [
    process.env.RESUME_PATH && path.resolve(process.cwd(), process.env.RESUME_PATH),
    path.resolve(__dirname, '..', 'resume.txt'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const text = fs.readFileSync(candidate, 'utf-8').trim();
        if (text) {
          console.log(`[profile] Loaded resume from ${candidate}`);
          return text;
        }
      }
    } catch (error) {
      console.warn(`[profile] Could not read resume at ${candidate}: ${error.message}`);
    }
  }

  return DEFAULT_RESUME_TEXT;
}

const RESUME_TEXT = loadResumeText();

module.exports = {
  TARGET_ROLE,
  RESUME_TEXT,
  DEFAULT_RESUME_TEXT,
  loadResumeText,
};
