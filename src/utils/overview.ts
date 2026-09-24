import {
    DailyConsumption,
    DescoResponse,
    FetchBalanceParams,
    RechargeRecord,
    fetchBalance,
    fetchDailyConsumption,
    fetchRechargeHistory,
} from "../desco";
import { fetchedAtOf, staleAsOf } from "../descoStore";
import { shiftDate } from "./dates";
import { escapeHtml } from "./html";
import {
    DailyDelta,
    UsageSummary,
    consumptionRange,
    dailyDeltas,
    summarizeUsage,
    formatDayMonth,
    forecastNote,
    todayInBillingZone,
    staleNote,
    USAGE_WINDOW_DAYS,
    TARIFF_WINDOW_DAYS,
} from "./usage";

/** Bounds for the period the user may ask about. */
export const MIN_OVERVIEW_DAYS = 1;
export const MAX_OVERVIEW_DAYS = 90;

/** Recharges listed in the overview, newest first. */
const MAX_RECHARGES_SHOWN = 5;

/**
 * Rows in the day-by-day table. DESCO only serves about 45 days of readings,
 * so this is a guard against an unexpectedly long response rather than a limit
 * users will normally meet.
 */
const MAX_DAILY_ROWS = 45;

export interface PeriodSummary {
    fromDate: string;
    toDate: string;
    /** Days actually covered, which may be short if DESCO has gaps. */
    days: number;
    totalTaka: number;
    totalKwh: number;
    takaPerDay: number;
    kwhPerDay: number;
    /** Busiest and quietest single day; null if every step spans a gap. */
    highest: DailyDelta | null;
    lowest: DailyDelta | null;
    /** Per-day usage, oldest first, for the day-by-day table. */
    entries: DailyDelta[];
}

export interface DailyUsageReport {
    today: string;
    yesterday: string;
    /** Oldest day inside the requested window. */
    firstDay: string;
    /** Everything fetched, oldest first. Wider than the window, so the tariff curve has a baseline. */
    rows: DailyConsumption[];
    /** Only the days inside the requested window. */
    period: PeriodSummary | null;
    /** Newest day DESCO has a reading for. */
    latestReadingDate: string | null;
    /** Yesterday was checked for and DESCO has not published it yet. */
    yesterdayUnpublished: boolean;
    /** When this data was last fetched from DESCO. */
    checkedAt?: Date;
    /** Set when DESCO did not answer and a saved copy was used. */
    savedCopyAsOf?: Date;
}

/**
 * Daily usage for "the last N days", meaning the N days ending yesterday, since
 * today has no reading until tomorrow.
 */
export async function getDailyUsage(
    params: FetchBalanceParams,
    requestedDays: number
): Promise<DailyUsageReport | null> {
    const today = todayInBillingZone();
    const yesterday = shiftDate(today, -1);
    const firstDay = shiftDate(today, -requestedDays);

    // One reading before the window is needed to turn the first cumulative
    // reading into a day's usage, and the tariff curve needs a baseline from
    // the previous month, so the fetch reaches further back than the window.
    const { dateFrom, dateTo } = consumptionRange(today, Math.max(requestedDays + 1, TARIFF_WINDOW_DAYS));
    const rows = await fetchDailyConsumption(params, dateFrom, dateTo);
    if (!rows) return null;

    // Daily figures are computed across everything fetched and only then cut to
    // the window. Cutting first loses the reading before the window, and the
    // old code then fell back to the entire fetch: a request for one day
    // returned thirty-seven, and the newest of those was reported as
    // "yesterday" when it was the day before.
    const entries = dailyDeltas(rows).filter((day) => day.date >= firstDay && day.date <= yesterday);
    const latestReadingDate = rows.length > 0 ? rows[rows.length - 1].date : null;
    const savedCopyAsOf = staleAsOf(rows);

    return {
        today,
        yesterday,
        firstDay,
        rows,
        period: summarizePeriod(entries),
        latestReadingDate,
        yesterdayUnpublished: !savedCopyAsOf && (latestReadingDate ?? "") < yesterday,
        checkedAt: fetchedAtOf(rows),
        savedCopyAsOf,
    };
}

