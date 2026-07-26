/**
 * Candidate profile & posting relevance.
 *
 * The matcher used to send every scraped posting to the LLM and trust whatever
 * score came back. That produced a board full of roles the candidate cannot
 * apply for - "Director, IT", "Client Partner", "Staff Software Engineer" - all
 * scored 55-85, because a model asked "how well does this resume fit?" answers
 * on *skill overlap* and quietly ignores that the posting wants twelve years of
 * experience or belongs to a sales org.
 *
 * Two things are decided here instead, deterministically, before any LLM call:
 *
 *   1. ROLE FAMILY - a backend engineer is not a candidate for a marketing or
 *      legal opening no matter how many keywords overlap.
 *   2. SENIORITY   - a posting more than one rung above the candidate is a
 *      rejection, not a "partial fit".
 *
 * Both are cheap, explainable and stable across runs, which a prompt is not.
 * A posting that fails either gate never reaches the model at all: it is stored
 * with a capped score and a plain-English reason, and hidden from the board
 * unless the user asks to see mismatches.
 */

/* ------------------------------------------------------------------ */
/* Seniority ladder                                                    */
/* ------------------------------------------------------------------ */

/**
 * Rungs on the career ladder. The numbers are what matter: the gate compares
 * `postingLevel - candidateLevel`, so the spacing encodes how big a jump is.
 */
const LEVELS = {
  intern: 0,
  entry: 1,
  mid: 2,
  senior: 3,
  staff: 4,
  principal: 5,
  director: 6,
  executive: 7,
};

/** Human labels for the UI, indexed by level number. */
const LEVEL_LABELS = ['Intern', 'Entry level', 'Mid level', 'Senior', 'Staff', 'Principal', 'Director', 'Executive'];

/**
 * Title patterns, tested **most senior first** so "Senior Director" reads as
 * director and "Staff Software Engineer" never matches the `entry` rule via the
 * word "Software".
 *
 * @type {Array<[number, RegExp]>}
 */
const LEVEL_PATTERNS = [
  [LEVELS.executive, /\b(chief|c[tepifo]o|svp|evp|vice[\s-]?president|vp)\b|\bhead\s+of\b/i],
  [LEVELS.director, /\b(director|dir\.)\b/i],
  [LEVELS.principal, /\b(principal|distinguished|architect)\b/i],
  // People-management and technical-leadership titles sit at staff+ in practice:
  // both expect someone who has already shipped for years.
  [LEVELS.staff, /\b(staff|manager|mgr\.?|tech(nical)?\s+lead|team\s+lead|lead\s+engineer)\b/i],
  [LEVELS.senior, /\b(senior|sr\.?|snr\.?)\b|\b(iii|iv|v)\b|\bl[5-9]\b/i],
  [
    LEVELS.entry,
    /\b(junior|jr\.?|entry[\s-]?level|new\s?grad(uate)?|graduate|associate|fresher|campus|early[\s-]?career|university)\b|\bl[12]\b/i,
  ],
];

/** Titles that mean "student programme" rather than a permanent hire. */
const INTERNSHIP_PATTERN =
  /\b(intern|internship|co[\s-]?op|summer\s+(analyst|associate|programme|program)|industrial\s+placement|apprentice(ship)?|working\s+student|student\s+(worker|assistant|programme|program)|trainee|fellows?\s+program(me)?|residency)\b/i;

/**
 * Seniority a posting is asking for.
 *
 * The title is authoritative - it is the one field boards write carefully. The
 * description is only consulted for an explicit years-of-experience demand,
 * which can promote an innocuous-looking title ("Software Engineer, 8+ years").
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {{level:number, label:string, requiredYears:number|null}}
 */
