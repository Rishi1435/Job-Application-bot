/**
 * Matching & categorisation engine.
 *
 * For one user, every scraped posting is sent to an LLM on the NVIDIA API
 * catalog (OpenAI-compatible endpoint) together with *all* of that user's
 * resumes. The model answers with a single strict JSON object:
 *
 *   { "job_type": "Internship" | "Full-Time Job",
 *     "best_resume_id": <id of one of the supplied resumes>,
 *     "best_resume_name": "<its filename>",
 *     "score": 0-100,
 *     "reason": "<one sentence>" }
 *
 * which is stored verbatim in `jobs.match_data` (JSONB).
 *
 * Robustness notes:
 *  - Models occasionally wrap JSON in prose or code fences, so responses are
 *    parsed defensively rather than with a bare `JSON.parse`.
 *  - The returned `best_resume_id` is validated against the ids that were
 *    actually sent; a hallucinated id is repaired from the name, or replaced by
 *    the local heuristic's pick.
 *  - Transient failures (429 / 5xx / socket) are retried with backoff, and the
 *    engine degrades to deterministic keyword scoring when the API is
 *    unavailable or `NVIDIA_API_KEY` is unset - the pipeline never stalls.
 */

const { OpenAI } = require('openai');

const { ROLE_TERMS, QUERY_TEMPLATES, expandLocations } = require('../config/sources');
const { getResumes } = require('./database');
const { extractUserSkills } = require('./parser');
const { parseCompensation, meetsPayBar } = require('./compensation');
const { buildCandidateProfile, assessRelevance } = require('./relevance');

/**
 * Model from the NVIDIA API catalog. Override with NVIDIA_MODEL.
 *
 * The default is the fastest catalog model verified against this contract
 * (~3s per posting). `meta/llama-3.3-70b-instruct` produces equally good
 * verdicts but is currently unreachable on integrate.api.nvidia.com - even a
 * one-token prompt times out after three minutes - so it is not the default.
 */
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const API_KEY = process.env.NVIDIA_API_KEY;

const MAX_DESCRIPTION_CHARS = Number(process.env.MAX_DESCRIPTION_CHARS || 6000);
/** Per-resume prompt budget; multiple resumes are sent on every call. */
const MAX_RESUME_CHARS = Number(process.env.MAX_RESUME_CHARS || 4000);
const MAX_RESUMES_PER_CALL = Number(process.env.MAX_RESUMES_PER_CALL || 6);

const MAX_RETRIES = Number(process.env.MATCHER_MAX_RETRIES || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.MATCHER_TIMEOUT_MS || 120000);
// Must cover a reasoning model's hidden thinking pass *and* the JSON answer.
const MAX_TOKENS = Number(process.env.MATCHER_MAX_TOKENS || 65536);
const REASONING_BUDGET = Number(process.env.MATCHER_REASONING_BUDGET || 16384);
const TEMPERATURE = Number(process.env.MATCHER_TEMPERATURE ?? 0.6);
const TOP_P = Number(process.env.MATCHER_TOP_P ?? 0.95);

/** Canonical categories. The dashboard tabs key off these exact strings. */
const JOB_TYPES = { INTERNSHIP: 'Internship', FULL_TIME: 'Full-Time Job' };

/**
 * The score a posting must reach before it is written to the database.
 *
 * The crawl is now open-ended - it discovers boards nobody configured, so it
 * sees far more genuinely irrelevant work than the old fixed source list did.
 * Storing all of it would bury the good rows and pay for the storage of every
 * near-miss, so the bar is applied at insert time rather than at display time.
 */
const MIN_MATCH_SCORE = Number(process.env.MIN_MATCH_SCORE || 50);

const client = API_KEY
  ? new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 })
  : null;