export interface Overview {
    requestedDays: number;
    /** Null when DESCO would not serve the balance; the rest of the report still stands. */
    balance: DescoResponse | null;
    usage: UsageSummary | null;
    period: PeriodSummary | null;
    /** The daily series behind `period`, with its dates and freshness. */
    daily: DailyUsageReport | null;
    /** Null when the lookup failed, empty when there were simply no recharges. */
    recharges: RechargeRecord[] | null;
    /** Set when any part is a saved copy because DESCO did not answer. */
    staleLine?: string | null;
}

export function summarizePeriod(deltas: DailyDelta[]): PeriodSummary | null {
    if (deltas.length === 0) return null;

    const totalTaka = deltas.reduce((sum, d) => sum + d.taka, 0);
    const totalKwh = deltas.reduce((sum, d) => sum + d.kwh, 0);
    const days = deltas.reduce((sum, d) => sum + d.spanDays, 0);

    if (days <= 0) return null;

    // A step covering several days would look like a spike next to single days,
    // so only true one-day steps are eligible for the high/low reading.
    const singleDays = deltas.filter((d) => d.spanDays === 1);

    // Ranked by kWh, not cost. DESCO's tariff is banded, so the rate per unit
    // climbs through the month and resets on the 1st; ranking by taka would
    // report where the month's total had reached rather than the busiest day.
    const byUsage = [...singleDays].sort((a, b) => a.kwh - b.kwh);

    return {
        fromDate: deltas[0].date,
        toDate: deltas[deltas.length - 1].date,
        days,
        totalTaka,
        totalKwh,
        takaPerDay: totalTaka / days,
        kwhPerDay: totalKwh / days,
        highest: byUsage.length > 0 ? byUsage[byUsage.length - 1] : null,
        lowest: byUsage.length > 0 ? byUsage[0] : null,
        entries: deltas,
    };
}

/**
 * Balance, usage over the requested window, and recharges in the same window.
 * Only the balance is required; the rest degrade to null on failure.
 */
export async function getOverview(
    params: FetchBalanceParams,
    requestedDays: number
): Promise<{ success: boolean; overview?: Overview; error?: string; attemptedUrls?: string[] }> {
    // Recharges cover exactly the requested window. They used to share the
    // wider range fetched for the tariff curve, so "/usage 7" listed a
    // recharge from three weeks earlier under "last 7d".
    const rechargeRange = consumptionRange(todayInBillingZone(), requestedDays);

    // Issued together rather than in sequence. These are independent endpoints,
    // and running them in series meant one slow call delayed the rest and a
    // single failure took down parts of the report that had nothing to do with
    // it. Each is allowed to fail on its own.
    const [balanceResult, daily, recharges] = await Promise.all([
        fetchBalance(params).catch((error: any) => {
            console.error("Overview: balance lookup failed:", error.message);
            return null;
        }),
        getDailyUsage(params, requestedDays).catch((error: any) => {
            console.error("Overview: daily consumption failed:", error.message);
            return null;
        }),
        fetchRechargeHistory(params, rechargeRange.dateFrom, rechargeRange.dateTo).catch((error: any) => {
            console.error("Overview: recharge history failed:", error.message);
            return null;
        }),
    ]);

    const balance = balanceResult?.success ? balanceResult.data ?? null : null;

    // Nothing usable came back at all, so there is no report to show.
    if (!balance && !daily) {
        return {
            success: false,
            error: balanceResult?.error ?? "DESCO did not respond (it may be slow or unavailable right now)",
            attemptedUrls: balanceResult?.attemptedUrls,
        };
    }

    let usage: UsageSummary | null = null;

    // The runway needs a balance to spend down, so it is only produced when the
    // balance came back. The usage table stands on its own without it.
    if (daily && balance) {
        const windowStart = consumptionRange(balance.readingTime, USAGE_WINDOW_DAYS + 1).dateFrom;
        const recent = daily.rows.filter((row) => row.date >= windowStart);
        usage = summarizeUsage(
            recent.length >= 2 ? recent : daily.rows,
            balance.balance,
            balance.readingTime,
            daily.rows
        );
    }

    return {
        success: true,
        overview: {
            requestedDays,
            balance,
            usage,
            period: daily?.period ?? null,
            daily,
            recharges,
            staleLine: staleNote(balance, daily?.rows, recharges),
        },
    };
}

