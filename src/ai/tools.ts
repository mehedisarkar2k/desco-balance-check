import { Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";
import { UserService } from "../services/UserService";
import { User } from "../models/User";
import { fetchCustomerInfo, fetchMonthlyConsumption, fetchDailyConsumption } from "../desco";
import { SlabSchedule, buildMonthCurves, describeTariff, referenceCurve, slabSchedule } from "../domain/tariff";
import { monthToDateUnits, spendDays } from "../domain/runway";
import {
    PendingCharges,
    RechargeTerms,
    forecastThrough,
    monthsAfter,
    monthsOwed,
    nextMonth,
    rechargeTimeline,
    runsOutOn,
} from "../domain/recharge";
import {
    consumptionRange,
    TARIFF_WINDOW_DAYS,
    USAGE_WINDOW_DAYS,
    todayInBillingZone,
    dailyDeltas,
    DailyDelta,
} from "../utils/usage";
import { formatBalanceMessage, getBalanceReport } from "../utils/usage";
import { dailyTableHtml, getDailyUsage, getRecharges } from "../utils/overview";
import { Session, activeSessionCount, registerDisplay } from "./session";
import { staleAsOf } from "../descoStore";
import { nowInBillingZone, shiftDate } from "../utils/dates";
import { parseTimes } from "../utils/times";
import type { ReplyLanguage } from "./language";
import { CardOption, renderRechargeCard, renderSimulationCard } from "./rechargeCard";

export type Role = "user" | "admin";

export interface ToolContext {
    session: Session;
    userId: number;
    role: Role;
    accountNo?: string;
    meterNo?: string;
    /** The reply language, for blocks rendered in code rather than written by the model. */
    language: ReplyLanguage;
}

interface Tool {
    declaration: FunctionDeclaration;
    /** Lowest role allowed to call this. */
    minRole: Role;
    handler: (args: any, ctx: ToolContext) => Promise<unknown>;
}

/**
 * Flags a result built from a saved copy, so the model tells the user the
 * figures are not live.
 */
function withFreshness<T extends object>(result: T, ...sources: unknown[]): T {
    const times = sources.map(staleAsOf).filter((t): t is Date => Boolean(t));
    if (times.length === 0) return result;

    const oldest = new Date(Math.min(...times.map((t) => new Date(t).getTime())));
    return {
        ...result,
        savedCopy: true,
        dataAsOf: oldest.toISOString(),
        freshnessNote:
            "DESCO did not respond, so these figures are a saved copy from dataAsOf. Tell the user that plainly.",
    };
}

/** When the oldest saved copy behind a result was taken, in Dhaka time, or null if all of it is live. */
function savedCopyAsOf(...sources: unknown[]): string | null {
    const times = sources.map(staleAsOf).filter((t): t is Date => Boolean(t));
    if (times.length === 0) return null;
    return nowInBillingZone(new Date(Math.min(...times.map((t) => new Date(t).getTime()))));
}

/** One day's usage in the shape the model is given. */
function describeDay(day: DailyDelta) {
    return {
        date: day.date,
        kwh: Number(day.kwh.toFixed(2)),
        bdt: Number(day.taka.toFixed(2)),
        // The tariff charged that day, so "what rate was I charged on the 7th"
        // does not leave the model to do the division. Withheld on a
        // slab-change day: that figure mixes two rates, and told in words not
        // to quote it, the model quoted it anyway.
        ratePerKwh: day.kwh > 0 && !day.slabChange ? Number((day.taka / day.kwh).toFixed(2)) : null,
        // Above 1 when DESCO skipped readings; the figure then covers several days.
        coversDays: day.spanDays,
        ...(day.slabChange
            ? {
                slabChange: {
                    rateBefore: day.rateBefore ?? null,
                    rateAfter: day.rateAfter ?? null,
                    note:
                        "The slab changed during this day, so it was not charged at one rate. Give the rates " +
                        "before and after. Crossing 50 units in a month also re-prices the month's earlier " +
                        "units, which is why this day cost more than its own use.",
                },
            }
            : {}),
    };
}

/** Rounded up to the next 10 taka, the way people actually pay. */
const roundUpTo10 = (value: number) => Math.ceil(value / 10) * 10;

/**
 * How much more use the "safe" amount allows for. Asked for a safe amount, the
 * model only ever added three days, which covers a late return but not a hot
 * week with the AC on.
 */
const SAFE_MARGIN = 0.15;

/** Days covered after coming home from a trip, when the user gave none. */
const TRIP_BUFFER_DAYS = 3;

/** The last day of the month `month` (YYYY-MM), as YYYY-MM-DD. */
function lastDayOf(month: string): string {
    const [year, m] = month.split("-").map(Number);
    return new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
}

const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/** The same day of the next month, or its last day when the next month is shorter. */
function nextMonthSameDay(date: string): string {
    const [year, month, dayOfMonth] = date.split("-").map(Number);
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(dayOfMonth, last))).toISOString().slice(0, 10);
}

/** Days nobody is home, both ends included, and what is used each of those days. */
interface Away {
    from: string;
    until: string;
    kwhPerDay: number;
    /** No return date was given; `until` is only where the calculation stops. */
    openEnded: boolean;
}

/** No more than this is believed to run in an empty home. */
const MAX_AWAY_KWH_PER_DAY = 10;

/**
 * Reads awayFrom/awayUntil from a tool call: absent, valid, or an error to
 * hand back. A trip with no return date runs to `openUntil`: "if I leave on
 * the 14th with the fridge on, how long will it last?" has no return date to
 * give, and requiring one sent the user an error about date formats.
 */