if (!client) {
  console.warn('[matcher] NVIDIA_API_KEY is not set - falling back to local keyword scoring.');
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You are an expert technical recruiter with 15 years of experience screening software engineering candidates.

You will be given a CANDIDATE PROFILE, ONE job posting and a numbered list of the candidate's resumes. Do four things:

1. CLASSIFY the role strictly as either "Internship" or "Full-Time Job".
   - "Internship" covers internships, co-ops, summer/industrial placements, apprenticeships and student/trainee programmes.
   - Everything else - including new-grad, entry-level and contract roles - is "Full-Time Job".
2. CHOOSE the single best resume for this role. Use only the ids that were given to you; never invent an id.
3. EXTRACT the advertised compensation, if the posting states one. Report it as:
   - "type": "ctc" when the figure is described as CTC / cost to company / total package,
             "salary" for base or gross pay, "stipend" for monthly intern pay,
             "none" when the posting does not mention pay at all.
   - "min_lpa" / "max_lpa": the range converted to Indian lakhs per annum (1 LPA = 100,000 INR/year).
     Convert foreign currencies at roughly 1 USD = 88 INR, 1 EUR = 95 INR, 1 GBP = 112 INR.
     Use null for both when no figure is stated. NEVER invent or estimate a number that the posting does not give.
   - "raw": the exact text the figure came from, e.g. "$150,000 - $200,000" or "CTC 18-22 LPA".
4. SCORE that resume against the posting from 0 to 100. Score for **whether this
   candidate should spend an evening applying**, not for abstract skill overlap:
     90-100  near-perfect fit; the right level AND the resume's core stack is exactly what is asked for
     70-89   strong fit; right level, most must-haves covered, minor gaps only
     50-69   partial fit; right level but real gaps in must-have technology
     25-49   weak fit; different primary stack, or the posting wants more experience than the candidate has
     0-24    the candidate would be rejected on sight

   SENIORITY IS A HARD CONSTRAINT, not one factor among many. Read the candidate's
   seniority from the profile and compare it with what the posting demands:
   - A posting one level above the candidate cannot score above 75, however good the skill overlap.
   - A posting two or more levels above the candidate (e.g. Senior, Staff, Principal,
     Manager, Director or "8+ years required" shown to an entry-level candidate)
     cannot score above 25. Say so in the reason.
   - Ignore keyword overlap when the level is wrong. Matching on "Java" does not make
     an entry-level candidate a plausible Staff Engineer.

   Reward genuine overlap, penalise missing must-have technologies, and do not be generous:
   a posting in an unrelated stack scores low even when the title sounds similar.
   Mention the candidate's location only if the posting is explicitly restricted to a
   country they are not in - never let a remote or unstated location lower the score.

Respond with ONLY a strict JSON object - no markdown, no code fences, no commentary - in exactly this shape:
{"job_type": "Internship" | "Full-Time Job", "best_resume_id": <integer id from the list>, "best_resume_name": "<that resume's filename>", "score": <integer 0-100>, "reason": "<one sentence naming the decisive overlapping skills or missing gaps>", "compensation": {"type": "ctc" | "salary" | "stipend" | "none", "min_lpa": <number or null>, "max_lpa": <number or null>, "raw": "<quoted text or null>"}}`;

/**
 * Renders the user message: the candidate profile, the posting, then every
 * resume with its database id (the model must return one of these ids).
 *
 * The profile is stated up front and separately from the resume text on purpose.
 * Seniority is buried in a resume - a date range here, a job title there - and
 * models reliably miss it while happily matching on technology keywords. Handing
 * over "Entry level, ~10 months of experience" as a fact removes the inference
 * the model was getting wrong.
 *
 * @param {{title?:string, company?:string, description?:string}} job
 * @param {Array<{id:number, filename:string, content:string}>} resumes
 * @param {{profile?:object, relevance?:object}} [context]
 * @returns {string}
 */
function buildUserMessage(job, resumes, context = {}) {
  const description = String(job.description || '').slice(0, MAX_DESCRIPTION_CHARS);
  const { profile, relevance } = context;

  const resumeBlocks = resumes.map(
    (resume) =>
      `--- RESUME id=${resume.id} name="${resume.filename}" ---\n${String(resume.content || '').slice(0, MAX_RESUME_CHARS)}`
  );

  return [
    profile ? `CANDIDATE PROFILE\n${profile.summary}` : '',
    profile ? '' : '',
    'JOB POSTING',
    job.title ? `Title: ${job.title}` : '',
    job.company ? `Company: ${job.company}` : '',
    relevance ? `Screening notes: this reads as a ${relevance.levelLabel.toLowerCase()} ${relevance.familyLabel.toLowerCase()} role.` : '',
    `Description:\n${description || '(no description text was available on the listing page)'}`,
    '',
    `CANDIDATE RESUMES (${resumes.length}) - pick exactly one id from this list:`,
    resumeBlocks.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pulls the first parseable JSON object out of a model response, tolerating
 * code fences and prose wrapped around it.
 *
 * @param {string} raw model output
 * @returns {object|null}
 */
function extractJson(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate shape.
    }
  }
  return null;
}

/**
 * Coerces any model-supplied score into a 0-100 integer.
 * @param {unknown} value
 * @returns {number}
 */
function clampScore(value) {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return 0;
  return Math.min(100, Math.max(0, num));
}

/**
 * Legacy shape used by the unit tests and by any caller that only cares about
 * the score/reason pair.
 *
 * @param {string} raw
 * @returns {{score:number, reason:string}|null}
 */
function parseVerdict(raw) {
  const parsed = extractJson(raw);
  if (!parsed || !('score' in parsed)) return null;
  return {
    score: clampScore(parsed.score),
    reason: String(parsed.reason || 'No justification returned by the model.').trim(),
  };
}

/**
 * Maps any spelling the model might use onto a canonical category.
 *
 * @param {unknown} value
 * @param {string} [fallbackText] title/description used when the model omitted the field
 * @returns {'Internship'|'Full-Time Job'}
 */
function normalizeJobType(value, fallbackText = '') {
  const text = String(value || '').toLowerCase();
  if (text.includes('intern') || text.includes('co-op') || text.includes('coop')) return JOB_TYPES.INTERNSHIP;
  if (text.includes('full')) return JOB_TYPES.FULL_TIME;
  return classifyJobType(fallbackText);
}

/**
 * Titles that mean "student programme" rather than a permanent hire. Shared with
 * the relevance gate so a posting cannot be an internship in one and a permanent
 * role in the other.
 */
const { INTERNSHIP_PATTERN } = require('./relevance');

/**
 * Deterministic category from free text, used as the fallback and to sanity
 * check the model.
 *
 * @param {string} text title (+ description) to classify
 * @returns {'Internship'|'Full-Time Job'}
 */
function classifyJobType(text) {
  return INTERNSHIP_PATTERN.test(String(text || '')) ? JOB_TYPES.INTERNSHIP : JOB_TYPES.FULL_TIME;
}

/**
 * Reconciles the model's compensation reading with the deterministic one.
 *
 * The regex extractor is authoritative when it finds a figure: it reads the
 * posting text directly, whereas a model asked for a number will sometimes
 * supply a plausible market rate for a posting that stated nothing. The model's
 * answer is only used when the regex found nothing *and* the model quoted the
 * text it came from - and even then the quote has to appear in the posting.
 *
 * @param {object|undefined} fromModel `compensation` object returned by the LLM
 * @param {string} text posting text the figure must come from
 * @returns {object} compensation record (see `services/compensation.js`)
 */
function reconcileCompensation(fromModel, text) {
  const extracted = parseCompensation(text);
  if (extracted.stated) return extracted;

  const raw = String(fromModel?.raw || '').trim();
  const max = Number(fromModel?.max_lpa);
  const min = Number(fromModel?.min_lpa);

  const quoted = raw && String(text || '').toLowerCase().includes(raw.toLowerCase().slice(0, 24));
  if (!quoted || !Number.isFinite(max) || max <= 0) return extracted;

  return {
    stated: true,
    type: ['ctc', 'salary', 'stipend'].includes(fromModel.type) ? fromModel.type : 'salary',
    min_lpa: Number.isFinite(min) && min > 0 ? min : max,
    max_lpa: max,
    currency: null,
    period: 'year',
    raw: raw.slice(0, 80),
  };
}

/**
 * Validates a raw model object against the resumes that were actually sent and
 * returns a well-formed `match_data` record, including the pay verdict.
 *
 * @param {object|null} parsed raw JSON from the model
 * @param {Array<{id:number, filename:string}>} resumes resumes offered to the model
 * @param {{title?:string, description?:string}} [job] used to repair a missing category
 * @param {object|null} [relevance] verdict from `services/relevance.js`; its `cap`
 *   is enforced here, because the prompt alone does not stop a model from
 *   awarding 85 to a Director role that shares a few keywords with the resume
 * @returns {{job_type:string, best_resume_id:number|null, best_resume_name:string|null, score:number, reason:string, compensation:object, meets_pay_bar:boolean, pay_note:string, relevance:object|null}|null}
 */
function parseMatchData(parsed, resumes, job = {}, relevance = null) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (!('score' in parsed) && !('best_resume_id' in parsed)) return null;

  const byId = new Map(resumes.map((resume) => [Number(resume.id), resume]));
  const byName = new Map(resumes.map((resume) => [String(resume.filename).toLowerCase(), resume]));

  // Trust the id, then the name, then fall back to the only/first resume.
  const chosen =
    byId.get(Number(parsed.best_resume_id)) ||
    byName.get(String(parsed.best_resume_name || '').toLowerCase()) ||
    resumes[0] ||
    null;

  const jobType = normalizeJobType(parsed.job_type, `${job.title || ''} ${job.description || ''}`);
  const compensation = reconcileCompensation(parsed.compensation, `${job.title || ''}\n${job.description || ''}`);
  const pay = meetsPayBar(compensation, { jobType });

  const modelScore = clampScore(parsed.score);
  const cap = Number.isFinite(relevance?.cap) ? relevance.cap : null;
  const score = cap === null ? modelScore : Math.min(modelScore, cap);

  let reason = String(parsed.reason || 'No justification returned by the model.').trim();
  // When the cap actually bit, say why - otherwise the row shows a low score
  // with a glowing justification and looks broken.
  if (cap !== null && modelScore > cap) reason = `${relevance.note} ${reason}`;

  return {
    job_type: jobType,
    best_resume_id: chosen ? Number(chosen.id) : null,
    best_resume_name: chosen ? chosen.filename : null,
    score,
    reason: reason.slice(0, 600),
    compensation,
    meets_pay_bar: pay.meets,
    pay_note: pay.note,
    relevance: relevance || null,
  };
}

/**
 * True for errors worth retrying (rate limits, server errors, sockets).
 * @param {any} error
 * @returns {boolean}
 */
function isRetryable(error) {
  const status = error?.status || error?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code || '');
}

/* ------------------------------------------------------------------ */
/* Offline fallback                                                    */
/* ------------------------------------------------------------------ */

/** Generic software skills, used when no resume text is available to compare. */
const DEFAULT_SKILL_WEIGHTS = {
  'node.js': 10, node: 8, express: 8, javascript: 6, typescript: 5,
  'spring boot': 10, spring: 7, java: 8, flutter: 10, dart: 8, mobile: 6,
  android: 5, ios: 4, react: 5, 'full stack': 8, fullstack: 8, rest: 4,
  api: 4, sql: 4, postgresql: 4, mysql: 4, sqlite: 3, mongodb: 4,
  firebase: 4, docker: 3, git: 2, aws: 3,
};

/** Technologies worth looking for in a resume when building its keyword set. */
const SKILL_VOCABULARY = Object.keys(DEFAULT_SKILL_WEIGHTS).concat([
  'python', 'go', 'golang', 'rust', 'c++', 'c#', '.net', 'php', 'ruby', 'rails',
  'kubernetes', 'terraform', 'graphql', 'redis', 'kafka', 'spark', 'hadoop',
  'tensorflow', 'pytorch', 'machine learning', 'nlp', 'data science', 'pandas',
  'vue', 'angular', 'svelte', 'next.js', 'django', 'flask', 'fastapi', 'swift',
  'kotlin', 'azure', 'gcp', 'ci/cd', 'microservices', 'rest api', 'devops',
]);

/**
 * Weights derived from what a resume actually claims, so the offline score is
 * still personal to the candidate.
 *
 * @param {string} resumeText
 * @returns {Record<string, number>}
 */
function skillWeightsFor(resumeText) {
  const text = String(resumeText || '').toLowerCase();
  if (!text.trim()) return DEFAULT_SKILL_WEIGHTS;

  const weights = {};
  for (const skill of SKILL_VOCABULARY) {
    if (text.includes(skill)) {
      // Skills mentioned repeatedly are more central to the profile.
      const mentions = text.split(skill).length - 1;
      weights[skill] = Math.min(10, 4 + mentions);
    }
  }
  return Object.keys(weights).length ? weights : DEFAULT_SKILL_WEIGHTS;
}

/**
 * Deterministic keyword-overlap score, used when the LLM is unavailable.
 * Never throws.
 *
 * @param {string} description job description text
 * @param {string} [resumeText] resume to score against (defaults to a generic
 *   software-engineering vocabulary)
 * @returns {{score:number, reason:string, engine:'keyword'}}
 */
function keywordScore(description, resumeText = '') {
  const text = String(description || '').toLowerCase();
  if (!text.trim()) {
    return { score: 0, reason: 'No job description available to score.', engine: 'keyword' };
  }

  const weights = skillWeightsFor(resumeText);
  const hits = [];
  let earned = 0;

  for (const [skill, weight] of Object.entries(weights)) {
    if (text.includes(skill)) {
      earned += weight;
      hits.push(skill);
    }
  }

  // 60 weighted points is treated as a full match; above that we cap at 100.
  const score = clampScore((earned / 60) * 100);
  const reason = hits.length
    ? `Keyword match on ${hits.slice(0, 5).join(', ')} (offline scoring - set NVIDIA_API_KEY for LLM analysis).`
    : 'No overlapping keywords found (offline scoring - set NVIDIA_API_KEY for LLM analysis).';

  return { score, reason, engine: 'keyword' };
}

/**
 * Full `match_data` produced locally: classifies the role, scores every resume
 * and keeps the best one.
 *
 * @param {{title?:string, company?:string, description?:string}} job
 * @param {Array<{id:number, filename:string, content:string}>} resumes
 * @param {string} [note] appended to the reason so the UI can tell why the LLM
 *   was skipped
 * @param {object|null} [relevance] verdict from `services/relevance.js`
 * @returns {{job_type:string, best_resume_id:number|null, best_resume_name:string|null, score:number, reason:string, engine:'keyword'}}
 */
function heuristicMatch(job, resumes, note = '', relevance = null) {
  const haystack = `${job.title || ''} ${job.description || ''}`;
  const jobType = classifyJobType(haystack);

  // The pay bar is deterministic, so it applies identically with or without the
  // LLM - a below-bar posting is filtered out even during an API outage.
  const compensation = parseCompensation(haystack);
  const pay = meetsPayBar(compensation, { jobType });
  const payFields = { compensation, meets_pay_bar: pay.meets, pay_note: pay.note, relevance: relevance || null };

  if (!resumes.length) {
    return {
      job_type: jobType,
      best_resume_id: null,
      best_resume_name: null,
      score: 0,
      reason: `No resumes uploaded yet - upload one to get a match score.${note}`,
      ...payFields,
      engine: 'keyword',
    };
  }

  let best = null;
  for (const resume of resumes) {
    const verdict = keywordScore(job.description, resume.content);
    if (!best || verdict.score > best.score) best = { ...verdict, resume };
  }

  const cap = Number.isFinite(relevance?.cap) ? relevance.cap : null;
  const score = cap === null ? best.score : Math.min(best.score, cap);
  const capped = cap !== null && best.score > cap ? `${relevance.note} ` : '';

  return {
    job_type: jobType,
    best_resume_id: Number(best.resume.id),
    best_resume_name: best.resume.filename,
    score,
    reason: `${capped}${best.reason}${note}`.slice(0, 600),
    ...payFields,
    engine: 'keyword',
  };
}

/**
 * Verdict for a posting the gate rejected outright.
 *
 * Skipping the model here is the point: a Director opening shown to an
 * entry-level candidate has a knowable answer, so paying for a 20-second
 * reasoning call to be told what the title already says is waste. On a typical
 * run this removes roughly half the LLM calls.
 *
 * @param {{title?:string, description?:string}} job
 * @param {Array<{id:number, filename:string}>} resumes
 * @param {object} relevance verdict from `assessRelevance`
 * @returns {object} match_data record
 */
function gatedMatch(job, resumes, relevance) {
  const haystack = `${job.title || ''} ${job.description || ''}`;
  const jobType = classifyJobType(haystack);
  const compensation = parseCompensation(haystack);
  const pay = meetsPayBar(compensation, { jobType });
  const chosen = resumes[0] || null;

  return {
    job_type: jobType,
    best_resume_id: chosen ? Number(chosen.id) : null,
    best_resume_name: chosen ? chosen.filename : null,
    score: relevance.cap,
    reason: relevance.note,
    compensation,
    meets_pay_bar: pay.meets,
    pay_note: pay.note,
    relevance,
    engine: 'gate',
  };
}

/* ------------------------------------------------------------------ */
/* Resume analysis                                                     */
/* ------------------------------------------------------------------ */

const ANALYST_PROMPT = `You are a technical recruiter deciding which job titles to search for on behalf of a candidate.

Read the resume(s) and answer with JSON only - no prose, no code fences:
{
  "target_roles": ["..."],   // 4-8 job titles to search job boards for, most suitable first.
                             // Use titles as they appear on real postings ("Backend Engineer",
                             // "Software Engineer Intern"), not descriptions of the person.
                             // Include the entry rung (Intern/Associate/Graduate/Junior) when
                             // the candidate is early-career.
  "core_skills": ["..."],    // up to 12 technologies to match postings against, strongest first.
                             // Name the technology as a posting would ("Node.js", "Spring Boot").
  "seniority": "...",        // one of: intern, entry, mid, senior
  "summary": "..."           // one sentence on what this person should be applying for
}

Rules:
- Judge the whole resume: projects and internships count as evidence, coursework barely does.
- target_roles must be roles this candidate could plausibly be interviewed for today.
- Never invent a technology the resume does not mention.`;

/**
 * Asks the model what this candidate should be searching for.
 *
 * The regex vocabulary in `extractUserSkills` reads what is written down; it
 * cannot tell that someone whose projects are all Spring Boot APIs should be
 * looking at "Backend Engineer" rather than the "Full Stack Developer" printed
 * at the top of their resume. The model can, and the answer is what the crawl
 * then searches for - so one call per run shapes every query and dork.
 *
 * Falls back to the regex vocabulary on any failure: a run must not depend on
 * the LLM being reachable.
 *
 * @param {Array<{filename?:string, content?:string}>} resumes
 * @returns {Promise<{titles:Array<string>, skills:Array<string>, seniority:string|null, summary:string|null, engine:string}>}
 */
async function analyzeResumes(resumes = []) {
  const local = extractUserSkills(resumes);
  const fallback = { titles: local.titles, skills: local.skills, seniority: null, summary: null, engine: 'keyword' };

  if (!client || !resumes.length) return fallback;

  const text = resumes
    .slice(0, MAX_RESUMES_PER_CALL)
    .map((resume, i) => `--- RESUME ${i + 1}${resume.filename ? ` (${resume.filename})` : ''} ---\n${String(resume.content || '').slice(0, MAX_RESUME_CHARS)}`)
    .join('\n\n');

  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: ANALYST_PROMPT },
        { role: 'user', content: text },
      ],
      temperature: 0.2, // a search plan should not vary run to run
      top_p: TOP_P,
      max_tokens: MAX_TOKENS,
      reasoning_budget: REASONING_BUDGET,
    });

    const message = completion?.choices?.[0]?.message || {};
    const parsed = extractJson(message.content) || extractJson(message.reasoning_content);
    if (!parsed) throw new Error('no JSON in the reply');

    const clean = (values, cap) =>
      [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, cap);

    const titles = clean(parsed.target_roles, 8);
    const skills = clean(parsed.core_skills, 12);
    if (!titles.length && !skills.length) throw new Error('empty analysis');

    return {
      // The model decides the order; anything it missed that the resume plainly
      // states is still worth searching for, so the two vocabularies are unioned
      // rather than swapped.
      titles: [...new Set([...titles, ...local.titles])].slice(0, 10),
      skills: [...new Set([...skills, ...local.skills])].slice(0, 14),
      seniority: parsed.seniority ? String(parsed.seniority).toLowerCase() : null,
      summary: parsed.summary ? String(parsed.summary).slice(0, 300) : null,
      engine: 'llm',
    };
  } catch (error) {
    console.warn(`[matcher] Resume analysis fell back to keywords: ${error.message}`);
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Search queries                                                      */
/* ------------------------------------------------------------------ */

/** Level words appended to a role so a run finds the entry rungs too. */
const LEVEL_TERMS = ['Intern', 'Associate', 'Graduate'];

/**
 * Turns a user's resumes into the queries a run searches with.
 *
 * The pairing is deliberate. A bare skill ("Flutter") matches conference talks
 * and course pages; a bare role ("Software Engineer") matches every posting on
 * earth. `"<skill> <role>"` is the combination that returns postings a specific
 * person could actually apply to, which is what both the ATS dorks and the feed
 * filters are built from.
 *
 * Titles read off the resume come first, because a candidate's own last job
 * title is a better query than any generic term - then the shared `ROLE_TERMS`
 * vocabulary widens the net, and the level words reach the intern and associate
 * rungs that a plain title search skips.
 *
 * @param {Array<{content?:string}>|{skills:Array<string>, titles:Array<string>, locations?:Array<string>}} input
 *   resume rows, or an already-extracted vocabulary from `extractUserSkills`
 * @param {{limit?:number, skillLimit?:number, locations?:Array<string>}} [options]
 * @returns {Array<string>} distinct query strings, strongest first
 */
function buildSearchQueries(input, options = {}) {
  const vocabulary = Array.isArray(input) ? extractUserSkills(input) : input || {};
  const skills = (vocabulary.skills || []).slice(0, Math.max(1, options.skillLimit || 8));
  const titles = vocabulary.titles || [];
  const locations = options.locations || vocabulary.locations || [];

  const limit = Math.max(1, options.limit || Number(process.env.MAX_SEARCH_QUERIES || 24));

  // Resume titles first, then the generic vocabulary, with the duplicates a
  // "Software Engineer" resume produces removed.
  const roles = [...new Set([...titles, ...ROLE_TERMS])];
  if (!skills.length) return roles.slice(0, limit);

  const queries = [];
  const add = (query) => {
    const text = query.replace(/\s+/g, ' ').trim();
    if (text && !queries.includes(text)) queries.push(text);
  };

  // Round-robin so the strongest skill is paired with several roles before the
  // twelfth-ranked one is used at all.
  for (let round = 0; round < roles.length && queries.length < limit; round += 1) {
    for (let i = 0; i < skills.length && queries.length < limit; i += 1) {
      const template = QUERY_TEMPLATES[(round + i) % QUERY_TEMPLATES.length];
      add(template.replace('{skill}', skills[i]).replace('{role}', roles[(round + i) % roles.length]));
    }
  }

  // Entry-level variants of the candidate's own titles.
  for (const level of LEVEL_TERMS) {
    for (const title of titles.slice(0, 2)) add(`${title} ${level}`);
    if (skills[0]) add(`${skills[0]} Developer ${level}`);
  }

  // Where they can actually be hired. Workday takes these strings as its
  // `searchText`, so a country here is the difference between a page of roles
  // the candidate can take and a page the location gate will throw away.
  for (const location of expandLocations(locations)) {
    for (const title of titles.slice(0, 2)) add(`${title} ${location}`);
    for (const skill of skills.slice(0, 2)) add(`${skill} Developer ${location}`);
  }

  return queries.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Categorises one posting and picks the best resume for it.
 *
 * @param {{title?:string, company?:string, description?:string}} job
 * @param {Array<{id:number, filename:string, content:string}>} resumes the
 *   user's resumes; an empty array yields a zero score with an explanation
 * @returns {Promise<{job_type:string, best_resume_id:number|null, best_resume_name:string|null, score:number, reason:string, engine:'llm'|'keyword'}>}
 */
async function matchJob(job, resumes = [], options = {}) {
  const usable = resumes.slice(0, MAX_RESUMES_PER_CALL);
  const profile = options.profile || buildCandidateProfile(usable);
  const relevance = options.relevance || (usable.length ? assessRelevance(job, profile) : null);

  // Postings the gate rejected are answered locally - see `gatedMatch`.
  if (relevance && !relevance.worthScoring) return gatedMatch(job, usable, relevance);

  if (!client) return heuristicMatch(job, usable, '', relevance);
  if (!usable.length) return heuristicMatch(job, usable, '', relevance);
  if (!String(job.description || '').trim() && !String(job.title || '').trim()) {
    return heuristicMatch(job, usable, ' (nothing to analyse on the listing)', relevance);
  }

  const userMessage = buildUserMessage(job, usable, { profile, relevance });
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: TEMPERATURE,
        top_p: TOP_P,
        max_tokens: MAX_TOKENS,
        // Honoured by NVIDIA's reasoning models, ignored by instruct models.
        reasoning_budget: REASONING_BUDGET,
      });

      const message = completion?.choices?.[0]?.message || {};
      // Reasoning models answer in `content` and think in `reasoning_content`;
      // if the budget runs out mid-thought the JSON can land in the latter.
      const parsed = extractJson(message.content) || extractJson(message.reasoning_content);
      const matchData = parseMatchData(parsed, usable, job, relevance);

      if (matchData) return { ...matchData, engine: 'llm' };

      const truncated =
        completion?.choices?.[0]?.finish_reason === 'length' ? ' (hit the token limit - raise MATCHER_MAX_TOKENS)' : '';
      lastError = new Error(
        `Model returned unparseable output${truncated}: ${String(message.content || message.reasoning_content || '').slice(0, 200)}`
      );
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) break;
    }

    if (attempt < MAX_RETRIES) {
      const backoff = 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      console.warn(`[matcher] Attempt ${attempt}/${MAX_RETRIES} failed (${lastError.message}); retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }

  console.error(`[matcher] LLM matching failed, using keyword fallback: ${lastError?.message}`);
  return heuristicMatch(job, usable, ` (LLM unavailable: ${lastError?.message || 'unknown error'})`, relevance);
}

