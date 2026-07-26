/**
 * Compensation extraction and the pay bar.
 *
 * A posting is only recommended when the pay it advertises clears a floor:
 *
 *   quoted as base / salary / stipend-free pay  ->  >= MIN_LPA_SALARY (10 LPA)
 *   quoted as CTC                               ->  >= MIN_LPA_CTC    (15 LPA)
 *
 * The two thresholds differ because "CTC" bundles employer PF, gratuity,
 * insurance, bonus and ESOP notionals into the headline number, so a 15 LPA CTC
 * and a 10 LPA base are roughly the same offer. Judging both against one figure
 * would systematically over-value CTC postings.
 *
 * Postings that state no pay at all are *kept* and marked `stated: false` -
 * most US career pages omit salary entirely, and dropping them would empty the
 * board. Internships are exempt by default because a stipend is monthly and is
 * never expressed in LPA; set INTERNSHIP_ENFORCE_PAY=true to apply the bar to
 * them as well.
 *
 * Everything here is pure text -> numbers, so it is unit-tested in
 * `tests/units.test.js` and doubles as the offline fallback when the LLM is
 * unavailable.
 */

/** Rupees in one lakh - the unit "LPA" counts. */
const LAKH = 100000;

/** Bars, in LPA. */
const MIN_LPA_SALARY = Number(process.env.MIN_LPA_SALARY || 10);
const MIN_LPA_CTC = Number(process.env.MIN_LPA_CTC || 15);

/**
 * Foreign currency -> INR. Deliberately env-tunable: a stale rate silently
 * changes which jobs pass the bar.
 */
const FX = {
  INR: 1,
  USD: Number(process.env.INR_PER_USD || 88),
  EUR: Number(process.env.INR_PER_EUR || 95),
  GBP: Number(process.env.INR_PER_GBP || 112),
  CAD: Number(process.env.INR_PER_CAD || 63),
  AUD: Number(process.env.INR_PER_AUD || 58),
  SGD: Number(process.env.INR_PER_SGD || 66),
};

/** Full-time hours in a year, for hourly rates. */
const HOURS_PER_YEAR = 2080;

/** Words that mean the number is a cost-to-company figure, not base pay. */
const CTC_PATTERN = /\b(ctc|cost\s+to\s+company|total\s+(compensation|comp|package)|package|fixed\s*\+\s*variable)\b/gi;

/** Words that mean the number is base/gross pay. */
const SALARY_PATTERN = /\b(salary|base\s+(pay|salary)|gross|in[-\s]?hand|take[-\s]?home|pay\s+range|annual\s+pay|per\s+annum)\b/gi;

/** Words that mean the number is a stipend rather than an annual salary. */
const STIPEND_PATTERN = /\b(stipend|per\s+month\s+intern|intern(ship)?\s+(pay|stipend))\b/gi;

/** "no CTC", "excluding CTC" - a mention, not a claim about this figure. */
const NEGATION_PATTERN = /\b(no|not|without|excluding|excludes|apart\s+from|besides)\s*$/i;

/**
 * Money that is not this candidate's pay. Job pages are full of it - research
 * compute budgets, relocation and signing bonuses, tuition support, funding
 * rounds, company revenue - and every one of those numbers looks exactly like a
 * salary to a regex. A figure sitting next to any of these words is skipped and
 * the scan moves on to the next one.
 */
const NON_PAY_PATTERN =
  /\b(compute|funding|fund(s|ed|raising)?|budget|grant|credits?|revenue|valuation|arr|raised|expenses?|reimburse\w*|relocation|signing\s+bonus|sign[-\s]?on|referral|tuition|scholarship|donation|cost\s+of\s+living|market\s+cap|price)\b/gi;

/* ------------------------------------------------------------------ */
/* Number parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parses a human-written amount into a plain number.
 * Handles "1,20,000" (Indian grouping), "120,000", "120k", "1.2".
 *
 * @param {string} raw
 * @param {string} [suffix] 'k' | 'm' | ''
 * @returns {number}
 */
function toNumber(raw, suffix = '') {
  const value = Number(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(value)) return NaN;
  if (/^k$/i.test(suffix)) return value * 1000;
  if (/^m$/i.test(suffix)) return value * 1000000;
  return value;
}

/**
 * Converts an amount to LPA (lakhs of rupees per year).
 *
 * @param {number} amount
 * @param {{currency?:string, period?:'year'|'month'|'hour', unit?:'lakh'|'crore'|'plain'}} options
 * @returns {number} LPA, rounded to one decimal
 */