function parseAway(args: any, today: string, openUntil: string): Away | null | { error: string } {
    let from = String(args?.awayFrom ?? "").trim();
    const given = String(args?.awayUntil ?? "").trim();
    if (!from && !given) return null;
    const openEnded = Boolean(from) && !given;
    let until = openEnded ? openUntil : given;

    // A trip that would be over already was given as a bare day of the month
    // ("14 tarikh jabo, 10 din thakbo") and read as this month's 14th, and the
    // user was told their trip had ended. A whole trip in the past cannot be
    // meant, so it is the next month's.
    if (isDate(from) && isDate(until) && !openEnded && until <= today && from <= until) {
        from = nextMonthSameDay(from);
        until = nextMonthSameDay(until);
    }

    if (!isDate(from) || !isDate(until)) {
        return { error: "awayFrom and awayUntil must both be dates in YYYY-MM-DD format." };
    }
    if (until < from) {
        // Said to the model, not the user: a bare "10 tarikh" in a message
        // that also named November was read as 10 Nov, and the user was told
        // their trip was impossible.
        return {
            error:
                "awayFrom is after awayUntil. A departure given only as a day of the month is the next such " +
                `day after today (${today}); correct the dates and call again rather than asking the user.`,
        };
    }
    if (until <= today) return { error: "The time away must end after today." };
    if (from > shiftDate(today, 120)) return { error: "The time away must start within 120 days." };

    const kwh = args?.awayKwhPerDay === undefined || args?.awayKwhPerDay === null ? 0 : Number(args.awayKwhPerDay);
    if (!Number.isFinite(kwh) || kwh < 0 || kwh > MAX_AWAY_KWH_PER_DAY) {
        return { error: `awayKwhPerDay must be between 0 and ${MAX_AWAY_KWH_PER_DAY}.` };
    }

    return { from: from < today ? shiftDate(today, 1) : from, until, kwhPerDay: kwh, openEnded };
}

/**
 * One month's fixed charge in whole taka. The total is this times the months,
 * so the figures always add up: rounded separately, one month showed as 175.53
 * and two as 351.05, and the model's own sum came to 351.06.
 */
function chargePerMonth(terms: RechargeTerms): number {
    return terms.monthlyChargeBDT === null ? 0 : Math.round(terms.monthlyChargeBDT);
}

/** Fixed charges as the model is given them. */
function describeCharges(months: string[], terms: RechargeTerms) {
    return {
        months,
        perMonthBDT: chargePerMonth(terms),
        totalBDT: months.length * chargePerMonth(terms),
    };
}

interface ProjectionInputs {
    balance: number;
    balanceDate: string;
    kwhPerDay: number;
    /**
     * A fresh day-by-day spend sequence each call, since a generator can only
     * be read once. `scale` multiplies use at home, for the safe amount.
     */
    days: (away?: Away | null, scale?: number) => Iterable<import("../domain/runway").DaySpend>;
    terms: RechargeTerms;
    pending: PendingCharges | null;
    /** The slabs future months are priced with, for showing the rates. */
    slabs: SlabSchedule | null;
    freshnessSources: unknown[];
}

/**
 * Everything a recharge calculation needs, taken from the same report as the
 * runway shown in /balance, so "your balance lasts until 12 Oct" and "recharge
 * X to reach the 31st" come from one projection and cannot disagree.
 */
async function projectionInputs(params: { accountNo?: string; meterNo?: string }): Promise<ProjectionInputs | { error: string }> {
    const report = await getBalanceReport(params);
    if (!report.success || !report.report) return { error: report.error ?? "Could not reach DESCO" };

    const { data, usage, rows, recharges, terms, pending } = report.report;
    if (!usage || !rows) return { error: "Not enough daily readings to project usage yet." };

    const units = monthToDateUnits(rows, data.readingTime);
    if (units === null) return { error: "Not enough daily readings this month to price future usage." };

    const probe = spendDays(rows, data.readingTime, usage.kwhPerDay, units);
    if (!probe) return { error: "Could not work out the tariff from the readings." };

    return {
        balance: data.balance,
        balanceDate: data.readingTime,
        kwhPerDay: usage.kwhPerDay,
        days: (away, scale = 1) => {
            const kwhOn = away
                ? (date: string) => (date >= away.from && date <= away.until ? away.kwhPerDay : undefined)
                : undefined;
            return spendDays(rows, data.readingTime, usage.kwhPerDay * scale, units, kwhOn) ?? [];
        },
        terms,
        pending,
        slabs: (() => {
            const curve = referenceCurve(buildMonthCurves(rows), data.readingTime.slice(0, 7));
            return curve ? slabSchedule(curve) : null;
        })(),
        freshnessSources: [data, rows, recharges],
    };
}

/**
 * The assumptions behind every recharge figure. The one that decides the
 * answer is given apart from the rest: handed a list, the model recited all
 * five in every reply, burying the amount under the method.
 */
function rechargeAssumptions(inputs: ProjectionInputs, away?: Away | null) {
    const { terms } = inputs;
    const home = `${inputs.kwhPerDay.toFixed(2)} kWh a day at home, the average of the last 14 days`;
    const awayPart = !away
        ? ""
        : away.kwhPerDay > 0
            ? `; ${away.kwhPerDay} kWh a day from ${away.from} to ${away.until} while away, for what stays on`
            : `; nothing from ${away.from} to ${away.until} while away, with everything off`;

    return {
        mainAssumption: `Use: ${home}${awayPart}. More use, e.g. more AC, needs more.`,
        howItWasWorkedOut: [
            "Each day is priced with the slab rates found in this account's own readings; the rate resets on the 1st.",
            `${(terms.energyShare * 100).toFixed(2)}% of each taka recharged becomes energy credit` +
                (terms.derived ? " (measured from past recharges)." : " (5% VAT less the 0.5% rebate; no past recharge to measure it from)."),
            terms.monthlyChargeBDT !== null
                ? `Every calendar month has a fixed charge of about ${chargePerMonth(terms)} BDT, even a month ` +
                  "with no use. It is never taken from the balance. The first recharge made in or after a month pays " +
                  "it, along with every earlier month that had no recharge. There is no late fee on it."
                : "The fixed monthly charge could not be measured from past recharges, so it is not included.",
        ],
    };
}

/**
 * Warns when a recharge would first pay several months of fixed charges.
 * What DESCO does with a recharge smaller than the charges owed is not
 * documented, so the advice is to stay well above them.
 */