/**
 * Matches many postings for one tenant with bounded concurrency.
 *
 * The user's resumes are read once and reused for the whole batch.
 *
 * @param {number} userId tenant whose resumes are used
 * @param {Array<object>} jobs postings to categorise
 * @param {{concurrency?:number, resumes?:Array<object>}} [options]
 * @returns {Promise<Array<object>>} match_data records, index-aligned with `jobs`
 */
async function matchJobsForUser(userId, jobs, options = {}) {
  if (!jobs.length) return [];

  const resumes = options.resumes || (await getResumes(userId));
  // One profile for the whole batch: it is derived from the resumes, which do
  // not change mid-run, and every relevance check needs it.
  const profile = options.profile || buildCandidateProfile(resumes);
  const relevance = jobs.map((job) => (resumes.length ? assessRelevance(job, profile) : null));

  const gated = relevance.filter((verdict) => verdict && !verdict.worthScoring).length;
  if (gated) {
    console.log(
      `[matcher] ${gated}/${jobs.length} posting(s) rejected before scoring ` +
        `(wrong field or too senior for a ${profile.levelLabel.toLowerCase()} candidate).`
    );
  }

  const concurrency = Math.max(1, options.concurrency || Number(process.env.MATCHER_CONCURRENCY) || 3);
  const results = new Array(jobs.length);
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await matchJob(jobs[index], resumes, { profile, relevance: relevance[index] });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

/* ------------------------------------------------------------------ */
/* Verdict contract                                                    */
/* ------------------------------------------------------------------ */

/**
 * Whether a verdict carries every field the dashboard and the database depend
 * on: the category, a numeric score, a justification, and the resume the score
 * belongs to.
 *
 * `best_resume_id` is allowed to be null in exactly one case - the user has no
 * resumes at all - because there is then no id to name, and refusing to store
 * such a row would hide the "upload a resume" prompt the score carries.
 *
 * @param {object|null|undefined} matchData
 * @returns {{ok:boolean, missing:Array<string>}}
 */
function verifyMatchShape(matchData) {
  const missing = [];
  if (!matchData || typeof matchData !== 'object') return { ok: false, missing: ['match_data'] };

  if (matchData.job_type !== JOB_TYPES.INTERNSHIP && matchData.job_type !== JOB_TYPES.FULL_TIME) missing.push('job_type');
  if (!Number.isFinite(Number(matchData.score))) missing.push('score');
  if (!String(matchData.reason || '').trim()) missing.push('reason');
  if (!('best_resume_id' in matchData)) missing.push('best_resume_id');

  return { ok: missing.length === 0, missing };
}

/**
 * Whether a verdict clears the storage bar (see `MIN_MATCH_SCORE`).
 *
 * @param {object|null|undefined} matchData
 * @param {number} [minimum]
 * @returns {boolean}
 */
function meetsMatchBar(matchData, minimum = MIN_MATCH_SCORE) {
  return Number(matchData?.score) >= minimum;
}

module.exports = {
  matchJob,
  matchJobsForUser,
  buildSearchQueries,
  analyzeResumes,
  verifyMatchShape,
  meetsMatchBar,
  MIN_MATCH_SCORE,
  heuristicMatch,
  gatedMatch,
  keywordScore,
  classifyJobType,
  normalizeJobType,
  parseMatchData,
  reconcileCompensation,
  parseVerdict,
  extractJson,
  clampScore,
  JOB_TYPES,
  MODEL,
  BASE_URL,
  isLlmEnabled: () => Boolean(client),
};
