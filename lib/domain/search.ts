import { ARTICLES, type Article } from './kb';

// BM25 keyword retrieval over the guides. Small corpus, so an in-memory index is enough.

const STOP_WORDS = new Set(
  'a an and are as at be by can cannot do does for from get getting got how i if in is it its my me not of on or should that the this to we what when will with won you need really keeps am isn aren don doesn didn wasn t s think just please super very so too set up says about'.split(' '),
);

const SYNONYMS: Record<string, string[]> = {
  internet: ['wifi'],
  mail: ['outlook'],
  email: ['outlook'],
  locked: ['lockout'],
  phone: ['mfa'],
  mic: ['microphone'],
  storage: ['disk'],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/wi-fi/g, 'wifi')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP_WORDS.has(t));
}

function stem(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      let base = token.slice(0, -suffix.length);
      if (suffix !== 's' && /([^aeiouls])\1$/.test(base)) base = base.slice(0, -1);
      return base;
    }
  }
  return token;
}

interface Doc {
  article: Article;
  terms: string[];
}

// Title and keywords are strong signals, so they count twice.
const DOCS: Doc[] = ARTICLES.map((article) => {
  const strong = tokenize(`${article.title} ${article.keywords}`);
  const body = tokenize(article.steps.map((s) => s.text).join(' '));
  return { article, terms: [...strong, ...strong, ...body].map(stem) };
});

const AVG_LEN = DOCS.reduce((n, d) => n + d.terms.length, 0) / DOCS.length;
const DOC_FREQ = new Map<string, number>();
for (const d of DOCS) for (const t of new Set(d.terms)) DOC_FREQ.set(t, (DOC_FREQ.get(t) ?? 0) + 1);

const idf = (term: string) => {
  const df = DOC_FREQ.get(term) ?? 0;
  return Math.log(1 + (DOCS.length - df + 0.5) / (df + 0.5));
};

function bm25(terms: string[], doc: Doc, k1 = 1.2, b = 0.75): number {
  let score = 0;
  for (const term of new Set(terms)) {
    const tf = doc.terms.filter((t) => t === term).length;
    if (!tf) continue;
    score += idf(term) * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.terms.length) / AVG_LEN)));
  }
  return score;
}

// Share of the query's weight a guide explains, 0 to 1. Words no guide knows weigh the most.
function coverage(base: string[], doc: Doc): number {
  const words = [...new Set(base)];
  const weight = (w: string) => idf(stem(w));
  const hit = (w: string) => [w, ...(SYNONYMS[w] ?? [])].some((t) => doc.terms.includes(stem(t)));
  return words.filter(hit).reduce((n, w) => n + weight(w), 0) / words.reduce((n, w) => n + weight(w), 0);
}

interface Hit {
  article: Article;
  coverage: number;
}

// Below this share of the query a guide is only a guess, so ServiceNow articles are offered too.
const CONFIDENT_COVERAGE = 0.6;
// Alternatives scoring under this share of the best one are noise.
const ALTERNATIVE_SHARE = 0.5;

export const confident = (hit: Hit | undefined) => (hit?.coverage ?? 0) >= CONFIDENT_COVERAGE;

export function rankKnowledge(query: string, limit = 3): Hit[] {
  const base = tokenize(query);
  if (!base.length) return [];
  const terms = [...base, ...base.flatMap((t) => SYNONYMS[t] ?? [])].map(stem);
  const ranked = DOCS.map((d) => ({ d, score: bm25(terms, d) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = ranked[0]?.score ?? 0;
  return ranked
    .filter((x) => x.score >= best * ALTERNATIVE_SHARE)
    .slice(0, limit)
    .map(({ d }) => ({ article: d.article, coverage: coverage(base, d) }));
}

export const searchKnowledge = (query: string, limit = 3): Article[] => rankKnowledge(query, limit).map((h) => h.article);