function toLpa(amount, options = {}) {
  const { currency = 'INR', period = 'year', unit = 'plain' } = options;
  if (!Number.isFinite(amount)) return NaN;

  let rupees = amount * (FX[currency.toUpperCase()] || 1);
  if (unit === 'lakh') rupees = amount * LAKH;
  if (unit === 'crore') rupees = amount * LAKH * 100;

  if (period === 'month') rupees *= 12;
  if (period === 'week') rupees *= 52;
  if (period === 'hour') rupees *= HOURS_PER_YEAR;

  return Math.round((rupees / LAKH) * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

/** Currency symbol or code, before or after the amount ("$150,000", "3,850 USD"). */
const CURRENCY = String.raw`(?:\$|usd|€|eur|£|gbp|cad|aud|sgd|c\$|a\$|s\$)`;

/**
 * Each matcher yields `{min, max, currency, period, unit}` from a text match.
 * They are tried in order and the first credible hit wins, so the most specific
 * ("18-24 LPA", "$5,000 per month") comes before the most generic ("$120,000") -
 * otherwise a monthly rate would be read as an annual salary.
 */
const PATTERNS = [
  {
    // "12 LPA", "12-18 LPA", "12 to 18 lakhs per annum", "INR 15 lakh p.a."
    name: 'lpa',
    regex:
      /(?:₹|rs\.?|inr\s*)?\s*(\d+(?:\.\d+)?)\s*(?:-|–|to)?\s*(\d+(?:\.\d+)?)?\s*(?:lpa|lakhs?\s*(?:per\s+annum|p\.?a\.?|\/\s*(?:year|yr|annum))?|l\s*p\.?\s*a\.?)/gi,
    build: (m) => ({ min: toNumber(m[1]), max: toNumber(m[2] || m[1]), currency: 'INR', period: 'year', unit: 'lakh' }),
  },
  {
    // "₹1,20,000 per month", "INR 45,000/month", "60,000 INR per month"
    name: 'inr-monthly',
    regex:
      /(?:₹|rs\.?|inr)\s*(\d[\d,]*)(?:\s*(?:-|–|to)\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*))?\s*(?:inr|rs\.?)?\s*(?:per\s+month|\/\s*month|pm\b|monthly)|(\d[\d,]*)\s*(?:₹|inr|rs\.?)\s*(?:per\s+month|\/\s*month|monthly)/gi,
    build: (m) => {
      const min = toNumber(m[1] ?? m[3]);
      return { min, max: toNumber(m[2] ?? m[3] ?? m[1]), currency: 'INR', period: 'month', unit: 'plain' };
    },
  },
  {
    // "₹12,00,000 - ₹18,00,000", "INR 1200000 per year"
    name: 'inr-annual',
    regex: /(?:₹|rs\.?|inr)\s*(\d[\d,]*)(?:\s*(?:-|–|to)\s*(?:₹|rs\.?|inr)?\s*(\d[\d,]*))?/gi,
    build: (m) => ({ min: toNumber(m[1]), max: toNumber(m[2] || m[1]), currency: 'INR', period: 'year', unit: 'plain' }),
  },
  {
    // "$50 - $70 per hour", "USD 65/hr"
    name: 'foreign-hourly',
    regex: new RegExp(
      `(?:${CURRENCY}\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\s*(?:${CURRENCY})?\\s*(?:-|–|to)?\\s*(?:${CURRENCY}\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)?\\s*(?:${CURRENCY})?\\s*(?:per\\s+hour|\\/\\s*(?:hour|hr)\\b|hourly)`,
      'gi'
    ),
    build: (m, text) => ({
      min: toNumber(m[1], m[2]),
      max: toNumber(m[3] || m[1], m[2]),
      currency: detectCurrency(text),
      period: 'hour',
      unit: 'plain',
    }),
  },
  {
    // "Weekly stipend of 3,850 USD", "$2,000 per week"
    name: 'foreign-weekly',
    regex: new RegExp(
      `(?:${CURRENCY}\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\s*(?:${CURRENCY})?\\s*(?:-|–|to)?\\s*(?:${CURRENCY}\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)?\\s*(?:${CURRENCY})?\\s*(?:per\\s+week|\\/\\s*(?:week|wk)\\b|weekly)`,
      'gi'
    ),
    build: (m, text) => ({
      min: toNumber(m[1], m[2]),
      max: toNumber(m[3] || m[1], m[2]),
      currency: detectCurrency(text),
      period: 'week',
      unit: 'plain',
    }),
  },
  {
    // "$5,000 per month", "$15k/month" - must beat the annual pattern below,
    // or a monthly figure is inflated twelve-fold.
    name: 'foreign-monthly',
    regex: new RegExp(
      `(?:${CURRENCY}\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\s*(?:${CURRENCY})?\\s*(?:-|–|to)?\\s*(?:${CURRENCY}\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)?\\s*(?:${CURRENCY})?\\s*(?:per\\s+month|\\/\\s*(?:month|mo)\\b|monthly)`,
      'gi'
    ),
    build: (m, text) => ({
      min: toNumber(m[1], m[2]),
      max: toNumber(m[3] || m[1], m[2]),
      currency: detectCurrency(text),
      period: 'month',
      unit: 'plain',
    }),
  },
  {
    // "$120,000 - $180,000", "$120k-$180k", "USD 150,000 per year", "€90k"
    name: 'foreign-annual',
    regex: new RegExp(
      `${CURRENCY}\\s*(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k|m)?\\s*(?:-|–|to)?\\s*(?:${CURRENCY})?\\s*(\\d[\\d,]*(?:\\.\\d+)?)?\\s*(k|m)?`,
      'gi'
    ),
    build: (m, text) => ({
      min: toNumber(m[1], m[2]),
      max: toNumber(m[3] || m[1], m[3] ? m[4] : m[2]),
      currency: detectCurrency(text),
      period: 'year',
      unit: 'plain',
    }),
  },
];

/** Keywords after the figure are this much less relevant than ones before it. */
const TRAILING_PENALTY = 2;

/**
 * Distance from `position` to the nearest non-negated match of `pattern`.
 *
 * Proximity decides the kind of figure: "Salary: 7 LPA. No CTC breakdown given."
 * mentions both words, but "Salary" sits on the number and the CTC mention is
 * both further away and negated. A plain "does the window contain 'CTC'" test
 * gets this exactly backwards.
 *
 * Keywords *before* the number count double, because that is where the label
 * almost always sits ("Signing bonus of $20,000", "CTC: 12 LPA"). Without the
 * asymmetry, "Signing bonus of $20,000. Base salary $140,000" reads the bonus
 * as the salary, since "salary" happens to be a few characters closer.
 *
 * @param {string} context text around the figure
 * @param {number} position index of the figure inside `context`
 * @param {RegExp} pattern global-flagged keyword pattern
 * @returns {number} weighted character distance, or Infinity when nothing qualifies
 */
function nearestKeywordDistance(context, position, pattern) {
  pattern.lastIndex = 0;
  let best = Infinity;
  let match;

  while ((match = pattern.exec(context)) !== null) {
    // "no CTC", "excluding CTC" mention the concept to rule it out.
    if (NEGATION_PATTERN.test(context.slice(Math.max(0, match.index - 14), match.index))) continue;

    const gap = Math.abs(match.index - position);
    best = Math.min(best, match.index > position ? gap * TRAILING_PENALTY : gap);
  }

  return best;
}

/**
 * Currency from the symbol/code nearest the amount.
 * @param {string} text
 * @returns {string} ISO code
 */
function detectCurrency(text) {
  if (/€|\beur\b/i.test(text)) return 'EUR';
  if (/£|\bgbp\b/i.test(text)) return 'GBP';
  if (/\bcad\b|\bc\$/i.test(text)) return 'CAD';
  if (/\baud\b|\ba\$/i.test(text)) return 'AUD';
  if (/\bsgd\b|\bs\$/i.test(text)) return 'SGD';
  return 'USD';
}

/**
 * Extracts pay from free text.
 *
 * The window around the match decides the *kind* of number: "CTC 18 LPA" is a
 * package, "stipend of ₹50,000/month" is a stipend, everything else is base
 * pay. Only the first credible figure is used - job pages repeat equity and
 * bonus numbers that would otherwise be mistaken for salary.
 *
 * @param {string} text job description (title may be prepended)
 * @returns {{stated:boolean, type:'ctc'|'salary'|'stipend'|'none', min_lpa:number|null, max_lpa:number|null, currency:string|null, period:string|null, raw:string|null}}
 */
function parseCompensation(text) {
  const source = String(text || '');
  const none = { stated: false, type: 'none', min_lpa: null, max_lpa: null, currency: null, period: null, raw: null };
  if (!source.trim()) return none;

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;

    // Every occurrence is examined, not just the first: the first money figure
    // on a job page is frequently a compute budget or a signing bonus, and the
    // real pay sits further down.
    while ((match = pattern.regex.exec(source)) !== null) {
      const parsed = pattern.build(match, match[0]);
      if (!Number.isFinite(parsed.min)) continue;

      // 80 characters either side is enough to catch "CTC:" / "stipend of".
      const start = Math.max(0, match.index - 80);
      const context = source.slice(start, match.index + match[0].length + 80);
      const positionInContext = match.index - start;

      const ctcDistance = nearestKeywordDistance(context, positionInContext, CTC_PATTERN);
      const salaryDistance = nearestKeywordDistance(context, positionInContext, SALARY_PATTERN);
      const stipendDistance = nearestKeywordDistance(context, positionInContext, STIPEND_PATTERN);
      const nonPayDistance = nearestKeywordDistance(context, positionInContext, NON_PAY_PATTERN);
      const payDistance = Math.min(ctcDistance, salaryDistance, stipendDistance);

      // Money that belongs to something else. Distance decides, exactly as it
      // does for CTC-vs-salary: "Signing bonus of $20,000. Base salary
      // $140,000" must still yield the salary, while "Funding for compute
      // (~$15k/month)" must yield nothing.
      if (nonPayDistance < payDistance) continue;

      const minLpa = toLpa(parsed.min, parsed);
      const maxLpa = toLpa(parsed.max, parsed);

      // A "salary" of 0.2 LPA is a typo, a page number or a stray "$1"; ignore
      // it rather than reporting a posting as below the bar on nonsense.
      if (!Number.isFinite(minLpa) || maxLpa < 1) continue;

      return {
        stated: true,
        // Whichever label sits closest to the number describes it.
        type:
          stipendDistance <= Math.min(ctcDistance, salaryDistance) && stipendDistance < Infinity
            ? 'stipend'
            : ctcDistance < salaryDistance
              ? 'ctc'
              : 'salary',
        min_lpa: minLpa,
        max_lpa: maxLpa,
        currency: parsed.currency,
        period: parsed.period,
        raw: match[0].trim().slice(0, 80),
      };
    }
  }

  return none;
}