function detectPostingLevel(title, description = '') {
  const text = String(title || '');

  if (INTERNSHIP_PATTERN.test(text)) {
    return { level: LEVELS.intern, label: LEVEL_LABELS[LEVELS.intern], requiredYears: null };
  }

  let level = null;
  for (const [candidate, pattern] of LEVEL_PATTERNS) {
    if (pattern.test(text)) {
      level = candidate;
      break;
    }
  }

  // "5+ years of experience" in the body. Only the *smallest* stated minimum is
  // used: postings often list a high bar for one specialism and a lower one for
  // the role itself, and the lower number is the real gate.
  const requiredYears = smallestYearsRequirement(description);
  if (requiredYears !== null) {
    const fromYears = levelForYears(requiredYears);
    // Never let the body pull a title *down* - "Director (3+ years managing)"
    // is still a director role.
    level = level === null ? fromYears : Math.max(level, fromYears);
  }

  // An un-prefixed "Software Engineer" is a mid-level opening at most companies.
  const resolved = level === null ? LEVELS.mid : level;
  return { level: resolved, label: LEVEL_LABELS[resolved], requiredYears };
}

/**
 * Smallest "N+ years of experience" figure stated in a description.
 *
 * @param {string} text
 * @returns {number|null} years, or null when the posting states none
 */
