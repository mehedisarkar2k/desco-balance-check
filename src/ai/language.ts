/**
 * Which language to reply in, decided in code for every message.
 *
 * Left to the model, the reply followed the conversation rather than the
 * message: after a few Bangla exchanges, "so, what about the 23?" was answered
 * in Bangla. Deciding it here and stating it in the instructions for that turn
 * makes the rule hold.
 */
export type ReplyLanguage = "bn" | "en";

/**
 * Common Bangla words as typed in Latin letters. Words that are also ordinary
 * English ("to", "age", "rat", "den", "bill") are left out on purpose, since
 * they would tip plain English messages into Bangla.
 */
const BANGLISH = new Set([
    // questions
    "ki", "keno", "kobe", "kober", "kothay", "kivabe", "kibhabe", "koto", "kotodin", "kototaka", "kon", "kono", "ke",
    // pronouns and pointers
    "ami", "amar", "amake", "amra", "amader", "tumi", "tomar", "tomake", "apni", "apnar", "apnake",
    "eita", "oita", "eta", "ota", "ei", "oi", "egulo", "ogulo", "eigulo", "oigulo", "sheta",
    // verbs
    "ache", "achhe", "nai", "nei", "hobe", "hoy", "hoye", "hoyeche", "hocche", "hochhe", "holo", "hoilo",
    "korbo", "korbe", "koro", "korun", "kore", "korei", "korle", "korte", "kora", "koreche", "korechi", "korchi", "korche",
    "dao", "daw", "dibo", "dibe", "dite", "dilam", "dicche", "dichhe", "diye",
    "pathaw", "pathao", "pathan", "pathabo", "pathiye", "pathale",
    "dekho", "dekhao", "dekhan", "dekhi", "dekhte", "bolo", "bolen", "bolte",
    "jabe", "jabo", "jai", "jay", "jete", "jacchi", "cholbe", "chole", "lagbe", "lage", "lagche",
    "pari", "paro", "pare", "parbo", "parchi", "chai", "chaile", "janaw", "janao", "jani",
    "thakbe", "thake", "thakle", "keteche", "kete", "katche", "rakho", "rakhbo", "nibo", "nao", "nite", "pabo", "pai",
    // particles and connectives
    "na", "ta", "ti", "gulo", "guli", "er", "je", "jodi", "tahole", "tobe", "kintu", "ar", "abar",
    "shudhu", "sudhu", "arekta", "ekta", "kichu", "onek", "beshi", "bhalo", "valo", "thik", "shob",
    // time
    "aj", "ajke", "ajker", "kal", "kalke", "gotokal", "gotokaler", "porshu", "mase", "maser", "masher",
    "din", "diner", "dine", "ekhon", "ekhn", "akhon", "porjonto", "theke", "tarikh", "tarikhe",
    // money and electricity
    "taka", "takar", "kharoch", "khoroch", "biddut", "bidyut",
    // other
    "akare", "hisebe", "hishabe", "jonno", "sathe", "moddhe",
]);

/**
 * Words that appear the same in either language: month abbreviations and
 * units. "11 sept?" asked in the middle of a Bangla conversation is not an
 * English message, so a message made only of these keeps the language in use.
 */
const NEUTRAL = new Set([
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "kwh", "bdt", "tk", "unit", "units", "am", "pm",
]);

/**
 * "bn" for Bangla script or Banglish, "en" for English, or null when the
 * message carries no signal either way (a bare number or an emoji), so the
 * caller can keep the language already in use.
 */
export function detectReplyLanguage(message: string): ReplyLanguage | null {
    if (/[ঀ-৿]/.test(message)) return "bn";

    const words = (message.toLowerCase().match(/[a-z]+/g) ?? []).filter((word) => !NEUTRAL.has(word));
    if (words.length === 0) return null;

    const hits = words.filter((word) => BANGLISH.has(word)).length;

    // One borrowed word inside an English sentence ("why is gotokal 22?") is
    // still English. Two, or a large share of a short message ("tariff koto?",
    // "jul mase uses history?"), is Banglish.
    return hits >= 2 || hits / words.length >= 0.25 ? "bn" : "en";
}

/**
 * Whether a reply is in the expected language, judged by the share of Bangla
 * letters among all letters. Bangla replies still carry "kWh" and "BDT", and
 * English ones may quote a Bangla word, so the test is a share, not presence.
 * Display tokens such as [[BLOCK_2]] are ignored.
 */
export function isInLanguage(text: string, language: ReplyLanguage): boolean {
    const letters = text.replace(/\[\[[A-Z]+_\d+\]\]/g, "").match(/[\u0980-\u09FF]|[A-Za-z]/g) ?? [];
    if (letters.length === 0) return true;

    const bangla = letters.filter((ch) => /[\u0980-\u09FF]/.test(ch)).length / letters.length;
    return language === "bn" ? bangla >= 0.3 : bangla <= 0.3;
}
