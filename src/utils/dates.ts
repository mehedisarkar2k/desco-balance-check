/**
 * Dates in DESCO's timezone.
 *
 * Kept free of imports so the DESCO client and the saved-data store can use it
 * without a circular dependency on the usage module.
 */

function billingZone(): string {
    return process.env.TZ || "Asia/Dhaka";
}

/** Today in the billing timezone, as YYYY-MM-DD. */
export function todayInBillingZone(): string {
    return new Date().toLocaleDateString("en-CA", { timeZone: billingZone() });
}

/** A YYYY-MM-DD date moved by whole days. */
export function shiftDate(date: string, days: number): string {
    const shifted = new Date(`${date}T00:00:00Z`);
    shifted.setUTCDate(shifted.getUTCDate() + days);
    return shifted.toISOString().slice(0, 10);
}

/** The month before the current one in the billing timezone, as YYYY-MM. */
export function previousMonthInBillingZone(): string {
    const [year, month] = todayInBillingZone().split("-").map(Number);
    const previous = new Date(Date.UTC(year, month - 2, 1));
    return previous.toISOString().slice(0, 7);
}

/** The current time in the billing timezone, as "YYYY-MM-DD HH:mm". */
export function nowInBillingZone(date: Date = new Date()): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: billingZone(),
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date);

    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}