function arrearsNote(months: string[], terms: RechargeTerms): string | undefined {
    if (months.length < 2 || terms.monthlyChargeBDT === null) return undefined;
    return (
        `This recharge first pays ${months.length} months of fixed charges ` +
        `(${months.length * chargePerMonth(terms)} BDT) before any power. A recharge smaller than ` +
        "that adds no power, and DESCO does not say how it treats one, so recharge well above it."
    );
}

/**
 * The scheduler is loaded only when a change needs it. Importing it at the top
 * would pull the Telegram client into everything that touches the tools.
 */
async function applyScheduleChange() {
    const { refreshSchedules } = await import("../scheduler");
    await refreshSchedules();
}

/**
 * True when the runway runs past what the balance buys at the recent daily
 * cost, which happens when it crosses the 1st and the slab resets.
 */
function runwayOutlastsAverage(balance: number, usage: { takaPerDay: number; daysRemaining: number; tariffAware: boolean } | null) {
    if (!usage || !usage.tariffAware || !(usage.takaPerDay > 0)) return false;
    return usage.daysRemaining >= balance / usage.takaPerDay + 1;
}

/** No account saved means the DESCO tools cannot run; say so rather than failing. */
function requireAccount(ctx: ToolContext): { accountNo?: string; meterNo?: string } | null {
    if (!ctx.accountNo && !ctx.meterNo) return null;
    return { accountNo: ctx.accountNo, meterNo: ctx.meterNo };
}

