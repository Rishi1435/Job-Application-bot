/**
 * Resume matching engine.
 *
 * Sends each scraped job description plus the candidate resume to an LLM hosted
 * on the NVIDIA API catalog (OpenAI-compatible endpoint) and asks for a strict
 * JSON verdict:
 *
 *   { "score": 0-100, "reason": "one sentence" }
 *
 * Design notes:
 *  - The model occasionally wraps JSON in prose or code fences, so the response
 *    is parsed defensively rather than with a bare `JSON.parse`.
 *  - Transient failures (429 / 5xx / network) are retried with backoff.
 *  - Without `NVIDIA_API_KEY` the engine degrades to a local keyword-overlap
 *    score so the rest of the pipeline stays usable offline.
 */

const { OpenAI } = require('openai');
const { TARGET_ROLE, RESUME_TEXT } = require('../config/profile');

require('dotenv').config();

/** Model from the NVIDIA API catalog. Override with NVIDIA_MODEL. */
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const BASE_URL = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
const API_KEY = process.env.NVIDIA_API_KEY;

/** Job descriptions are truncated to keep prompts (and cost) bounded. */
const MAX_DESCRIPTION_CHARS = Number(process.env.MAX_DESCRIPTION_CHARS || 6000);
const MAX_RETRIES = Number(process.env.MATCHER_MAX_RETRIES || 3);
const REQUEST_TIMEOUT_MS = Number(process.env.MATCHER_TIMEOUT_MS || 120000);

/**
 * Generation settings. The defaults suit reasoning models such as
 * `nvidia/nemotron-*`, where `max_tokens` has to cover the hidden thinking pass
 * *and* the JSON answer - a tight budget truncates the response before the JSON
 * is ever emitted. Non-reasoning models (e.g. `meta/llama-3.3-70b-instruct`)
 * simply ignore `reasoning_budget`.
 */
const MAX_TOKENS = Number(process.env.MATCHER_MAX_TOKENS || 4096);
const REASONING_BUDGET = Number(process.env.MATCHER_REASONING_BUDGET || 2048);
const TEMPERATURE = Number(process.env.MATCHER_TEMPERATURE ?? 0.6);
const TOP_P = Number(process.env.MATCHER_TOP_P ?? 0.95);

const client = API_KEY
  ? new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY, timeout: REQUEST_TIMEOUT_MS, maxRetries: 0 })
  : null;

if (!client) {
  console.warn('[matcher] NVIDIA_API_KEY is not set - falling back to local keyword scoring.');
}

/** Instructs the model to behave like a recruiter and emit JSON only. */
const SYSTEM_PROMPT = `You are an expert technical recruiter with 15 years of experience screening software engineering candidates.

You will be given a candidate profile and a job description. Analyse the job's hard requirements (languages, frameworks, platforms, seniority, domain) against the candidate's actual stack. Reward genuine overlap, penalise missing must-have technologies, and do not be generous: a job in an unrelated stack must score low even if the title sounds similar.

Scoring guide:
  90-100  near-perfect fit; the candidate's core stack is exactly what is asked for
  70-89   strong fit; most must-haves are covered, minor gaps only
  50-69   partial fit; transferable skills but real gaps in must-have technology
  25-49   weak fit; different primary stack or seniority mismatch
  0-24    not relevant to this candidate

Respond with ONLY a strict JSON object, no markdown, no commentary, in exactly this shape:
{"score": <integer 0-100>, "reason": "<one sentence naming the strongest overlapping skills or the decisive missing gaps>"}

CANDIDATE TARGET ROLE:
${TARGET_ROLE}

CANDIDATE RESUME:
${RESUME_TEXT}`;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts the JSON verdict from a raw model response, tolerating code fences
 * and stray prose around the object.
 *
 * @param {string} raw model output
 * @returns {{score:number, reason:string}|null} parsed verdict, or null
 */