/**
 * Day-by-day table inside a <pre> block so the columns align in Telegram.
 * A step covering a gap is marked, since its figure is the total for several
 * days rather than for the one date shown.
 */
/**
 * The aligned day-by-day table, as plain text for a <pre> block.
 *
 * Shared by /usage and the assistant, so a list of days always renders the
 * same way instead of however the model chose to format it.
 */
export function renderDailyTable(entries: DailyDelta[]): string {
    const body = entries.slice(-MAX_DAILY_ROWS).map((row) => {
        const label = formatDayMonth(new Date(Date.parse(row.date)))
            + (row.spanDays > 1 ? ` *${row.spanDays}d` : "");
        // Cost per unit for the day. This is where the banded tariff becomes
        // visible: the same kWh costs far more late in a month than early,
        // which the kWh and BDT columns alone do not reveal.
        const rate = row.kwh > 0 ? (row.taka / row.kwh).toFixed(2) + (row.slabChange ? "†" : "") : "—";
        return `${label.padEnd(10)}${row.kwh.toFixed(2).padStart(6)}${row.taka.toFixed(2).padStart(8)}${rate.padStart(row.slabChange ? 8 : 7)}`;
    });

    return ["Date         kWh     BDT   Tariff", ...body].join("\n");
}

/** Footnotes for markers that appear in a day-by-day table. */
function tableNotes(rows: DailyDelta[]): string[] {
    const notes: string[] = [];
    if (rows.some((row) => row.spanDays > 1)) {
        notes.push("<i>* DESCO skipped a reading; that row covers several days.</i>");
    }
    if (rows.some((row) => row.slabChange)) {
        notes.push(
            "<i>† The slab changed that day, so the figure mixes rates and is not a DESCO tariff. " +
            "Crossing 50 units in a month also re-prices the month's earlier units.</i>"
        );
    }
    return notes;
}

/**
 * The table as it is sent: the <pre> block, plus a note when a row covers
 * several days, since "6 Sept *2d" means nothing on its own.
 */
export function dailyTableHtml(entries: DailyDelta[]): string {
    const rows = entries.slice(-MAX_DAILY_ROWS);
    const lines = [`<pre>${renderDailyTable(rows)}</pre>`];

    lines.push(...tableNotes(rows));
    return lines.join("\n");
}

function formatDailyTable(entries: DailyDelta[]): string[] {
    if (entries.length === 0) return [];

    const rows = entries.slice(-MAX_DAILY_ROWS);

    const lines = [
        "",
        "📅 <b>Day by day:</b>",
        `<pre>${renderDailyTable(rows)}</pre>`,
        "<i>Tariff = BDT per kWh that day. It climbs through the month and resets on the 1st.</i>",
    ];

    if (entries.length > rows.length) {
        lines.push(`<i>Showing the most recent ${rows.length} of ${entries.length} days.</i>`);
    }
    lines.push(...tableNotes(rows));

    return lines;
}

/**
 * Recharges for a period on their own, with the split between energy credit
 * and charges spelled out. The first recharge of a month carries that month's
 * demand charge, so two equal payments can credit very different amounts.
 */
export async function getRecharges(
    params: FetchBalanceParams,
    requestedDays: number
): Promise<{ success: boolean; recharges?: RechargeRecord[]; error?: string }> {
    // Anchored to today rather than to a meter reading date. This previously
    // called getBalance purely to borrow its readingTime, which tied recharge
    // history to an unrelated endpoint: when getBalance was slow, /recharges
    // spent the whole timeout budget failing without ever asking DESCO for a
    // single recharge. Recharges are timestamped payments, not meter readings,
    // so today's date is the correct anchor anyway.
    const { dateFrom, dateTo } = consumptionRange(todayInBillingZone(), requestedDays);
    const recharges = await fetchRechargeHistory(params, dateFrom, dateTo);

    if (recharges === null) {
        return {
            success: false,
            error: "DESCO did not return recharge history (it may be slow or unavailable right now)",
        };
    }

    return { success: true, recharges };
}


