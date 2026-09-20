/**
 * Makes model output safe for Telegram's HTML parse mode.
 *
 * Telegram accepts only a short list of inline tags and rejects the whole
 * message with a 400 if it sees anything else, so a single <ul> loses the
 * entire reply. A language model will reach for list and paragraph markup
 * however firmly the prompt asks it not to, so its output is repaired here
 * rather than trusted.
 *
 * Unbalanced tags are rejected by Telegram too, so tags are tracked on a
 * stack: a closer with no opener is dropped, and anything still open at the
 * end is closed.
 */

const ALLOWED_TAGS = new Set([
    "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
    "a", "code", "pre", "blockquote", "tg-spoiler", "span",
]);

/** Tags carrying no meaning in Telegram that should become line breaks. */
const BREAK_TAGS = /<\s*\/?\s*(br|p|div|h[1-6]|tr)\s*\/?\s*>/gi;

const ENTITY = /&(?:amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/y;

function escapeText(text: string): string {
    let out = "";

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (char === "&") {
            // Keep entities the model already wrote; escape a bare ampersand.
            ENTITY.lastIndex = i;
            if (ENTITY.test(text)) {
                out += text.slice(i, ENTITY.lastIndex);
                i = ENTITY.lastIndex - 1;
                continue;
            }
            out += "&amp;";
        } else if (char === "<") {
            out += "&lt;";
        } else if (char === ">") {
            out += "&gt;";
        } else {
            out += char;
        }
    }

    return out;
}

/** Only the attributes Telegram recognises survive. */
function attributesFor(tag: string, raw: string): string {
    if (tag === "a") {
        const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(raw);
        const url = href?.[1] ?? href?.[2];
        // Only http(s) and tg: links; a javascript: URL must never survive.
        if (url && /^(https?:\/\/|tg:\/\/)/i.test(url)) {
            return ` href="${escapeText(url)}"`;
        }
        return "";
    }

    if (tag === "code") {
        const lang = /class\s*=\s*"(language-[\w+-]+)"/i.exec(raw);
        return lang ? ` class="${lang[1]}"` : "";
    }

    if (tag === "span") {
        // Telegram only allows span for spoilers.
        return /tg-spoiler/i.test(raw) ? ` class="tg-spoiler"` : "";
    }

    if (tag === "blockquote") {
        return /expandable/i.test(raw) ? " expandable" : "";
    }

    return "";
}

export function sanitizeTelegramHtml(input: string): string {
    // List markup has no Telegram equivalent, so turn it into bullet text
    // before tag filtering would otherwise discard the structure entirely.
    const withBullets = input
        .replace(BREAK_TAGS, "\n")
        .replace(/<\s*li\s*[^>]*>/gi, "\n• ")
        .replace(/<\s*\/\s*li\s*>/gi, "")
        .replace(/<\s*\/?\s*(ul|ol)\s*[^>]*>/gi, "\n");

    const tagPattern = /<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

    const open: string[] = [];
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = tagPattern.exec(withBullets)) !== null) {
        out += escapeText(withBullets.slice(cursor, match.index));
        cursor = tagPattern.lastIndex;

        const closing = Boolean(match[1]);
        const tag = match[2].toLowerCase();

        // An unknown tag is dropped, but whatever it wrapped is kept.
        if (!ALLOWED_TAGS.has(tag)) continue;

        if (closing) {
            const at = open.lastIndexOf(tag);
            if (at === -1) continue; // Closer with no opener.

            // Close anything opened inside it, so nesting stays valid.
            for (let i = open.length - 1; i >= at; i--) {
                out += `</${open[i]}>`;
            }
            open.splice(at);
            continue;
        }

        const attrs = attributesFor(tag, match[3] ?? "");
        // A link Telegram would reject is better as plain text than a 400.
        if (tag === "a" && attrs === "") continue;

        out += `<${tag}${attrs}>`;
        open.push(tag);
    }

    out += escapeText(withBullets.slice(cursor));

    // Close whatever the model left open.
    for (let i = open.length - 1; i >= 0; i--) {
        out += `</${open[i]}>`;
    }

    return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** The same text with every tag removed, for a plain-text retry. */
export function stripTelegramHtml(input: string): string {
    return input
        .replace(BREAK_TAGS, "\n")
        .replace(/<\s*li\s*[^>]*>/gi, "\n• ")
        .replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
