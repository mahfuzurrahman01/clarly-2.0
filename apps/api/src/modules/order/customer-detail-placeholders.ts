// Deterministic guard for "wrong orders" (bar: zero). The model sometimes
// fills `create_order`'s required contact fields with filler ("Customer",
// "Not provided yet") instead of asking. A schema `minLength` cannot tell
// filler from a real value, so this module does, on WHOLE-VALUE matches only:
// "Customer Care Street" or "Unknown Street 5" are real addresses and pass.
//
// Cycle 3 added three more shapes the model produced instead of asking:
//  - an INSTRUCTION to the customer pasted into the field ("Please provide
//    your delivery address"), which is neither filler nor an address;
//  - a bare COUNTRY as the delivery address ("المملكة العربية السعودية");
//  - a FABRICATED phone with enough digits to pass the length check
//    ("0500000000").
// A bare CITY is deliberately NOT rejected: Gulf customers do give "بريدة" or
// "Riyadh Al Yasmin" as their whole address and the commerce-journey corpus
// expects those orders to be written.

export type CustomerDetailField =
  'customerName' | 'customerPhone' | 'shippingAddress';

const MIN_PHONE_DIGITS = 7;

const PLACEHOLDER_PHRASES: readonly string[] = [
  // English
  'customer',
  'client',
  'user',
  'name',
  'address',
  'phone',
  'test',
  'n/a',
  'na',
  'nil',
  'null',
  'none',
  'unknown',
  'undefined',
  'anonymous',
  'not provided',
  'not provided yet',
  'not given',
  'not given yet',
  'not available',
  'not known',
  'not specified',
  'not specified yet',
  'not applicable',
  'not sure',
  'no name',
  'no address',
  'no phone',
  'delivery address',
  'shipping address',
  'customer address',
  'customer name',
  'customer phone',
  'full name',
  'phone number',
  'mobile number',
  'contact number',
  'to be confirmed',
  'to be provided',
  'to be determined',
  'to be decided',
  'to be advised',
  'tbc',
  'tbd',
  'pending',
  'same',
  'same as above',
  'same address',
  'same as before',
  'will provide later',
  'later',
  // Arabic
  'غير معروف',
  'غير معروفه',
  'غير متوفر',
  'غير متوفره',
  'غير محدد',
  'غير مذكور',
  'غير موجود',
  'لا يوجد',
  'لا شيء',
  'لا اعرف',
  'لا اعلم',
  'سيتم التحديد',
  'سيتم التحديد لاحقا',
  'سيتم التاكيد',
  'سيتم التاكيد لاحقا',
  'سيتم الارسال لاحقا',
  'لم يحدد',
  'لم يتم التحديد',
  'مجهول',
  'بدون',
  'العميل',
  'عميل',
  'زبون',
  'الزبون',
  'نفس العنوان',
  'نفسه',
  'نفس',
  'لاحقا',
  'قيد الانتظار',
  'معلق',
  'العنوان',
  'عنوان التوصيل',
  'الاسم',
  'الاسم الكامل',
  'رقم الجوال',
  'رقم الهاتف',
  'رقم الموبايل',
  'الجوال',
  'الهاتف',
  // Arabizi
  'ghair maroof',
  'ghayr maroof',
  'ghair maaroof',
  'ghayr maaruf',
  'mish maaroof',
  'mesh maaroof',
  'mish maroof',
  'mesh maroof',
  'mo maroof',
  'mu maroof',
  'mafi',
  'ma fi',
  'mafeesh',
  'la yujad',
  'la yoojad',
  'la yojad',
  'lissa',
  'lesa',
  'baadain',
  'baadeen',
  'baden',
  'zaboon',
  'zabon',
  'ameel',
  '3ameel',
  'nafs el 3enwan',
  'nafs al 3enwan',
];

/** Lowercase, drop Arabic diacritics/tatweel, unify alef/ya/ta-marbuta forms, strip edge punctuation. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\p{P}\p{S}\s]+/gu, (run) => (run.includes('/') ? '/' : ' '))
    .replace(/\bn\s*\/?\s*a\b/g, 'n/a')
    .trim();
}

const PLACEHOLDER_SET: ReadonlySet<string> = new Set(
  PLACEHOLDER_PHRASES.map((phrase) => normalise(phrase)),
);

// Instruction phrases: the model wrote a request TO the customer into the
// field. Matched on the normalised text (lowercase, Arabic folded, punctuation
// gone), anchored on the verb or the second-person possessive so a street that
// merely contains "Provide" or "Your" ("Near Your Home Furniture") is kept.
const ENGLISH_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /^(please|kindly|pls|plz)\b/,
  /\b(provide|share|send|enter|give|tell|type|confirm|specify)\b.{0,25}\byour\b/,
  /^(what|where|which)\b.{0,20}\byour\b/,
  /\byour (full |delivery |shipping |home |contact |mobile |phone )?(name|address|phone|number|location)\b/,
];
const ARABIC_INSTRUCTION_LEADS: readonly string[] = [
  'يرجي',
  'رجاء',
  'الرجاء',
  'ارجو',
  'لطفا',
  'تفضل',
  'ارسل',
  'زودنا',
  'اكتب',
  'ادخل',
  'اعطني',
  'اعطنا',
  'شاركنا',
  'من فضلك',
  // Arabizi
  'ersel',
  'arsel',
  'ktb',
  '3tini',
  'a3tini',
];
const ARABIC_SECOND_PERSON_TOKENS: ReadonlySet<string> = new Set([
  'عنوانك',
  'عنوانكم',
  'جوالك',
  'جوالكم',
  'رقمك',
  'رقمكم',
  'اسمك',
  'اسمكم',
  'موقعك',
  'هاتفك',
  // Arabizi
  '3enwanak',
  '3unwanak',
  'esmak',
  'jawwalak',
  'raqmak',
]);

function isInstructionPhrase(normalised: string): boolean {
  if (ENGLISH_INSTRUCTION_PATTERNS.some((re) => re.test(normalised))) {
    return true;
  }
  const tokens = normalised.split(' ');
  if (tokens.some((token) => ARABIC_SECOND_PERSON_TOKENS.has(token))) {
    return true;
  }
  return ARABIC_INSTRUCTION_LEADS.some(
    (lead) => normalised === lead || normalised.startsWith(`${lead} `),
  );
}

/** True when the whole value is filler, or an instruction to the customer, rather than something the customer said. */
export function isPlaceholderValue(value: string): boolean {
  const normalised = normalise(value);
  // Nothing left but punctuation/symbols ("-", "?", "..."), or empty.
  if (!/[\p{L}\p{N}]/u.test(normalised)) return true;
  return PLACEHOLDER_SET.has(normalised) || isInstructionPhrase(normalised);
}