/**
 * Recharges listed individually. A year of history can run past Telegram's
 * 4,096-character limit, which rejects the whole message and leaves the user
 * with only "Loading...", so older ones are summarised.
 */
const MAX_RECHARGES_LISTED = 20;

export function formatRechargeHistoryMessage(
    recharges: RechargeRecord[],
    requestedDays: number
): string {
    const lines = [`<b>💳 Recharge History — Last ${requestedDays} days</b>`];

    if (recharges.length === 0) {
        lines.push("", "<i>No recharges found in this period.</i>");
        return lines.join("\n");
    }

    // Totals count only orders DESCO reports as successful. Adding every
    // order counted one that had not gone through as money paid.
    const confirmed = recharges.filter((r) => /success/i.test(r.orderStatus));
    const unconfirmed = recharges.filter((r) => !/success/i.test(r.orderStatus));

    const total = confirmed.reduce((sum, r) => sum + r.totalAmount, 0);
    const energy = confirmed.reduce((sum, r) => sum + r.energyAmount, 0);
    const charges = confirmed.reduce((sum, r) => sum + r.chargeAmount, 0);

    lines.push("");
    if (confirmed.length > 0) {
        lines.push(
            `<b>Paid:</b> <code>${total.toFixed(2)} BDT</code> across ${confirmed.length} recharge${confirmed.length === 1 ? "" : "s"}`,
            `⚡ <b>Became energy:</b> <code>${energy.toFixed(2)} BDT</code>`,
            `🧾 <b>Charges &amp; VAT:</b> <code>${charges.toFixed(2)} BDT</code>` +
                (total > 0 ? ` (${((charges / total) * 100).toFixed(1)}%)` : "")
        );
    }
    if (unconfirmed.length > 0) {
        const pending = unconfirmed.reduce((sum, r) => sum + r.totalAmount, 0);
        lines.push(
            `⚠️ <b>${unconfirmed.length} order${unconfirmed.length === 1 ? "" : "s"} not confirmed</b> ` +
            `(<code>${pending.toFixed(2)} BDT</code>, not counted above). Check ` +
            `${unconfirmed.length === 1 ? "it" : "they"} reached your meter.`
        );
    }
    lines.push("");

    const stale = staleNote(recharges);

    for (const r of recharges.slice(0, MAX_RECHARGES_LISTED)) {
        const date = formatDayMonth(new Date(Date.parse(r.rechargeDate.slice(0, 10))));
        const ok = /success/i.test(r.orderStatus);

        lines.push(
            `${ok ? "•" : "⚠️"} <b>${date}</b> — <code>${r.totalAmount.toFixed(2)} BDT</code>`,
            `   energy <code>${r.energyAmount.toFixed(2)}</code> · charges <code>${r.chargeAmount.toFixed(2)}</code>`,
            `   via ${escapeHtml(r.rechargeOperator)}${ok ? "" : ` · <b>${escapeHtml(r.orderStatus)}</b>`}`
        );
    }

    if (recharges.length > MAX_RECHARGES_LISTED) {
        lines.push(`<i>…and ${recharges.length - MAX_RECHARGES_LISTED} older recharge(s).</i>`);
    }

    if (stale) {
        lines.push("", stale);
    }

    return lines.join("\n");
}

function formatRechargeLine(recharge: RechargeRecord): string {
    // rechargeDate is "YYYY-MM-DD HH:mm:ss.S"; only the date is worth showing.
    const date = formatDayMonth(new Date(Date.parse(recharge.rechargeDate.slice(0, 10))));
    const failed = !/success/i.test(recharge.orderStatus);

    return `  • ${date} — <code>${recharge.totalAmount.toFixed(0)} BDT</code> ` +
        `(energy <code>${recharge.energyAmount.toFixed(2)}</code>)` +
        (failed ? ` ⚠️ ${escapeHtml(recharge.orderStatus)}` : "");
}