function smallestYearsRequirement(text) {
  const matches = String(text || '').matchAll(/(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?\b[^.]{0,40}?\bexperience\b/gi);
  let smallest = null;
  for (const match of matches) {
    const years = Number(match[1]);
    if (!Number.isFinite(years) || years <= 0 || years > 30) continue;
    if (smallest === null || years < smallest) smallest = years;
  }
  return smallest;
}

/**
 * Maps a years-of-experience requirement onto the ladder.
 * @param {number} years
 * @returns {number} level
 */
function levelForYears(years) {
  if (years < 1) return LEVELS.entry;
  if (years < 3) return LEVELS.entry;
  if (years < 5) return LEVELS.mid;
  if (years < 8) return LEVELS.senior;
  if (years < 12) return LEVELS.staff;
  return LEVELS.principal;
}

/* ------------------------------------------------------------------ */
/* Role families                                                       */
/* ------------------------------------------------------------------ */

/**
 * What kind of job this is, independent of seniority.
 *
 * Order matters: the first family whose pattern matches the title wins, so the
 * narrow non-engineering families are tested before the broad `engineering`
 * one. That is what stops "Agency Development Manager" and "Data Operations
 * Manager" from being read as engineering roles because of a stray keyword.
 *
 * @type {Array<{id:string, label:string, pattern:RegExp}>}
 */
const ROLE_FAMILIES = [
  {
    id: 'sales',
    label: 'Sales & partnerships',
    pattern:
      /\b(sales|account\s+(executive|manager|director)|client\s+partner|customer\s+success|business\s+development|agency\s+development|partnerships?|revenue|quota|go[\s-]?to[\s-]?market|gtm)\b/i,
  },
  {
    id: 'marketing',
    label: 'Marketing & growth',
    pattern:
      /\b(marketing|brand|communications?|public\s+relations|content\s+(strategist|manager|writer)|copywriter|seo|social\s+media|growth\s+(manager|lead|marketer)|demand\s+gen)\b/i,
  },
  {
    id: 'people',
    label: 'People & recruiting',
    pattern: /\b(recruit(er|ing|ment)|talent|sourcer|human\s+resources|\bhr\b|people\s+(ops|operations|partner)|compensation\s+&?\s*benefits)\b/i,
  },
  {
    id: 'finance',
    label: 'Finance & accounting',
    pattern: /\b(financ(e|ial)|account(ant|ing)|controller|treasury|fp&a|audit|payroll|bookkeep)/i,
  },
  {
    id: 'legal',
    label: 'Legal, policy & compliance',
    pattern: /\b(legal|counsel|attorney|paralegal|compliance|regulatory|policy\s+(manager|lead|analyst)|privacy\s+(counsel|manager)|governance\s+risk|\baml\b|anti[\s-]?money)\b/i,
  },
  {
    id: 'support',
    label: 'Support & IT helpdesk',
    pattern: /\b(customer\s+(support|service)|technical\s+support|help\s?desk|service\s+desk|it\s+(support|operations|helpdesk)|desktop\s+support)\b/i,
  },
  {
    id: 'operations',
    label: 'Business operations',
    pattern:
      /\b(business\s+operations|operations\s+(manager|analyst|lead|associate|specialist)|workplace|facilities|procurement|supply\s+chain|logistics|program\s+manager|chief\s+of\s+staff|data\s+operations)\b/i,
  },
  {
    id: 'product',
    label: 'Product management',
    pattern: /\b(product\s+(manager|management|owner|lead|director)|\bpm\b|technical\s+program\s+manager|\btpm\b)\b/i,
  },
  {
    id: 'media',
    label: 'Media & production',
    pattern: /\b(filmmaker|videographer|photographer|video\s+(editor|producer)|producer|creative\s+director|illustrator|animator|editorial)\b/i,
  },
  {
    id: 'design',
    label: 'Design',
    pattern: /\b(designer|(product|graphic|visual|interaction)\s+design|design\s+(engineer|lead|manager|systems?)|\bux\b|\bui\b|user\s+experience|user\s+research|brand\s+studio|motion\s+graphics)\b/i,
  },
  {
    id: 'research',
    label: 'Research science',
    pattern: /\b(research\s+(scientist|engineer|manager|lead)|fellows?\s+program(me)?|residency|\bphd\b|publications?)\b/i,
  },
  {
    id: 'data',
    label: 'Data, ML & analytics',
    pattern:
      /\b(data\s+(engineer|scientist|analyst|analytics)|business\s+analyst|analytics?\s+(engineer|analyst|manager|lead|specialist)?|machine\s+learning|\bml\b|\bai\b|deep\s+learning|business\s+intelligence|\bbi\b|statistic(s|ian)|quantitative|reporting\s+analyst|insights?\s+analyst)\b/i,
  },
  {
    id: 'engineering',
    label: 'Software engineering',
    // `engineer(ing)?` rather than the bare noun: a `\bengineer\b` alternation
    // silently fails on "Engineering Manager", which is how a dozen EM postings
    // ended up classified as "Other".
    //
    // `developer` but NOT bare `development` - that word belongs to "business
    // development", "learning & development" and "music development" at least as
    // often as it does to software, and every real engineering title carrying it
    // ("Software Development Engineer") also matches on another alternative.
    pattern:
      /\b(engineer(ing)?|developer|programmer|sde|swe|software|backend|back[\s-]end|frontend|front[\s-]end|full[\s-]?stack|mobile|android|ios|web|platform|infrastructure|sre|site\s+reliability|devops|cloud|security\s+engineer|qa|quality\s+assurance|test\s+engineer|systems?\s+engineer)\b/i,
  },
];

/**
 * Families a candidate can credibly cross into.
 *
 * Two rules shaped this map, both learned from wrong output:
 *
 * Engineering does *not* reach design or product. Sharing a building with them
 * is not the same as being a plausible applicant, and including them put
 * "Graphic Designer - Intern" and "Motion Designer" on a backend engineer's board.
 *
 * Adjacency is **not symmetric**. A software engineer can credibly apply to data
 * engineering, but a business-analytics graduate is not a candidate for a backend
 * role - so `engineering` reaches `data` while `data` does not reach back. Making
 * it symmetric is what showed two people in genuinely different fields the same
 * list of jobs.
 */
const ADJACENT_FAMILIES = {
  engineering: ['data', 'research'],
  data: ['research', 'product', 'finance'],
  research: ['data'],
  design: ['product'],
  product: ['data', 'design', 'operations'],
  finance: ['data', 'operations'],
  marketing: ['sales', 'product'],
  sales: ['marketing', 'operations'],
  people: ['operations'],
  operations: ['people', 'product'],
  legal: [],
};

/**
 * Classifies a posting into a role family.
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {{id:string, label:string}}
 */
function detectRoleFamily(title, description = '') {
  const text = String(title || '');

  for (const family of ROLE_FAMILIES) {
    if (family.pattern.test(text)) return { id: family.id, label: family.label };
  }

  // Titles too terse to classify ("Codex Core Agent") fall back to the body.
  // Engineering is included in this pass, so that reaching `other` genuinely
  // means "no signal anywhere" rather than "not obviously non-technical" -
  // which is what let "Cluster Head Middle Mile" onto an engineer's board.
  const body = String(description || '').slice(0, 1500);
  for (const family of ROLE_FAMILIES) {
    if (family.pattern.test(body)) return { id: family.id, label: family.label };
  }

  return { id: 'other', label: 'Other' };
}

/* ------------------------------------------------------------------ */
/* Candidate profile                                                   */
/* ------------------------------------------------------------------ */

/** Technologies looked for in resume text, used for the skills summary. */
const SKILL_VOCABULARY = [
  'javascript', 'typescript', 'node.js', 'express', 'react', 'next.js', 'vue', 'angular', 'svelte',
  'java', 'spring boot', 'kotlin', 'swift', 'flutter', 'dart', 'android', 'ios', 'react native',
  'python', 'django', 'flask', 'fastapi', 'go', 'golang', 'rust', 'c++', 'c#', '.net', 'php', 'ruby',
  'sql', 'postgresql', 'mysql', 'mongodb', 'dynamodb', 'redis', 'firebase', 'sqlite',
  'aws', 'azure', 'gcp', 'lambda', 'docker', 'kubernetes', 'terraform', 'jenkins', 'ci/cd',
  'graphql', 'rest api', 'microservices', 'kafka', 'spark',
  'machine learning', 'tensorflow', 'pytorch', 'nlp', 'data science', 'pandas',
];

/**
 * Evidence that a resume belongs to a given line of work.
 *
 * Deliberately not `ROLE_FAMILIES`: those patterns are tuned for job titles,
 * where every word is load-bearing, and they misfire badly on resume prose.
 *
 * Each family is scored rather than first-match-wins:
 *   `titles` - a role the candidate actually held, or a named qualification.
 *              Worth `TITLE_WEIGHT`, because it is the strongest possible signal.
 *   `skills` - tools of that trade. Worth one point each.
 *
 * Scoring matters because tools are shared across fields. Python and SQL appear
 * on a software engineer's resume and a business analyst's, so counting "3+
 * technical skills" as proof of software engineering - which an earlier version
 * did - labelled an MBA Business Analytics graduate a backend engineer and
 * showed her the same board as one.
 *
 * @type {Record<string, {titles: RegExp, skills: Array<string>}>}
 */
const FAMILY_EVIDENCE = {
  engineering: {
    titles:
      /\b(software\s+(developer|engineer)|full[\s-]?stack\s+(developer|engineer)|backend\s+(developer|engineer)|frontend\s+(developer|engineer)|mobile\s+(developer|engineer)|web\s+developer|android\s+developer|ios\s+developer|sde\b|swe\b|devops\s+engineer|site\s+reliability|qa\s+engineer|computer\s+science\s+engineering)\b/i,
    skills: [
      'node.js', 'express', 'react', 'angular', 'vue', 'spring boot', 'flutter', 'dart', 'django',
      'flask', 'kubernetes', 'docker', 'rest api', 'microservices', 'typescript', 'kotlin', 'swift',
      'jenkins', 'ci/cd', 'graphql', 'firebase', 'mongodb', 'aws', 'azure', 'gcp',
    ],
  },
  data: {
    titles:
      /\b(data\s+(analyst|scientist|engineer)|business\s+analytics|business\s+analyst|analytics\s+(engineer|intern)|machine\s+learning\s+(engineer|intern)|ml\s+engineer|business\s+intelligence|statistician|quantitative\s+analyst)\b/i,
    skills: [
      'sql', 'python', 'pandas', 'numpy', 'scikit-learn', 'tableau', 'power bi', 'powerbi', 'excel',
      'machine learning', 'tensorflow', 'pytorch', 'data analysis', 'data science', 'statistics',
      'time series', 'nlp', 'spark', 'hadoop',
    ],
  },
  research: {
    titles: /\b(research\s+(scientist|engineer|assistant|intern|fellow)|published\s+(a\s+)?paper|publications?\b|\bph\.?d\b|\bm\.?tech\b\s+thesis)/i,
    skills: ['research', 'publications', 'thesis', 'literature review'],
  },
  design: {
    titles: /\b((product|ux|ui|graphic|visual|motion)\s+designer|design\s+intern|b\.?des\b)/i,
    skills: ['figma', 'sketch', 'adobe xd', 'photoshop', 'illustrator', 'wireframe', 'prototyping', 'user research'],
  },
  product: {
    titles: /\b(product\s+(manager|owner|analyst)|associate\s+product\s+manager|\bapm\b|program\s+manager|project\s+manager)\b/i,
    skills: ['roadmap', 'jira', 'agile', 'scrum', 'stakeholder', 'user stories', 'product strategy'],
  },
  finance: {
    titles: /\b(financ(e|ial)\s+(analyst|associate|intern|manager)|account(ant|ing)|chartered\s+accountant|\bca\b\s+inter|controller|audit(or)?|\bmba\b\s*[-–]?\s*financ)/i,
    skills: ['tally', 'tally erp9', 'gst', 'financial modelling', 'financial modeling', 'valuation', 'bookkeeping', 'quickbooks'],
  },
  marketing: {
    titles: /\b(marketing\s+(intern|associate|manager|executive|analyst)|content\s+writer|copywriter|social\s+media\s+(manager|executive)|brand\s+(manager|executive)|digital\s+marketing|\bmba\b\s*[-–]?\s*marketing)/i,
    skills: ['seo', 'sem', 'google analytics', 'google ads', 'content strategy', 'campaign', 'hubspot', 'mailchimp'],
  },
  sales: {
    titles: /\b(sales\s+(executive|associate|manager|intern)|account\s+executive|business\s+development\s+(executive|manager|intern)|relationship\s+manager)\b/i,
    skills: ['salesforce', 'crm', 'lead generation', 'cold calling', 'pipeline', 'quota'],
  },
  people: {
    titles: /\b(hr\s+(intern|executive|manager|generalist|analyst)|human\s+resources|recruit(er|ment)\s+(intern|executive|manager)|talent\s+acquisition|\bmba\b\s*[-–]?\s*hr)/i,
    skills: ['recruitment', 'onboarding', 'payroll', 'hr analytics', 'employee engagement'],
  },
  operations: {
    titles: /\b(operations\s+(intern|executive|analyst|manager|associate)|supply\s+chain|logistics|procurement|assistant\s+manager\s+intern)\b/i,
    skills: ['supply chain', 'inventory', 'logistics', 'six sigma', 'lean', 'process improvement'],
  },
  legal: {
    titles: /\b(legal\s+(intern|associate|counsel)|paralegal|advocate|\bll\.?b\b|company\s+secretary)\b/i,
    skills: ['contracts', 'compliance', 'litigation', 'due diligence'],
  },
};

/** A held job title is worth this many skill mentions. */
const TITLE_WEIGHT = 3;
/** Total evidence a family needs before it is claimed. */
const FAMILY_THRESHOLD = 3;

/**
 * Scores every family against a resume and keeps the ones with real evidence.
 *
 * @param {string} text combined resume text
 * @returns {Array<string>} family ids, strongest first
 */
function detectCandidateFamilies(text) {
  const lower = String(text || '').toLowerCase();

  const scored = Object.entries(FAMILY_EVIDENCE)
    .map(([id, evidence]) => {
      const fromTitle = evidence.titles.test(text) ? TITLE_WEIGHT : 0;
      const fromSkills = evidence.skills.filter((skill) => lower.includes(skill)).length;
      return { id, score: fromTitle + fromSkills };
    })
    .filter((entry) => entry.score >= FAMILY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  // Anything within a point of the leader is a genuine second field (an MBA in
  // Business Analytics really is both data and product); anything further behind
  // is a shared tool, not a career.
  if (!scored.length) return [];
  const cutoff = Math.max(FAMILY_THRESHOLD, scored[0].score - 3);
  return scored.filter((entry) => entry.score >= cutoff).map((entry) => entry.id);
}

/** Resume phrases that state the level the candidate is actually looking for. */
const TARGET_PATTERNS = [
  [LEVELS.intern, /\bseeking\b[^.]{0,40}\b(intern|internship)\b/i],
  [LEVELS.entry, /\bseeking\b[^.]{0,40}\b(entry[\s-]?level|new\s?grad|graduate|junior|fresher)\b/i],
  [LEVELS.senior, /\bseeking\b[^.]{0,40}\b(senior|lead|staff)\b/i],
];

/**
 * Total professional experience claimed by a resume, in years.
 *
 * Both "10+ months" and "3 years" are recognised, and the largest figure wins -
 * a resume that says "3 years" somewhere is not an entry-level resume just
 * because a single internship lasted four months.
 *
 * @param {string} text
 * @returns {number|null}
 */
function detectYearsOfExperience(text) {
  const source = String(text || '');
  let best = null;

  for (const match of source.matchAll(/(\d{1,2})\s*\+?\s*years?\b[^.]{0,30}?\b(experience|exp\b)/gi)) {
    const years = Number(match[1]);
    if (Number.isFinite(years) && years <= 40 && (best === null || years > best)) best = years;
  }

  if (best === null) {
    for (const match of source.matchAll(/(\d{1,2})\s*\+?\s*months?\b[^.]{0,30}?\b(experience|internship)/gi)) {
      const years = Number(match[1]) / 12;
      if (Number.isFinite(years) && (best === null || years > best)) best = years;
    }
  }

  return best;
}

/**
 * Where the candidate is, inferred from a phone country code or a city name.
 * Used as advisory context for the model, never as a gate - remote postings
 * make any hard location rule wrong more often than right.
 *
 * @param {string} text
 * @returns {string|null}
 */
function detectLocation(text) {
  const source = String(text || '');
  if (/\+91[\s-]?\d/.test(source) || /\b(india|bengaluru|bangalore|hyderabad|chennai|mumbai|pune|delhi|noida|gurgaon|kakinada|kolkata|ahmedabad)\b/i.test(source)) {
    return 'India';
  }
  if (/\+44[\s-]?\d/.test(source) || /\b(united kingdom|london|manchester|edinburgh)\b/i.test(source)) return 'United Kingdom';
  if (/\+1[\s-]?\d{3}/.test(source) || /\b(united states|san francisco|new york|seattle|austin|boston)\b/i.test(source)) {
    return 'United States';
  }
  return null;
}

/**
 * Builds the candidate profile the gates and the prompt both work from.
 *
 * Every resume is folded into one profile: the candidate is a single person, so
 * the *highest* seniority any resume supports is their real level, and the union
 * of the families is what they can credibly apply for.
 *
 * @param {Array<{filename?:string, content?:string}>} resumes
 * @returns {{level:number, levelLabel:string, years:number|null, families:Array<string>, skills:Array<string>, location:string|null, summary:string}}
 */
function buildCandidateProfile(resumes = []) {
  const text = resumes.map((resume) => String(resume.content || '')).join('\n').slice(0, 20000);

  const years = detectYearsOfExperience(text);
  let level = years === null ? LEVELS.entry : levelForYears(years);

  // An explicit "seeking ..." line is the candidate telling us directly, and
  // beats anything inferred from durations.
  for (const [target, pattern] of TARGET_PATTERNS) {
    if (pattern.test(text)) {
      level = target;
      break;
    }
  }

  const lower = text.toLowerCase();
  const skills = SKILL_VOCABULARY.filter((skill) => lower.includes(skill));

  // No default. An earlier version fell back to 'engineering' whenever nothing
  // matched, which meant every unrecognised resume - including a non-technical
  // one - was screened as a software engineer's. An empty list now means
  // "unknown", and `assessRelevance` responds by not gating on field at all,
  // which is the honest answer when the resume did not say.
  const families = detectCandidateFamilies(text);

  const levelLabel = LEVEL_LABELS[level];
  const location = detectLocation(text);

  const summary = [
    `Seniority: ${levelLabel}${years === null ? '' : ` (~${years < 1 ? `${Math.round(years * 12)} months` : `${years} years`} of experience)`}`,
    `Role families: ${families.length ? families.join(', ') : 'not stated on the resume'}`,
    location ? `Based in: ${location}` : '',
    skills.length ? `Core skills: ${skills.slice(0, 24).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { level, levelLabel, years, families, skills, location, summary };
}

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

/** Cities and spellings that mean "this role is in India". */
const INDIA_PATTERN =
  /\b(india|bharat|bengaluru|bangalore|hyderabad|chennai|mumbai|bombay|pune|delhi|new\s+delhi|ncr|noida|gurgaon|gurugram|kolkata|calcutta|ahmedabad|jaipur|kochi|cochin|coimbatore|indore|chandigarh|thiruvananthapuram|trivandrum|visakhapatnam|vizag|vijayawada|kakinada|nagpur|surat|lucknow|bhubaneswar|mysore|mysuru|mohali)\b/i;

/** Phrases that mean the office does not decide who can apply. */
const REMOTE_PATTERN = /\b(remote|work\s+from\s+home|wfh|anywhere|distributed|global(ly)?)\b/i;

/**
 * Whether one segment of a location is remote *without naming a place*.
 *
 * The distinction matters because "Remote" on its own is open to India, while
 * "New York, NY (HQ); Remote" and "Remote (Buenos Aires)" are not - they are US
 * and Argentine roles that happen to allow working from home. Testing the whole
 * string for the word "remote" treats all three the same, which is how a dozen
 * Ramp, OpenAI and Anthropic postings stayed on the board.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function isOpenRemote(segment) {
  if (!REMOTE_PATTERN.test(segment)) return false;

  // Strip the remote vocabulary and punctuation; a genuinely open "Remote" or
  // "Remote Globally" leaves nothing behind, a place name does not.
  const residue = segment
    .replace(/\b(remote|work\s+from\s+home|wfh|anywhere|distributed|global(ly)?|friendly|hybrid|onsite|in\s+office)\b/gi, '')
    .replace(/[^a-z]/gi, '');

  return residue.length === 0;
}

/** Splits a board's location field into the individual offices it names. */
const locationSegments = (text) =>
  String(text)
    .split(/[;•|/]|\bor\b/i)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * Whether a posting is somewhere the candidate can actually take the job.
 *
 * The rule is an allow-list, not a block-list. An earlier version rejected only
 * locations that positively named a foreign country, which meant the block-list
 * had to enumerate every city and state on earth - and it silently let through
 * "Pompano Beach, FL", "Basking Ridge, New Jersey" and "Istanbul" because none
 * of those happened to be in it. Requiring a positive India (or remote) signal
 * has no such hole.
 *
 * The one concession is that an *empty* location is kept: some boards omit the
 * field, and a posting is not disqualified by the scraper failing to read it.
 *
 * A posting naming several offices - "India; Ireland; United Kingdom" - is
 * eligible, because one of them is one the candidate can work from.
 *
 * @param {string} location location text scraped from the card
 * @param {string|null} candidateCountry from `buildCandidateProfile`
 * @returns {{eligible:boolean, label:string, note:string}}
 */
function assessLocation(location, candidateCountry) {
  const text = String(location || '').trim();

  // The gate only knows how to reason about India; for anyone else it stays out
  // of the way rather than guessing.
  if (candidateCountry !== 'India') {
    return { eligible: true, label: text || 'Not stated', note: '' };
  }

  if (!text) return { eligible: true, label: 'Not stated', note: 'Location not listed on the board.' };

  // Any office in India makes the posting reachable, whatever else it lists.
  if (INDIA_PATTERN.test(text)) return { eligible: true, label: text, note: 'Based in India.' };

  // Otherwise it is only open if *every* office it names is unrestricted remote.
  const segments = locationSegments(text);
  if (segments.length && segments.every(isOpenRemote)) {
    return { eligible: true, label: text, note: 'Fully remote - open to India.' };
  }

  return { eligible: false, label: text, note: `Based in ${text} - not India.` };
}

/* ------------------------------------------------------------------ */
/* The gate                                                            */
/* ------------------------------------------------------------------ */

/** How far above the candidate a posting may sit before it stops being worth applying to. */
const MAX_LEVEL_STRETCH = Number(process.env.RELEVANCE_MAX_LEVEL_STRETCH || 1);

/** Score ceilings applied when a posting fails a gate. */
const CAPS = { mismatch: 15, overreach: 25, stretch: 75 };

/**
 * Decides whether a posting is worth showing this candidate at all.
 *
 * `fit` is one of:
 *   `match`     - right country, family and level. Goes to the LLM for a real score.
 *   `stretch`   - one rung up, or an adjacent family. Still scored, capped at 75.
 *   `overreach` - two or more rungs above the candidate. Not scored, capped at 25.
 *   `mismatch`  - a different line of work entirely. Not scored, capped at 15.
 *   `elsewhere` - based in a country the candidate is not in. Not scored.
 *
 * Only `match` and `stretch` are shown on the board by default.
 *
 * @param {{title?:string, description?:string}} job
 * @param {ReturnType<typeof buildCandidateProfile>} profile
 * @returns {{fit:string, cap:number|null, family:string, familyLabel:string, level:number, levelLabel:string, requiredYears:number|null, levelGap:number, note:string, worthScoring:boolean}}
 */
function assessRelevance(job, profile) {
  const title = String(job.title || '');
  const description = String(job.description || '');

  const family = detectRoleFamily(title, description);
  const posting = detectPostingLevel(title, description);
  const levelGap = posting.level - profile.level;

  // The card's location field when the scraper captured one, otherwise the
  // blurb - on every supported ATS the blurb *is* the office line.
  const place = assessLocation(job.location || description.slice(0, 120), profile.location);

  const adjacent = profile.families.flatMap((id) => ADJACENT_FAMILIES[id] || []);

  // `other` is a rejection, not a benefit of the doubt. Reaching it means
  // neither the title nor the description contained a single signal from any
  // family, so it is not a role this candidate is a plausible applicant for.
  //
  // The exception is a resume whose own field could not be read: gating on a
  // field we do not know would hide everything, so the field check is skipped
  // and seniority and location carry the screening on their own.
  const familyUnknown = profile.families.length === 0;
  const familyFit = familyUnknown
    ? 'adjacent'
    : profile.families.includes(family.id)
      ? 'match'
      : adjacent.includes(family.id)
        ? 'adjacent'
        : 'mismatch';

  const base = {
    family: family.id,
    familyLabel: family.label,
    level: posting.level,
    levelLabel: posting.label,
    requiredYears: posting.requiredYears,
    levelGap,
    location: place.label,
    locationEligible: place.eligible,
  };

  // Checked before anything else: a role in another country is one the
  // candidate cannot take, however well it matches on skills and seniority.
  if (!place.eligible) {
    return {
      ...base,
      fit: 'elsewhere',
      cap: CAPS.mismatch,
      worthScoring: false,
      note: place.note,
    };
  }

  // A different line of work is a harder no than a seniority gap: no amount of
  // keyword overlap makes a backend engineer a candidate for a legal opening.
  if (familyFit === 'mismatch') {
    return {
      ...base,
      fit: 'mismatch',
      cap: CAPS.mismatch,
      worthScoring: false,
      note:
        family.id === 'other'
          ? 'Not your line of work - nothing in this posting matches your field.'
          : `Not your line of work - this is a ${family.label.toLowerCase()} role.`,
    };
  }

  if (levelGap > MAX_LEVEL_STRETCH) {
    const years = posting.requiredYears ? ` and asks for ${posting.requiredYears}+ years` : '';
    return {
      ...base,
      fit: 'overreach',
      cap: CAPS.overreach,
      worthScoring: false,
      note: `Too senior - a ${posting.label.toLowerCase()} opening${years}, and you are ${profile.levelLabel.toLowerCase()}.`,
    };
  }

  // An internship shown to someone who has moved past that stage is noise in the
  // other direction, but it is cheap to apply for and sometimes deliberate, so
  // it is only demoted once the candidate is two rungs clear of it.
  if (levelGap < -MAX_LEVEL_STRETCH - 1) {
    return {
      ...base,
      fit: 'stretch',
      cap: CAPS.stretch,
      worthScoring: true,
      note: `Below your level - a ${posting.label.toLowerCase()} opening.`,
    };
  }

  if (levelGap === MAX_LEVEL_STRETCH || familyFit === 'adjacent') {
    const why = familyUnknown
      ? `${family.label.toLowerCase()} - your resume did not state a field, so nothing is filtered on it`
      : familyFit === 'adjacent'
        ? `an adjacent field (${family.label.toLowerCase()})`
        : `one level up (${posting.label.toLowerCase()})`;
    return { ...base, fit: 'stretch', cap: CAPS.stretch, worthScoring: true, note: `A stretch - ${why}.` };
  }

  return {
    ...base,
    fit: 'match',
    cap: null,
    worthScoring: true,
    note: `${posting.label} ${family.label.toLowerCase()} - matches your profile.`,
  };
}

module.exports = {
  LEVELS,
  LEVEL_LABELS,
  ROLE_FAMILIES,
  CAPS,
  buildCandidateProfile,
  assessRelevance,
  assessLocation,
  detectPostingLevel,
  detectRoleFamily,
  detectYearsOfExperience,
  detectLocation,
  levelForYears,
  smallestYearsRequirement,
  INTERNSHIP_PATTERN,
};