const COUNTRY_NAMES: readonly string[] = [
  // English
  'saudi arabia',
  'kingdom of saudi arabia',
  'ksa',
  'saudi',
  'uae',
  'united arab emirates',
  'emirates',
  'kuwait',
  'qatar',
  'bahrain',
  'oman',
  'sultanate of oman',
  'egypt',
  'jordan',
  'iraq',
  'lebanon',
  // Arabic
  'المملكة العربية السعودية',
  'المملكه العربيه السعوديه',
  'السعودية',
  'الامارات',
  'الامارات العربية المتحدة',
  'الكويت',
  'قطر',
  'البحرين',
  'عمان',
  'سلطنة عمان',
  'مصر',
  'الاردن',
  'العراق',
  'لبنان',
];

const COUNTRY_SET: ReadonlySet<string> = new Set(
  COUNTRY_NAMES.map((name) => normalise(name)),
);

/**
 * True when the whole address is just a country. A country locates no door:
 * the model wrote one after the customer gave nothing more specific, and the
 * order was then written with a fabricated street. A bare CITY is not caught
 * here on purpose (see the header).
 */
export function isBareCountry(value: string): boolean {
  return COUNTRY_SET.has(normalise(value));
}

/** Only the digits of `phone`, with Arabic-Indic and Persian digits folded to ASCII. */
function asciiDigits(phone: string): string {
  return phone
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\D/g, '');
}

function digitCount(phone: string): number {
  return asciiDigits(phone).length;
}

// Thresholds are set so the numbers the eval and demo customers really use
// (+966500000001: seven zeros then a 1; +966501234567; 05012345679) stay
// valid while the observed filler ("0500000000": eight zeros) does not.
const MAX_REPEATED_DIGIT_RUN = 7;
const MAX_SEQUENTIAL_DIGIT_RUN = 8;

function longestRun(digits: string, step: 0 | 1 | -1): number {
  let longest = digits.length > 0 ? 1 : 0;
  let current = 1;
  for (let i = 1; i < digits.length; i += 1) {
    current =
      Number(digits[i]) - Number(digits[i - 1]) === step ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

/**
 * True when the digits are a pattern rather than a number: a long run of one
 * digit ("0500000000") or of consecutive digits ("123456789"). Real numbers
 * with a few repeated digits pass.
 */
export function isFabricatedPhone(phone: string): boolean {
  const digits = asciiDigits(phone);
  return (
    longestRun(digits, 0) > MAX_REPEATED_DIGIT_RUN ||
    longestRun(digits, 1) > MAX_SEQUENTIAL_DIGIT_RUN ||
    longestRun(digits, -1) > MAX_SEQUENTIAL_DIGIT_RUN
  );
}

/** Fields whose value is missing or placeholder, in a stable order. */
export function findMissingCustomerDetails(input: {
  customerName: string;
  customerPhone: string;
  shippingAddress: string;
}): CustomerDetailField[] {
  const missing: CustomerDetailField[] = [];
  if (isPlaceholderValue(input.customerName)) missing.push('customerName');
  if (
    isPlaceholderValue(input.customerPhone) ||
    digitCount(input.customerPhone) < MIN_PHONE_DIGITS ||
    isFabricatedPhone(input.customerPhone)
  ) {
    missing.push('customerPhone');
  }
  if (
    isPlaceholderValue(input.shippingAddress) ||
    isBareCountry(input.shippingAddress)
  ) {
    missing.push('shippingAddress');
  }
  return missing;
}

const MIN_ADDRESS_GROUNDED_RATIO = 0.5;

function addressTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((token) => (token.length > 3 ? token.replace(/^ال/, '') : token))
    .filter((token) => token.length > 1 && token !== 'al' && token !== 'ال');
}

/**
 * Provenance guard: a delivery address must come from the customer's own
 * words, not from the model. A bare city passes the placeholder checks on
 * purpose, so a model that fills `shippingAddress` with "الرياض" before the
 * customer gave any address would otherwise write a wrong order. At least half
 * of the address's words must appear in what the customer said; a few filler
 * words the model adds ("Saudi Arabia") are tolerated.
 */
export function isAddressGroundedIn(
  address: string,
  customerText: string,
): boolean {
  const wanted = addressTokens(address);
  if (wanted.length === 0) return false;
  const said = new Set(addressTokens(customerText));
  const grounded = wanted.filter((token) => said.has(token)).length;
  return grounded > 0 && grounded / wanted.length >= MIN_ADDRESS_GROUNDED_RATIO;
}