/* ------------------------------------------------------------------ */
/* The bar                                                             */
/* ------------------------------------------------------------------ */

/**
 * The floor a posting of this kind has to clear.
 * @param {string} type
 * @returns {number} LPA
 */
const barFor = (type) => (type === 'ctc' ? MIN_LPA_CTC : MIN_LPA_SALARY);

/**
 * Decides whether a posting clears the pay bar.
 *
 * The *upper* end of a stated range is compared against the bar: a
 * "8 - 20 LPA" posting is worth recommending, and job ads routinely quote a
 * wide band that starts below what they actually pay for a strong candidate.
 *
 * @param {object} compensation output of `parseCompensation` (or the LLM's)
 * @param {{jobType?:string}} [context] `'Internship'` is exempt by default
 * @returns {{meets:boolean, bar:number|null, note:string}}
 */
function meetsPayBar(compensation, context = {}) {
  const comp = compensation || {};
  const enforceOnInternships = String(process.env.INTERNSHIP_ENFORCE_PAY || 'false').toLowerCase() === 'true';

  if (context.jobType === 'Internship' && !enforceOnInternships) {
    return { meets: true, bar: null, note: 'Internship - pay bar not applied (stipends are monthly).' };
  }

  if (!comp.stated || comp.type === 'none' || !Number.isFinite(Number(comp.max_lpa))) {
    return { meets: true, bar: null, note: 'No compensation stated on the listing.' };
  }

  if (comp.type === 'stipend' && !enforceOnInternships) {
    return { meets: true, bar: null, note: `Stipend (${comp.raw || 'monthly pay'}) - annual bar not applied.` };
  }

  const bar = barFor(comp.type);
  const best = Number(comp.max_lpa);
  const meets = best >= bar;
  const label = comp.type === 'ctc' ? 'CTC' : 'salary';

  return {
    meets,
    bar,
    note: meets
      ? `${label} up to ${best} LPA clears the ${bar} LPA bar.`
      : `${label} tops out at ${best} LPA, below the ${bar} LPA bar for ${label} postings.`,
  };
}

/**
 * Human-readable pay, for the dashboard and the Excel export.
 *
 * @param {object} compensation
 * @returns {string}
 */
function formatCompensation(compensation) {
  const comp = compensation || {};
  if (!comp.stated || !Number.isFinite(Number(comp.max_lpa))) return 'Not stated';

  const range = comp.min_lpa === comp.max_lpa ? `${comp.max_lpa}` : `${comp.min_lpa}-${comp.max_lpa}`;
  const kind = comp.type === 'ctc' ? ' CTC' : comp.type === 'stipend' ? ' stipend' : '';
  const original = comp.currency && comp.currency !== 'INR' ? ` (${comp.raw})` : '';
  return `${range} LPA${kind}${original}`;
}

module.exports = {
  parseCompensation,
  meetsPayBar,
  formatCompensation,
  toLpa,
  barFor,
  MIN_LPA_SALARY,
  MIN_LPA_CTC,
  FX,
};