const TOOLS: Record<string, Tool> = {
    get_balance: {
        minRole: "user",
        declaration: {
            name: "get_balance",
            description:
                "Current DESCO prepaid balance for the user, the newest day's usage, how many days of power the " +
                "balance is expected to last, the expected run-out date, and average daily consumption.",
        },
        handler: async (_args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const result = await getBalanceReport(params);
            if (!result.success || !result.report) {
                return { error: result.error ?? "Could not reach DESCO" };
            }

            const { data, usage, pending, terms } = result.report;
            const yesterday = shiftDate(todayInBillingZone(), -1);
            const latest = usage?.latestDay;

            return withFreshness({
                balanceBDT: data.balance,
                monthToDateCostBDT: data.currentMonthTaka,
                // Named apart on purpose. The balance carries today's date while
                // the newest daily reading is normally yesterday's, and one field
                // called "readingDate" let the two be confused.
                balanceDate: data.readingTime,
                latestDailyReading: latest ? describeDay(latest) : null,
                yesterday,
                yesterdayPublished: Boolean(latest && latest.date >= yesterday),
                daysRemaining: usage?.daysRemaining ?? null,
                runoutDate: usage?.runoutDate?.toISOString().slice(0, 10) ?? null,
                avgDailyKwh: usage ? Number(usage.kwhPerDay.toFixed(2)) : null,
                avgDailyBDT: usage ? Math.round(usage.takaPerDay) : null,
                ...(runwayOutlastsAverage(data.balance, usage)
                    ? {
                        // "54.82 BDT a day" beside "18 days" on a 771 balance
                        // reads as a sum done wrong: 771 / 54.82 is 14.
                        runwayNote:
                            "daysRemaining is longer than balance divided by avgDailyBDT because the rate starts " +
                            "again from the cheapest slab on the 1st. If you give both figures, say so.",
                    }
                    : {}),
                tariffAware: usage?.tariffAware ?? false,
                fixedChargesDueNextRecharge: pending
                    ? {
                        ...describeCharges(pending.months, terms),
                        note:
                            "Taken from the next recharge before any power, never from this balance. Each month " +
                            "without a recharge adds one more. No late fee.",
                    }
                    : null,
            }, data);
        },
    },

    show_balance_update: {
        minRole: "user",
        declaration: {
            name: "show_balance_update",
            description:
                "Prepares the same balance update the daily reminder sends: balance, yesterday's usage, days " +
                "left and this month's cost. Use when the user asks to be sent their reminder or an update now " +
                "('reminder pathaw', 'update dao', 'send me my update'). Returns a displayMessage token: put it " +
                "on its own line in the reply and the bot replaces it with the update.",
        },
        handler: async (_args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const result = await getBalanceReport(params);
            if (!result.success || !result.report) {
                return { error: result.error ?? "Could not reach DESCO" };
            }

            // The exact message the scheduled reminder sends, so asking for it
            // in chat gets the same thing rather than the model's paraphrase.
            const { data, usage, pending } = result.report;
            return withFreshness({
                displayMessage: registerDisplay(ctx.session, formatBalanceMessage(data, usage, "🔔 Balance Update", pending)),
                balanceBDT: data.balance,
                balanceDate: data.readingTime,
            }, data);
        },
    },

    plan_recharge: {
        minRole: "user",
        declaration: {
            name: "plan_recharge",
            description:
                "Works out how much to recharge so the power lasts until a given date: the end of this or next " +
                "month, or past a trip. Projects day-by-day use at the recent average, priced with the slab rates " +
                "(which reset on the 1st), with little or no use on days away. Spends the current balance first, and adds " +
                "what a recharge loses to VAT and to fixed monthly charges, including those of months with no " +
                "recharge. Gives the amount for each month the recharge could be made in, and a safe amount that " +
                "allows for more use. Returns a displayCard token with the whole answer written out. Use it for " +
                "every question about how much to recharge or load.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    until: {
                        type: Type.STRING,
                        description: "Last day to cover, YYYY-MM-DD. For all of next month, its last day.",
                    },
                    awayFrom: {
                        type: Type.STRING,
                        description:
                            "Optional. First day nobody is home (trip, holiday), YYYY-MM-DD. Those days use only " +
                            "awayKwhPerDay. Give with awayUntil.",
                    },
                    awayUntil: {
                        type: Type.STRING,
                        description:
                            "Optional. Last day away, YYYY-MM-DD: the day before the user is back. Back on 9 Nov " +
                            "means 2026-11-08. Leave out when they have not said when they are back.",
                    },
                    awayKwhPerDay: {
                        type: Type.NUMBER,
                        description:
                            "Optional. Power still used each day while away, by whatever stays on. A fridge alone " +
                            "is about 1.2 kWh a day. Leave out when everything is switched off.",
                    },
                    earlierDeparturePossible: {
                        type: Type.BOOLEAN,
                        description:
                            "Optional. True when the user was unsure of the departure date and awayFrom is the later " +
                            "of the dates they gave.",
                    },
                },
                required: ["until"],
            },
        },
        handler: async (args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            let until = String(args?.until ?? "").trim();
            const today = todayInBillingZone();
            if (!isDate(until)) {
                return { error: "until must be a date in YYYY-MM-DD format." };
            }
            if (until <= today) return { error: "until must be after today." };
            if (until > shiftDate(today, 120)) {
                return { error: "Plans reach at most 120 days ahead; usage that far out is too uncertain to price." };
            }

            const away = parseAway(args, today, until);
            if (away && "error" in away) return away;

            // Coming home needs power that day and after. Told so in the
            // prompt, the model still planned to the return day itself.
            if (away && !away.openEnded && until <= shiftDate(away.until, 1)) {
                until = shiftDate(away.until, 1 + TRIP_BUFFER_DAYS);
            }

            const inputs = await projectionInputs(params);
            if ("error" in inputs) return inputs;

            const forecast = forecastThrough(inputs.days(away), until, inputs.balance);
            const safeForecast = forecastThrough(inputs.days(away, 1 + SAFE_MARGIN), until, inputs.balance);
            if (!forecast || !safeForecast) return { error: "Could not project usage that far with the tariff found." };

            const { terms } = inputs;
            const thisMonth = today.slice(0, 7);
            const coverMonth = until.slice(0, 7);
            const charges = (months: string[]) => months.length * chargePerMonth(terms);

            // What to pay for the power alone, VAT included. The energy credit
            // behind it is kept from the model: given both, it quoted the
            // credit as the amount to pay, which falls short by the VAT.
            const creditNeeded = Math.max(0, forecast.totalBDT - inputs.balance);
            const safeCredit = Math.max(0, safeForecast.totalBDT - inputs.balance);
            const energyOnly = creditNeeded > 0 ? roundUpTo10(creditNeeded / terms.energyShare) : 0;
            const safeEnergyOnly = safeCredit > 0 ? roundUpTo10(safeCredit / terms.energyShare) : 0;

            // The energy is the same whenever the recharge is made; the fixed
            // charges it pays depend on the month. It can be made any day from
            // today until the balance runs out. Each option is the energy
            // amount plus its charges, so two options differ by exactly those.
            const options: CardOption[] = [];
            const warnings: string[] = [];
            const runsOut = forecast.balanceRunsOutOn;
            const runsOutWhileAway = Boolean(away && runsOut && runsOut >= away.from && runsOut <= away.until);
            if (creditNeeded > 0 && runsOut) {
                let lastDay = runsOut < until ? runsOut : until;
                // Running out mid-trip means recharging before leaving, so the
                // windows end there. Ending at the run-out date contradicted
                // the card's own "recharge before you leave".
                if (runsOutWhileAway && away) {
                    const eve = shiftDate(away.from, -1);
                    if (eve >= today && eve < lastDay) lastDay = eve;
                }
                for (let month = thisMonth; month <= lastDay.slice(0, 7); month = nextMonth(month)) {
                    const paysFor = terms.monthlyChargeBDT !== null ? monthsOwed(terms, month) : [];
                    const later = terms.monthlyChargeBDT !== null ? monthsAfter(month, coverMonth) : [];
                    const to = lastDayOf(month) < lastDay ? lastDayOf(month) : lastDay;

                    options.push({
                        from: month === thisMonth ? today : `${month}-01`,
                        to,
                        suggestedBDT: roundUpTo10(energyOnly + charges(paysFor)),
                        safeBDT: roundUpTo10(safeEnergyOnly + charges(paysFor)),
                        includes: { months: paysFor, totalBDT: charges(paysFor) },
                        later: later.length ? { months: later, totalBDT: charges(later) } : null,
                    });

                    const note = arrearsNote(paysFor, terms);
                    if (note) warnings.push(note);
                }
            }

            const pendingNext = options.length === 0 && inputs.pending
                ? { months: inputs.pending.months, totalBDT: charges(inputs.pending.months) }
                : null;
            const safeOnly = options.length === 0 && safeCredit > 0
                ? roundUpTo10(safeEnergyOnly + charges(pendingNext?.months ?? []))
                : null;

            const card = renderRechargeCard({
                language: ctx.language,
                today,
                until,
                balanceBDT: inputs.balance,
                balanceRunsOutOn: runsOut,
                away,
                runsOutWhileAway,
                options,
                safeOnlyBDT: safeOnly,
                pendingNext,
                kwhPerDay: inputs.kwhPerDay,
                usageWindowDays: USAGE_WINDOW_DAYS,
                safeMarginPercent: Math.round(SAFE_MARGIN * 100),
                earlierDeparturePossible: Boolean(away && args?.earlierDeparturePossible),
                savedCopyAsOf: savedCopyAsOf(...inputs.freshnessSources),
            });

            // Only figures the user can act on. The card already says all of
            // this; the fields are here for follow-up questions.
            return withFreshness({
                displayCard: registerDisplay(ctx.session, card),
                today,
                coverUntil: until,
                ...(away ? { awayFrom: away.from, awayUntil: away.until, awayKwhPerDay: away.kwhPerDay } : {}),
                balanceBDT: inputs.balance,
                balanceLastsUntil: runsOut ?? `past ${until}; no recharge needed`,
                ...(runsOutWhileAway ? { runsOutWhileAway: true } : {}),
                rechargeOptions: options.map((o) => ({
                    rechargeBetween: o.from === o.to ? o.from : `${o.from} and ${o.to}`,
                    suggestedBDT: o.suggestedBDT,
                    safeBDT: o.safeBDT,
                    includesFixedCharges: describeCharges(o.includes.months, terms),
                    ...(o.later
                        ? {
                            // Without this note, "if I recharge in September, how are October's and
                            // November's charges taken?" was answered: from that September recharge.
                            fixedChargesLeftForTheNextRecharge: {
                                ...describeCharges(o.later.months, terms),
                                note:
                                    "NOT taken from this recharge, and not from the balance. The recharge after this " +
                                    "one pays them first, before any power.",
                            },
                        }
                        : {}),
                })),
                ...(energyOnly > 0
                    ? {
                        energyOnlyBDT: energyOnly,
                        energyOnlyNote:
                            "What to pay for the power alone, VAT included, without any fixed charge. An estimate: " +
                            `say it assumes about ${inputs.kwhPerDay.toFixed(1)} kWh a day.`,
                    }
                    : {}),
                ...(safeOnly ? { safeBDT: safeOnly } : {}),
                safeMeans: `Still enough if use is ${Math.round(SAFE_MARGIN * 100)}% above the recent average.`,
                ...(pendingNext ? { fixedChargesDueNextRecharge: describeCharges(pendingNext.months, terms) } : {}),
                ...(warnings.length ? { warning: warnings[0] } : {}),
                ...rechargeAssumptions(inputs, away),
            }, ...inputs.freshnessSources);
        },
    },

    simulate_recharge: {
        minRole: "user",
        declaration: {
            name: "simulate_recharge",
            description:
                "What recharging a given amount on a given day would do: the fixed monthly charges and VAT it pays " +
                "first, the power it buys, and a day-by-day, slab-by-slab breakdown of how the balance and the " +
                "recharge are spent until they run out. The fixed charges depend on the month the recharge is " +
                "made in, so pass rechargeOn whenever the user names a day. Returns a displayCard token with the " +
                "breakdown written out. Use for 'if I recharge X (on day D), how long will it last' and for any " +
                "request to show the calculation or a tariff-wise breakdown.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    amountBDT: {
                        type: Type.NUMBER,
                        description:
                            "Amount the user would pay, in BDT. 0 for no recharge: how long the balance alone lasts, " +
                            "for example around a trip.",
                    },
                    rechargeOn: {
                        type: Type.STRING,
                        description:
                            "Optional. Day the recharge would be made, YYYY-MM-DD; today if left out. '1 October' " +
                            "is 2026-10-01. A recharge in a new month pays that month's fixed charge first. Given " +
                            "only a month ('oct e'), its 1st, or today if it is this month.",
                    },
                    rechargeDayUnspecified: {
                        type: Type.BOOLEAN,
                        description: "Optional. True when the user named only the month of the recharge, not the day.",
                    },
                    showBreakdown: {
                        type: Type.BOOLEAN,
                        description:
                            "Optional. True only when the user asks for the calculation: breakdown, hiseb, tariff " +
                            "wise, how it was worked out. Adds the slab-by-slab steps.",
                    },
                    awayFrom: {
                        type: Type.STRING,
                        description:
                            "Optional. First day nobody is home (trip, holiday), YYYY-MM-DD. Those days use only " +
                            "awayKwhPerDay. Give with awayUntil.",
                    },
                    awayUntil: {
                        type: Type.STRING,
                        description:
                            "Optional. Last day away, YYYY-MM-DD: the day before the user is back. Back on 9 Nov " +
                            "means 2026-11-08. Leave out when they have not said when they are back.",
                    },
                    awayKwhPerDay: {
                        type: Type.NUMBER,
                        description:
                            "Optional. Power still used each day while away, by whatever stays on. A fridge alone " +
                            "is about 1.2 kWh a day. Leave out when everything is switched off.",
                    },
                },
                required: ["amountBDT"],
            },
        },
        handler: async (args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const amount = Number(args?.amountBDT);
            // 0 is "no recharge". Without it, "how long will my balance last
            // if I leave on the 14th?" was run as a recharge of the balance
            // itself, and lasted until January.
            if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
                return { error: "amountBDT must be a number from 0 (no recharge) to 100000." };
            }

            const today = todayInBillingZone();
            const rechargeOn = String(args?.rechargeOn ?? "").trim() || today;
            if (!isDate(rechargeOn)) return { error: "rechargeOn must be a date in YYYY-MM-DD format." };
            if (rechargeOn < today) return { error: "rechargeOn cannot be in the past." };
            if (rechargeOn > shiftDate(today, 120)) return { error: "rechargeOn must be within 120 days." };

            const away = parseAway(args, today, shiftDate(today, 400));
            if (away && "error" in away) return away;

            const inputs = await projectionInputs(params);
            if ("error" in inputs) return inputs;

            // The charges follow the month the recharge is made in. Priced as
            // if made today, "500 on 1 October" skipped October's charge and
            // bought 479 of power instead of 310.
            const { terms } = inputs;
            const month = rechargeOn.slice(0, 7);
            const paysFor = terms.monthlyChargeBDT !== null ? monthsOwed(terms, month) : [];
            const chargeTotal = amount > 0 ? Math.min(amount, paysFor.length * chargePerMonth(terms)) : 0;
            const vat = Math.round(Math.max(0, amount - chargeTotal) * (1 - terms.energyShare));
            const power = Math.max(0, amount - chargeTotal - vat);

            const timeline = rechargeTimeline(
                inputs.days(away), inputs.balance, power, rechargeOn, inputs.slabs?.thresholds ?? []
            );
            const without = runsOutOn(inputs.days(away), inputs.balance);
            const withRecharge = timeline.runsOutOn;
            const extraDays = without && withRecharge
                ? Math.round((Date.parse(withRecharge) - Date.parse(without)) / 86_400_000)
                : null;
            const beforeRecharge = timeline.rechargeBefore;
            const phases = timeline.phases;

            const warning = amount > 0 && power <= 0 && paysFor.length > 0
                ? `${amount} BDT does not cover the fixed charges owed (${paysFor.length * chargePerMonth(terms)} BDT ` +
                  "for " + paysFor.join(", ") + "), so it adds no power. DESCO does not say how it treats a recharge " +
                  "smaller than the charges owed; advise recharging well above them."
                : arrearsNote(paysFor, terms);

            const card = renderSimulationCard({
                language: ctx.language,
                today,
                amountBDT: amount,
                rechargeOn,
                away,
                balanceBDT: inputs.balance,
                before: beforeRecharge ? phases.filter((p) => p.from < beforeRecharge) : phases,
                after: beforeRecharge ? phases.filter((p) => p.from >= beforeRecharge) : [],
                balanceBeforeRecharge: timeline.balanceBeforeRecharge,
                charges: { months: amount > 0 ? paysFor : [], totalBDT: chargeTotal },
                vatBDT: vat,
                powerBDT: power,
                runsOutOn: withRecharge,
                runsOutWithout: without,
                runsOutBeforeRecharge: timeline.runsOutBeforeRecharge,
                dayUnspecified: Boolean(args?.rechargeDayUnspecified),
                showBreakdown: Boolean(args?.showBreakdown),
                slabs: inputs.slabs,
                kwhPerDay: inputs.kwhPerDay,
                usageWindowDays: USAGE_WINDOW_DAYS,
                savedCopyAsOf: savedCopyAsOf(...inputs.freshnessSources),
            });

            // Whole taka: these are estimates, and paisa made them read as exact.
            return withFreshness({
                displayCard: registerDisplay(ctx.session, card),
                amountBDT: amount,
                rechargeOn,
                fixedChargesPaid: describeCharges(amount > 0 ? paysFor : [], terms),
                vatBDT: vat,
                powerBDT: power,
                ...(warning ? { warning } : {}),
                ...(away ? { awayFrom: away.from, awayUntil: away.until, awayKwhPerDay: away.kwhPerDay } : {}),
                balanceNowBDT: inputs.balance,
                lastsUntilWithoutRecharge: without,
                lastsUntilWithRecharge: withRecharge ?? "more than 400 days",
                ...(timeline.runsOutBeforeRecharge ? { runsOutBeforeTheRecharge: timeline.runsOutBeforeRecharge } : {}),
                ...(away && withRecharge && withRecharge >= away.from && withRecharge <= away.until
                    ? { runsOutWhileAway: true }
                    : {}),
                extraDays,
                ...rechargeAssumptions(inputs, away),
            }, ...inputs.freshnessSources);
        },
    },

    get_daily_usage: {
        minRole: "user",
        declaration: {
            name: "get_daily_usage",
            description:
                "Day-by-day electricity use for the last N days, ending yesterday (today has no reading until " +
                "tomorrow). Each day has kWh, BDT and the tariff charged that day (ratePerKwh). Also returns " +
                "today's and yesterday's dates, the newest date DESCO has a reading for, whether yesterday is " +
                "published yet, totals, averages, and a displayTable token for showing many days.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    days: {
                        type: Type.NUMBER,
                        description:
                            "How many days, ending yesterday: 1 is yesterday only, 7 is the last week. " +
                            "At most 45, since DESCO keeps about 45 days.",
                    },
                },
                required: ["days"],
            },
        },
        handler: async (args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const days = Math.min(Math.max(Math.round(Number(args?.days) || 7), 1), 45);
            const report = await getDailyUsage(params, days);
            if (!report) return { error: "Could not load consumption readings from DESCO." };

            const { period } = report;
            const allDays = dailyDeltas(report.rows);
            const latest = allDays[allDays.length - 1];
            const checked = report.checkedAt ? nowInBillingZone(report.checkedAt).slice(11) : null;

            return withFreshness({
                // Stated outright rather than left to inference. Given only a
                // list of rows, the model took the newest row to be yesterday
                // even when it was the day before.
                today: report.today,
                yesterday: report.yesterday,
                requestedDays: { from: report.firstDay, to: report.yesterday },
                latestReadingDate: report.latestReadingDate,
                yesterdayPublished: (report.latestReadingDate ?? "") >= report.yesterday,
                ...(report.yesterdayUnpublished
                    ? {
                        note:
                            `DESCO has not published ${report.yesterday} yet` +
                            (checked ? ` (checked at ${checked} Dhaka time)` : "") +
                            `. The newest reading is ${report.latestReadingDate}.`,
                    }
                    : {}),
                latestDay: latest ? describeDay(latest) : null,
                daysWithReadings: period?.entries.length ?? 0,
                totalKwh: period ? Number(period.totalKwh.toFixed(2)) : 0,
                totalBDT: period ? Number(period.totalTaka.toFixed(2)) : 0,
                avgKwhPerDay: period ? Number(period.kwhPerDay.toFixed(2)) : null,
                avgBDTPerDay: period ? Number(period.takaPerDay.toFixed(2)) : null,
                busiestDay: period?.highest && period.entries.length > 1 ? describeDay(period.highest) : null,
                quietestDay: period?.lowest && period.entries.length > 1 ? describeDay(period.lowest) : null,
                daily: period?.entries.map(describeDay) ?? [],
                displayTable:
                    period && period.entries.length > 0
                        ? registerDisplay(ctx.session, dailyTableHtml(period.entries))
                        : null,
            }, report.rows);
        },
    },

    get_recharge_history: {
        minRole: "user",
        declaration: {
            name: "get_recharge_history",
            description:
                "The user's recharge (top-up) history. Each entry shows what was paid, how much became energy " +
                "credit, and how much went to demand charge and VAT.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    days: { type: Type.NUMBER, description: "How many days back to look, up to 365." },
                },
                required: ["days"],
            },
        },
        handler: async (args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const days = Math.min(Math.max(Math.round(args?.days ?? 90), 1), 365);

            const result = await getRecharges(params, days);
            if (!result.success || !result.recharges) {
                return { error: result.error ?? "Could not reach DESCO" };
            }

            // "No recharge in the last 10 days" was a dead end. The most recent
            // one before the window tells the user what they were looking for.
            let lastBefore: { date: string; paidBDT: number } | null = null;
            if (result.recharges.length === 0 && days < 365) {
                const year = await getRecharges(params, 365);
                const newest = [...(year.recharges ?? [])].sort((a, b) => b.rechargeDate.localeCompare(a.rechargeDate))[0];
                if (newest) lastBefore = { date: newest.rechargeDate.slice(0, 10), paidBDT: newest.totalAmount };
            }

            return withFreshness({
                days,
                count: result.recharges.length,
                ...(result.recharges.length === 0
                    ? { lastRechargeBeforeThis: lastBefore ?? "none in the last year" }
                    : {}),
                recharges: result.recharges.map((r) => ({
                    date: r.rechargeDate.slice(0, 10),
                    paidBDT: r.totalAmount,
                    energyBDT: r.energyAmount,
                    chargesBDT: r.chargeAmount,
                    operator: r.rechargeOperator,
                    status: r.orderStatus,
                })),
            }, result.recharges);
        },
    },

    get_monthly_consumption: {
        minRole: "user",
        declaration: {
            name: "get_monthly_consumption",
            description:
                "Monthly electricity totals, for comparing months or spotting seasonal changes. " +
                "Returns units (kWh) and cost (BDT) per month.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    months: { type: Type.NUMBER, description: "How many months back, up to 12." },
                },
                required: ["months"],
            },
        },
        handler: async (args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const months = Math.min(Math.max(Math.round(args?.months ?? 12), 1), 12);

            const rows = await fetchMonthlyConsumption(params, months);
            if (!rows) return { error: "Could not load monthly consumption from DESCO." };

            return {
                months: rows.map((row) => ({
                    month: row.month,
                    kwh: row.consumedUnit,
                    bdt: row.consumedTaka,
                })),
            };
        },
    },

    get_account_info: {
        minRole: "user",
        declaration: {
            name: "get_account_info",
            description:
                "The registered DESCO account details: customer name, address, tariff category, " +
                "sanctioned load, feeder and meter model.",
        },
        handler: async (_args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const info = await fetchCustomerInfo(params);
            return info ?? { error: "Could not load account info from DESCO." };
        },
    },

    get_my_settings: {
        minRole: "user",
        declaration: {
            name: "get_my_settings",
            description:
                "The user's own bot settings: notification times, subscription status, and the thresholds " +
                "at which low balance alerts fire.",
        },
        handler: async (_args, ctx) => {
            const user = await UserService.getUser(ctx.userId);
            if (!user) return { error: "User not found." };

            return {
                subscribed: user.isSubscribed,
                notificationTimes: user.notificationTimes,
                lowBalanceThresholdBDT: user.threshold,
                daysLeftWarning: user.thresholdDays,
                recheckHourlyWhenLow: user.hourlyNotificationEnabled,
                accountNo: user.accountNo ?? null,
                meterNo: user.meterNo ?? null,
            };
        },
    },

    get_tariff_breakdown: {
        minRole: "user",
        declaration: {
            name: "get_tariff_breakdown",
            description:
                "How this month's electricity is being priced: consumption and cost so far, the average rate " +
                "paid per kWh, what the next kWh costs right now, what it cost at the start of the month, and " +
                "the rate bands (slabs) observed with the dates each applied, and the dates the rate stepped " +
                "up. Use for questions about slabs, rates, when the slab changed, why cost per unit changed, " +
                "or why electricity seems more expensive later in the month.",
        },
        handler: async (_args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            // The bands come entirely from the consumption readings, so the
            // balance is not consulted. Fetching it first only to read its
            // date meant a slow getBalance took this down with it, even
            // though the readings it needs were served fine.
            const { dateFrom, dateTo } = consumptionRange(todayInBillingZone(), TARIFF_WINDOW_DAYS);
            const rows = await fetchDailyConsumption(params, dateFrom, dateTo);
            if (!rows) return { error: "Could not load consumption readings from DESCO." };

            // The newest month that has a previous-month baseline. Matching
            // on today's month would find nothing on the 1st, before any
            // reading for the new month has been published.
            const curves = buildMonthCurves(rows);
            const curve = curves[curves.length - 1];
            if (!curve) {
                return { error: "Not enough readings yet this month to work out the rate bands." };
            }

            const breakdown = describeTariff(curve);
            if (!breakdown) return { error: "Could not derive the tariff for this month." };

            return {
                ...breakdown,
                note:
                    "Rates are derived from this account's own readings, not a published table. " +
                    "The band resets on the 1st of each month, so the rate rises as monthly consumption " +
                    "grows and drops again next month. Bands shown omit the transition steps where DESCO " +
                    "re-prices the month, so there may be small gaps between band ranges.",
            };
        },
    },

    // ---- Changes to the caller's own settings ----
    //
    // None of these takes a user id. Each acts on ctx.userId, which comes from
    // the Telegram update and not from anything the model or the user can
    // supply, so there is no argument through which one user could reach
    // another's settings, whatever the conversation says.

    set_notification_times: {
        minRole: "user",
        declaration: {
            name: "set_notification_times",
            description:
                "Replaces the current user's own daily balance-reminder times. Call only when the user clearly " +
                "asks to change them. The list given becomes the full set, so to move one time keep the others.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    times: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                        description: "1 to 6 times in 24-hour HH:MM, Dhaka time, e.g. [\"09:00\", \"20:00\"].",
                    },
                },
                required: ["times"],
            },
        },
        handler: async (args, ctx) => {
            const times = parseTimes(args?.times);
            if (!times) return { error: "Times must be 1 to 6 entries in 24-hour HH:MM format, e.g. 09:00." };

            const before = await UserService.getUser(ctx.userId);
            if (!before) return { error: "User not found." };

            await UserService.updateNotificationTimes(ctx.userId, times);
            await applyScheduleChange();

            return {
                ok: true,
                previousTimes: before.notificationTimes,
                newTimes: times,
                remindersActive: before.isSubscribed,
                note: before.isSubscribed ? undefined : "Reminders are currently switched off, so these times take effect once the user subscribes.",
            };
        },
    },

    set_low_balance_threshold: {
        minRole: "user",
        declaration: {
            name: "set_low_balance_threshold",
            description:
                "Sets the balance in BDT at or below which the current user gets a low-balance warning. " +
                "Call only when the user clearly asks to change it.",
            parameters: {
                type: Type.OBJECT,
                properties: { amountBDT: { type: Type.NUMBER, description: "Whole BDT amount, 0 to 100000." } },
                required: ["amountBDT"],
            },
        },
        handler: async (args, ctx) => {
            const amount = Math.round(Number(args?.amountBDT));
            if (!Number.isFinite(amount) || amount < 0 || amount > 100000) {
                return { error: "The threshold must be a number between 0 and 100000 BDT." };
            }

            const before = await UserService.getUser(ctx.userId);
            if (!before) return { error: "User not found." };

            await UserService.updateThreshold(ctx.userId, amount);
            return { ok: true, previousThresholdBDT: before.threshold, newThresholdBDT: amount };
        },
    },

    set_days_left_warning: {
        minRole: "user",
        declaration: {
            name: "set_days_left_warning",
            description:
                "Sets how many days of power left should trigger a warning for the current user. 0 switches " +
                "the days-based warning off. Call only when the user clearly asks to change it.",
            parameters: {
                type: Type.OBJECT,
                properties: { days: { type: Type.NUMBER, description: "Whole days, 0 to 60." } },
                required: ["days"],
            },
        },
        handler: async (args, ctx) => {
            const days = Math.round(Number(args?.days));
            if (!Number.isFinite(days) || days < 0 || days > 60) {
                return { error: "Days must be a number between 0 and 60." };
            }

            const before = await UserService.getUser(ctx.userId);
            if (!before) return { error: "User not found." };

            await UserService.updateThresholdDays(ctx.userId, days);
            return { ok: true, previousDays: before.thresholdDays, newDays: days };
        },
    },

    set_reminders_enabled: {
        minRole: "user",
        declaration: {
            name: "set_reminders_enabled",
            description:
                "Switches the current user's scheduled balance reminders on or off (subscribe / unsubscribe). " +
                "Call only when the user clearly asks for it.",
            parameters: {
                type: Type.OBJECT,
                properties: { enabled: { type: Type.BOOLEAN } },
                required: ["enabled"],
            },
        },
        handler: async (args, ctx) => {
            if (typeof args?.enabled !== "boolean") return { error: "enabled must be true or false." };

            const before = await UserService.getUser(ctx.userId);
            if (!before) return { error: "User not found." };
            if (args.enabled && !before.accountNo && !before.meterNo) {
                return { error: "No DESCO account saved yet. Ask the user to run /start first." };
            }

            await UserService.updateSubscription(ctx.userId, args.enabled);
            await applyScheduleChange();

            return { ok: true, wasEnabled: before.isSubscribed, nowEnabled: args.enabled, times: before.notificationTimes };
        },
    },

    set_low_balance_rechecks: {
        minRole: "user",
        declaration: {
            name: "set_low_balance_rechecks",
            description:
                "Switches on or off the hourly re-check that alerts the current user once per new reading " +
                "while their balance is low. Call only when the user clearly asks for it.",
            parameters: {
                type: Type.OBJECT,
                properties: { enabled: { type: Type.BOOLEAN } },
                required: ["enabled"],
            },
        },
        handler: async (args, ctx) => {
            if (typeof args?.enabled !== "boolean") return { error: "enabled must be true or false." };

            const before = await UserService.getUser(ctx.userId);
            if (!before) return { error: "User not found." };

            await UserService.updateHourlyNotification(ctx.userId, args.enabled);
            return { ok: true, wasEnabled: before.hourlyNotificationEnabled, nowEnabled: args.enabled };
        },
    },

    // ---- Admin only ----

    list_users: {
        minRole: "admin",
        declaration: {
            name: "list_users",
            description:
                "ADMIN ONLY. Lists people registered with this bot, with their subscription status. " +
                "Does not include DESCO account numbers or balances.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    limit: { type: Type.NUMBER, description: "Maximum users to return, up to 50." },
                },
            },
        },
        handler: async (args) => {
            const limit = Math.min(Math.max(Math.round(args?.limit ?? 20), 1), 50);
            const users = await User.find()
                .sort({ createdAt: -1 })
                .limit(limit)
                .select("telegramId username firstName isSubscribed notificationTimes createdAt blockedAt accountNo meterNo");

            return {
                users: users.map((user) => ({
                    telegramId: user.telegramId,
                    username: user.username ?? null,
                    firstName: user.firstName ?? null,
                    subscribed: user.isSubscribed,
                    notificationTimes: user.notificationTimes,
                    hasAccountConfigured: Boolean(user.accountNo || user.meterNo),
                    blocked: Boolean(user.blockedAt),
                    joined: user.createdAt?.toISOString().slice(0, 10) ?? null,
                })),
            };
        },
    },

    get_bot_stats: {
        minRole: "admin",
        declaration: {
            name: "get_bot_stats",
            description:
                "ADMIN ONLY. Aggregate figures about the bot: total users, how many are subscribed, " +
                "how many configured an account, how many blocked the bot, and active chat sessions.",
        },
        handler: async () => ({
            totalUsers: await User.countDocuments(),
            subscribed: await User.countDocuments({ isSubscribed: true }),
            configured: await User.countDocuments({
                $or: [{ accountNo: { $exists: true, $ne: null } }, { meterNo: { $exists: true, $ne: null } }],
            }),
            blocked: await User.countDocuments({ blockedAt: { $exists: true } }),
            activeChatSessions: activeSessionCount(),
        }),
    },
};

/** Tool declarations this role may see. Admins get everything. */
export function declarationsForRole(role: Role): FunctionDeclaration[] {
    return Object.values(TOOLS)
        .filter((tool) => role === "admin" || tool.minRole === "user")
        .map((tool) => tool.declaration);
}

/**
 * Runs a tool the model asked for.
 *
 * The role is re-checked here rather than relying on the tool simply not
 * having been offered. A model can hallucinate a function name, and prompt
 * text is not a security boundary, so authorisation is enforced where the
 * data is actually reached.
 */
export async function executeTool(
    name: string,
    args: unknown,
    ctx: ToolContext
): Promise<unknown> {
    const tool = TOOLS[name];
    if (!tool) return { error: `Unknown tool: ${name}` };

    if (tool.minRole === "admin" && ctx.role !== "admin") {
        console.warn(`Blocked admin tool "${name}" for non-admin user ${ctx.userId}`);
        return { error: "This information is only available to the bot administrator." };
    }

    try {
        return await tool.handler(args ?? {}, ctx);
    } catch (error: any) {
        console.error(`Tool "${name}" failed:`, error.message);
        return { error: `Could not complete that lookup: ${error.message}` };
    }
}
