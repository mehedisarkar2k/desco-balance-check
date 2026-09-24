import { Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";
import { UserService } from "../services/UserService";
import { User } from "../models/User";
import { fetchCustomerInfo, fetchMonthlyConsumption, fetchDailyConsumption } from "../desco";
import { buildMonthCurves, describeTariff } from "../domain/tariff";
import { consumptionRange, TARIFF_WINDOW_DAYS, todayInBillingZone, dailyDeltas, DailyDelta } from "../utils/usage";
import { formatBalanceMessage, getBalanceReport } from "../utils/usage";
import { dailyTableHtml, getDailyUsage, getRecharges } from "../utils/overview";
import { Session, activeSessionCount, registerDisplay } from "./session";
import { staleAsOf } from "../descoStore";
import { nowInBillingZone, shiftDate } from "../utils/dates";

export type Role = "user" | "admin";

export interface ToolContext {
    session: Session;
    userId: number;
    role: Role;
    accountNo?: string;
    meterNo?: string;
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

/** One day's usage in the shape the model is given. */
function describeDay(day: DailyDelta) {
    return {
        date: day.date,
        kwh: Number(day.kwh.toFixed(2)),
        bdt: Number(day.taka.toFixed(2)),
        // The tariff actually charged that day, so "what rate was I charged on
        // the 7th" does not leave the model to do the division, or to skip it.
        ratePerKwh: day.kwh > 0 ? Number((day.taka / day.kwh).toFixed(2)) : null,
        // Above 1 when DESCO skipped readings; the figure then covers several days.
        coversDays: day.spanDays,
    };
}

/** Bangla numerals to ASCII, so "০৯:০০" validates the same as "09:00". */
function asciiDigits(text: string): string {
    return text.replace(/[০-৯]/g, (digit) => String("০১২৩৪৫৬৭৮৯".indexOf(digit)));
}

/** Valid, de-duplicated, sorted 24-hour times, or null if any entry is malformed. */
function parseTimes(input: unknown): string[] | null {
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

/**
 * The scheduler is loaded only when a change needs it. Importing it at the top
 * would pull the Telegram client into everything that touches the tools.
 */
async function applyScheduleChange() {
    const { refreshSchedules } = await import("../scheduler");
    await refreshSchedules();
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

            const { data, usage } = result.report;
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
                avgDailyBDT: usage ? Number(usage.takaPerDay.toFixed(2)) : null,
                tariffAware: usage?.tariffAware ?? false,
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
            const { data, usage } = result.report;
            return withFreshness({
                displayMessage: registerDisplay(ctx.session, formatBalanceMessage(data, usage, "🔔 Balance Update")),
                balanceBDT: data.balance,
                balanceDate: data.readingTime,
            }, data);
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

            return withFreshness({
                count: result.recharges.length,
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
                .select("telegramId username firstName isSubscribed notificationTimes createdAt blockedAt");

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
