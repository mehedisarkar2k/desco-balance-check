/** Bangla numerals to ASCII, so "০৯:০০" validates the same as "09:00". */
export function asciiDigits(text: string): string {
    return text.replace(/[০-৯]/g, (digit) => String("০১২৩৪৫৬৭৮৯".indexOf(digit)));
}

/**
 * Valid, de-duplicated, sorted 24-hour HH:MM times, or null if any entry is
 * malformed.
 *
 * Every path that stores reminder times goes through this. A plain
 * \d{2}:\d{2} check accepts "08:60" and "24:00"; node-cron throws on the first
 * when scheduling it, which rejected scheduler start-up for every user and
 * turned each restart into a crash, and never matches the second.
 */
export function parseTimes(input: unknown): string[] | null {
    if (!Array.isArray(input) || input.length === 0 || input.length > 6) return null;

    const times = new Set<string>();
    for (const raw of input) {
        const match = /^(\d{1,2}):(\d{2})$/.exec(asciiDigits(String(raw)).trim());
        if (!match) return null;

        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour > 23 || minute > 59) return null;

        times.add(`${String(hour).padStart(2, "0")}:${match[2]}`);
    }
    return [...times].sort();
}

/** The current hour in the billing timezone, 0-23. */
export function hourInBillingZone(date: Date = new Date()): number {
    return Number(new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hourCycle: "h23",
        timeZone: process.env.TZ || "Asia/Dhaka",
    }).format(date));
}