function parseVerdict(raw) {
  if (!raw || typeof raw !== 'string') return null;

  const candidates = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  const braced = trimmed.match(/\{[\s\S]*\}/);
  if (braced) candidates.push(braced[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'score' in parsed) {
        return {
          score: clampScore(parsed.score),
          reason: String(parsed.reason || 'No justification returned by the model.').trim(),
        };
      }
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
 * True for errors that are worth retrying (rate limits, server errors, sockets).
 * @param {any} error
 * @returns {boolean}
 */
function isRetryable(error) {
  const status = error?.status || error?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  const code = error?.code || '';
  return ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
}

/* ------------------------------------------------------------------ */
/* Offline fallback                                                    */
/* ------------------------------------------------------------------ */

/** Skills the resume claims, weighted by how central they are to the profile. */
const SKILL_WEIGHTS = {
  'node.js': 10, node: 8, express: 8, javascript: 6, typescript: 5,
  'spring boot': 10, spring: 7, java: 8, flutter: 10, dart: 8, mobile: 6,
  android: 5, ios: 4, react: 5, 'full stack': 8, fullstack: 8, rest: 4,
  api: 4, sql: 4, postgresql: 4, mysql: 4, sqlite: 3, mongodb: 4,
  firebase: 4, docker: 3, git: 2, aws: 3,
};

/**
 * Deterministic keyword-density score used when the LLM is unavailable.
 * Never throws, always returns a usable verdict.
 *
 * @param {string} description job description text
 * @returns {{score:number, reason:string, engine:'keyword'}}
 */
function keywordScore(description) {
  const text = String(description || '').toLowerCase();
  if (!text.trim()) {
    return { score: 0, reason: 'No job description available to score.', engine: 'keyword' };
  }

  const hits = [];
  let earned = 0;
  for (const [skill, weight] of Object.entries(SKILL_WEIGHTS)) {
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

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Scores a single job description against the configured resume.
 *
 * @param {string} jobDescription raw description text
 * @param {{title?:string, company?:string}} [context] optional job metadata for the prompt
 * @returns {Promise<{score:number, reason:string, engine:'llm'|'keyword'}>}
 */
async function matchJob(jobDescription, context = {}) {
  const description = String(jobDescription || '').slice(0, MAX_DESCRIPTION_CHARS);

  if (!client) return keywordScore(description);
  if (!description.trim()) {
    return { score: 0, reason: 'No job description available to score.', engine: 'keyword' };
  }

  const userMessage = [
    context.title ? `JOB TITLE: ${context.title}` : '',
    context.company ? `COMPANY: ${context.company}` : '',
    'JOB DESCRIPTION:',
    description,
  ]
    .filter(Boolean)
    .join('\n');

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
        // Passed through to the NVIDIA endpoint; ignored by non-reasoning models.
        reasoning_budget: REASONING_BUDGET,
      });

      const choice = completion?.choices?.[0];
      const message = choice?.message || {};

      // Reasoning models answer in `content` and think in `reasoning_content`.
      // If the budget ran out mid-thought the JSON can end up in the latter.
      const verdict = parseVerdict(message.content) || parseVerdict(message.reasoning_content);

      if (verdict) return { ...verdict, engine: 'llm' };

      const truncated = choice?.finish_reason === 'length' ? ' (hit the token limit - raise MATCHER_MAX_TOKENS)' : '';
      lastError = new Error(
        `Model returned unparseable output${truncated}: ${String(message.content || message.reasoning_content).slice(0, 200)}`
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

  console.error(`[matcher] LLM scoring failed, using keyword fallback: ${lastError?.message}`);
  const fallback = keywordScore(description);
  return { ...fallback, reason: `${fallback.reason} (LLM unavailable: ${lastError?.message || 'unknown error'})` };
}

/**
 * Scores many jobs with bounded concurrency so the provider is not hammered.
 *
 * @param {Array<{description?:string, title?:string, company?:string}>} jobs
 * @param {{concurrency?:number}} [options]
 * @returns {Promise<Array<{score:number, reason:string, engine:string}>>} verdicts, index-aligned with `jobs`
 */
async function matchJobs(jobs, options = {}) {
  const concurrency = Math.max(1, options.concurrency || Number(process.env.MATCHER_CONCURRENCY) || 3);
  const results = new Array(jobs.length);
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      results[index] = await matchJob(job.description, { title: job.title, company: job.company });
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

module.exports = {
  matchJob,
  matchJobs,
  keywordScore,
  parseVerdict,
  MODEL,
  TARGET_ROLE,
  RESUME_TEXT,
  isLlmEnabled: () => Boolean(client),
};
