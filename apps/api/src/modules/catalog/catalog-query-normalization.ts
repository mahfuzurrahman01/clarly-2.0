// Feature 20 (Product Catalog & Stock): query-side normalisation for Arabic and
// Arabizi lookups.
//
// Why query-side only: the GIN indexes are built on the raw document (see
// catalog-search.ts) and Postgres will not use an expression index whose text
// drifted, so the stored text cannot be normalised. Instead each customer token
// is expanded into the spellings a merchant could plausibly have stored, and
// the expansions are OR-ed into the tolerant query. The raw token is always
// kept, so a brand such as "باريق" (whose first letter looks like the prefix
// ب) still matches itself.
//
// Cycle-3 evidence this exists for: `lookup_product('القلاية الهوائية')` and
// `('أدوات المطبخ')` returned nothing because the stored text is "قلاية هوائية"
// and the category is the English word "kitchen".

/** Harakat, superscript alef and tatweel: typed by customers, never stored by merchants. */
const ARABIC_MARKS = /[ً-ٰٟـ]/g;
const HAS_ARABIC = /[\u0621-\u064A]/;
const ARABIC_LETTERS = /^[ء-ي]+$/;

/** Definite article, with the conjunction/preposition clitics that glue onto it (وال، فال، بال، كال، لل، ال). */
const ARTICLE_PREFIX = /^(?:[وفبك]?ال|لل)(.+)$/;
/** A bare one-letter clitic (و، ف، ب، ل، ك) — only trusted when a real stem remains. */
const CLITIC_PREFIX = /^[وفبلك](.+)$/;
/** Arabizi article: `al-mawad`, `el-matbakh`. Hyphen/apostrophe required so `alpha` and `elite` survive. */
const ARABIZI_ARTICLE = /^(?:al|el)[-'’](.+)$/;

const MIN_STEM_AFTER_ARTICLE = 2;
const MIN_STEM_AFTER_CLITIC = 3;
const MAX_VARIANTS_PER_TOKEN = 8;

const ALEF_FORMS = ['ا', 'أ', 'إ', 'آ'] as const;

export function stripArabicMarks(value: string): string {
  return value.replace(ARABIC_MARKS, '');
}

/** Alef-hamza and ta-marbuta spellings of a stem: Khaleeji/Egyptian typing drops or swaps them freely. */
function spellingVariants(stem: string): string[] {
  const out = [stem];
  const first = stem[0];
  if ((ALEF_FORMS as readonly string[]).includes(first)) {
    for (const form of ALEF_FORMS) {
      if (form !== first) out.push(form + stem.slice(1));
    }
  }
  if (stem.length >= 4) {
    if (stem.endsWith('ة')) out.push(`${stem.slice(0, -1)}ه`);
    else if (stem.endsWith('ه')) out.push(`${stem.slice(0, -1)}ة`);
  }
  return out;
}

/** Article/clitic-stripped stems of one token (never includes the token itself). */
function strippedStems(token: string): string[] {
  const stems: string[] = [];
  const arabizi = ARABIZI_ARTICLE.exec(token);
  if (arabizi && arabizi[1].length >= MIN_STEM_AFTER_ARTICLE) {
    stems.push(arabizi[1]);
  }
  if (!ARABIC_LETTERS.test(token)) return stems;

  const article = ARTICLE_PREFIX.exec(token);
  if (article && article[1].length >= MIN_STEM_AFTER_ARTICLE) {
    stems.push(article[1]);
  }
  const clitic = CLITIC_PREFIX.exec(token);
  if (clitic && clitic[1].length >= MIN_STEM_AFTER_CLITIC) {
    stems.push(clitic[1]);
    // "ولل…"/"بال…" shapes are caught above; this handles "و" + "ال" typed apart.
    const inner = ARTICLE_PREFIX.exec(clitic[1]);
    if (inner && inner[1].length >= MIN_STEM_AFTER_ARTICLE) {
      stems.push(inner[1]);
    }
  }
  return stems;
}

/**
 * The spellings to search for one lower-cased token: the token itself first,
 * then article/clitic-stripped stems and their hamza/ta-marbuta variants.
 * Tokens with no Arabic/Arabizi article come back as `[token]`.
 */
export function normalizedTokenVariants(token: string): string[] {
  const cleaned = stripArabicMarks(token).replace(/[^\p{L}\p{N}\-'’]/gu, '');
  // English words, SKUs and injection-shaped input pass through verbatim.
  if (!HAS_ARABIC.test(cleaned) && !ARABIZI_ARTICLE.test(cleaned)) {
    return [token];
  }
  const variants = new Set<string>([token]);
  const bases = [cleaned, ...strippedStems(cleaned)];
  for (const base of bases) {
    if (!base) continue;
    for (const spelling of spellingVariants(base)) variants.add(spelling);
  }
  return [...variants].slice(0, MAX_VARIANTS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Category words
// ---------------------------------------------------------------------------

interface CategoryGroup {
  /** The catalog category slug this group means (matches the seeded/imported categories). */
  canonical: string;
  /** Other English words a tenant may have used for the same category. */
  english: readonly string[];
  /** Arabic and Arabizi words for it, article-less and lower-cased. */
  local: readonly string[];
}

const CATEGORY_GROUPS: readonly CategoryGroup[] = [
  {
    canonical: 'kitchen',
    english: ['kitchenware', 'cookware'],
    local: ['مطبخ', 'مطابخ', 'matbakh', 'mtbkh', 'matbah', 'matbach'],
  },
  {
    canonical: 'home-appliances',
    english: ['appliances'],
    local: ['اجهزة', 'أجهزة', 'ajhiza', 'ajhizah', 'ajhizat'],
  },
  {
    canonical: 'home',
    english: ['household'],
    local: ['منزل', 'منزلي', 'منزلية', 'بيت', 'بيتي', 'manzil', 'bayt', 'beit'],
  },
  {
    canonical: 'electronics',
    english: ['electronic'],
    local: [
      'الكترونيات',
      'إلكترونيات',
      'الكترونية',
      'إلكترونية',
      'electroniyat',
      'electronyat',
      'electroniat',
    ],
  },
  {
    canonical: 'grocery',
    english: ['groceries', 'food'],
    local: ['بقالة', 'بقاله', 'مواد غذائية', 'baqala', 'bqala', 'baqalah'],
  },
  {
    canonical: 'footwear',
    english: ['shoes'],
    local: ['احذية', 'أحذية', 'حذاء', 'جزمة', 'ahdhiya', 'ahdhia', 'jazma'],
  },
  {
    canonical: 'fragrance',
    english: ['perfume'],
    local: ['عطور', 'عطر', 'perfum', 'a3tour', 'otoor', 'oitor'],
  },
  {
    canonical: 'outdoor',
    english: ['camping'],
    local: ['خارجية', 'تخييم', 'رحلات', 'kharijiya', 'takhyeem'],
  },
];

/** Modifiers that name a kind of item, not a category: "أدوات المطبخ" is just "kitchen". */
const GENERIC_CATEGORY_MODIFIERS: ReadonlySet<string> = new Set([
  'ادوات',
  'مستلزمات',
  'منتجات',
  'adawat',
  'adwat',
  'tools',
  'products',
  'items',
]);

/** Lower-cased, mark-free, alef-folded form of a word. */
function foldWord(word: string): string {
  return stripArabicMarks(word).trim().toLowerCase().replace(/[أإآ]/g, 'ا');
}

/** The article-less form of an already-folded word (Arabic `ال…` or Arabizi `al-…`). */
function withoutArticle(folded: string): string {
  const arabizi = ARABIZI_ARTICLE.exec(folded)?.[1];
  if (arabizi) return arabizi;
  const article = ARTICLE_PREFIX.exec(folded);
  return article && ARABIC_LETTERS.test(folded) ? article[1] : folded;
}

/** Lookup keys for a word, most specific first: some roots (الكترونيات) start with the letters of the article. */
function categoryKeys(word: string): string[] {
  const folded = foldWord(word);
  return [folded, withoutArticle(folded)];
}

const GROUP_BY_LOCAL_WORD: ReadonlyMap<string, CategoryGroup> = new Map(
  CATEGORY_GROUPS.flatMap((group) =>
    group.local.flatMap((word) =>
      categoryKeys(word).map((key): [string, CategoryGroup] => [key, group]),
    ),
  ),
);

const GROUP_BY_ENGLISH_WORD: ReadonlyMap<string, CategoryGroup> = new Map(
  CATEGORY_GROUPS.flatMap((group) =>
    [group.canonical, ...group.english].map((word): [string, CategoryGroup] => [
      word,
      group,
    ]),
  ),
);

function localGroup(word: string): CategoryGroup | undefined {
  for (const key of categoryKeys(word)) {
    const group = GROUP_BY_LOCAL_WORD.get(key);
    if (group) return group;
  }
  return undefined;
}

function groupForPhrase(phrase: string): CategoryGroup | undefined {
  const direct = localGroup(phrase);
  if (direct) return direct;
  const meaningful = phrase
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !GENERIC_CATEGORY_MODIFIERS.has(foldWord(word)));
  return meaningful.length === 1 ? localGroup(meaningful[0]) : undefined;
}

/**
 * Maps an Arabic/Arabizi category word or phrase ("أدوات المطبخ", "matbakh") to
 * the catalog's category slug ("kitchen"). Anything unrecognised — including
 * an already-English category — comes back unchanged, so a tenant's own
 * category name is never rewritten.
 */
export function canonicalCategory(category: string): string {
  return groupForPhrase(category)?.canonical ?? category;
}

/**
 * Every lower-cased value a tenant may have stored for the category the
 * argument names, or `null` when the argument is not a known category (the
 * caller then keeps its exact-match behaviour).
 */
export function categoryMatchValues(category: string): string[] | null {
  const trimmed = category.trim().toLowerCase();
  const group = groupForPhrase(trimmed) ?? GROUP_BY_ENGLISH_WORD.get(trimmed);
  if (!group) return null;
  return [
    group.canonical,
    ...group.english,
    ...group.local.map((word) => word.toLowerCase()),
  ];
}

/**
 * English category terms to search alongside a query token: the product
 * document contains the (English) category column, so "مطبخ" has to also
 * look for "kitchen".
 */
export function categoryTermsForToken(token: string): string[] {
  const group = localGroup(token);
  return group ? [group.canonical, ...group.english] : [];
}