export function formatOverviewMessage(overview: Overview): string {
    const { requestedDays, balance, usage, period, recharges } = overview;
    const lines: string[] = [];

    lines.push(`<b>📊 Usage Overview — Last ${requestedDays} day${requestedDays === 1 ? "" : "s"}</b>`);

    if (period) {
        const from = formatDayMonth(new Date(Date.parse(period.fromDate)));
        const to = formatDayMonth(new Date(Date.parse(period.toDate)));
        lines.push(`<i>${from} – ${to}</i>`, "");

        const unpublished = overview.daily?.yesterdayUnpublished ?? false;
        if (unpublished) {
            const yesterday = formatDayMonth(new Date(Date.parse(overview.daily!.yesterday)));
            lines.push(`<i>ℹ️ DESCO has not published ${yesterday} yet, so the newest day shown is ${to}.</i>`, "");
        }
        if (period.days < requestedDays - (unpublished ? 1 : 0)) {
            lines.push(`<i>⚠️ DESCO only has ${period.days} day(s) of readings for this range.</i>`, "");
        }

        lines.push(
            `⚡ <b>Used:</b> <code>${period.totalKwh.toFixed(2)} kWh</code> · <code>${period.totalTaka.toFixed(2)} BDT</code>`,
            `📉 <b>Daily avg:</b> <code>${period.kwhPerDay.toFixed(2)} kWh</code> · <code>${period.takaPerDay.toFixed(2)} BDT</code>`
        );

        if (period.highest && period.lowest && period.highest.date !== period.lowest.date) {
            lines.push(
                `🔺 <b>Busiest:</b> <code>${period.highest.kwh.toFixed(2)} kWh</code> on ${formatDayMonth(new Date(Date.parse(period.highest.date)))}`,
                `🔻 <b>Quietest:</b> <code>${period.lowest.kwh.toFixed(2)} kWh</code> on ${formatDayMonth(new Date(Date.parse(period.lowest.date)))}`
            );
        }

        lines.push(...formatDailyTable(period.entries));
    } else {
        lines.push("", "<i>No consumption readings available for this range.</i>");
    }

    if (balance) {
        lines.push("", `💰 <b>Balance:</b> <code>${balance.balance.toFixed(2)} BDT</code>`);
    } else {
        lines.push("", "<i>💰 Balance unavailable right now — DESCO did not answer. The usage above is still accurate.</i>");
    }

    if (usage) {
        const days = Math.floor(usage.daysRemaining);
        lines.push(
            `⏳ <b>Runs out:</b> <code>~${days} ${days === 1 ? "day" : "days"}</code> (around ${formatDayMonth(usage.runoutDate)})`
        );
    }

    if (balance) {
        lines.push(`⚡ <b>This month:</b> <code>${balance.currentMonthTaka.toFixed(2)} BDT</code>`);
    }

    if (recharges === null) {
        lines.push("", "<i>Recharge history unavailable right now.</i>");
    } else if (recharges.length === 0) {
        lines.push("", `💳 <b>Recharges (last ${requestedDays}d):</b> none`);
    } else {
        // Labelled with the requested window, because recharge history reaches
        // further back than the daily readings do.
        const total = recharges.reduce((sum, r) => sum + r.totalAmount, 0);
        lines.push(
            "",
            `💳 <b>Recharges (last ${requestedDays}d):</b> ${recharges.length} · <code>${total.toFixed(0)} BDT</code> total`
        );
        lines.push(...recharges.slice(0, MAX_RECHARGES_SHOWN).map(formatRechargeLine));

        if (recharges.length > MAX_RECHARGES_SHOWN) {
            lines.push(`  <i>…and ${recharges.length - MAX_RECHARGES_SHOWN} more</i>`);
        }
    }

    if (balance) {
        lines.push("", `📅 <b>Balance date:</b> <code>${formatDayMonth(new Date(Date.parse(balance.readingTime)))}</code>`);
    }

    if (usage) {
        lines.push("", forecastNote(usage));
    }

    if (overview.staleLine) {
        lines.push("", overview.staleLine);
    }

    return lines.join("\n");
}
