import { Type } from "@google/genai";
import type { FunctionDeclaration } from "@google/genai";
import { UserService } from "../services/UserService";
import { User } from "../models/User";
import { fetchCustomerInfo, fetchMonthlyConsumption, fetchDailyConsumption } from "../desco";
import { buildMonthCurves, describeTariff } from "../domain/tariff";
import { consumptionRange, TARIFF_WINDOW_DAYS } from "../utils/usage";
import { getBalanceReport } from "../utils/usage";
import { getOverview, getRecharges } from "../utils/overview";
import { Session, cached } from "./session";
import { activeSessionCount } from "./session";

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
                "Current DESCO prepaid balance for the user, with how many days of power it is expected to last, " +
                "the expected run-out date, and average daily consumption in kWh and BDT.",
        },
        handler: async (_args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            return await cached(ctx.session, "balance", async () => {
                const result = await getBalanceReport(params);
                if (!result.success || !result.report) {
                    return { error: result.error ?? "Could not reach DESCO" };
                }

                const { data, usage } = result.report;
                return {
                    balanceBDT: data.balance,
                    monthToDateCostBDT: data.currentMonthTaka,
                    readingDate: data.readingTime,
                    daysRemaining: usage?.daysRemaining ?? null,
                    runoutDate: usage?.runoutDate?.toISOString().slice(0, 10) ?? null,
                    avgDailyKwh: usage?.kwhPerDay ?? null,
                    avgDailyBDT: usage?.takaPerDay ?? null,
                    tariffAware: usage?.tariffAware ?? false,
                };
            });
        },
    },

    get_daily_usage: {
        minRole: "user",
        declaration: {
            name: "get_daily_usage",
            description:
                "Day-by-day electricity consumption for a recent period. Returns each day's kWh and BDT, " +
                "plus totals, averages, and the busiest and quietest day. Use for questions about usage on " +
                "particular dates or trends over days.",
            parameters: {
                type: Type.OBJECT,
                properties: {
                    days: {
                        type: Type.NUMBER,
                        description: "How many days back to report, 1 to 45. DESCO only keeps about 45 days.",
                    },
                },
                required: ["days"],
            },
        },
        handler: async (args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            const days = Math.min(Math.max(Math.round(args?.days ?? 7), 1), 45);

            return await cached(ctx.session, `usage:${days}`, async () => {
                const result = await getOverview(params, days);
                if (!result.success || !result.overview) {
                    return { error: result.error ?? "Could not reach DESCO" };
                }

                const { period } = result.overview;
                if (!period) return { error: "No consumption readings available for that range." };

                return {
                    from: period.fromDate,
                    to: period.toDate,
                    daysCovered: period.days,
                    totalKwh: period.totalKwh,
                    totalBDT: period.totalTaka,
                    avgKwhPerDay: period.kwhPerDay,
                    avgBDTPerDay: period.takaPerDay,
                    busiestDay: period.highest && { date: period.highest.date, kwh: period.highest.kwh, bdt: period.highest.taka },
                    quietestDay: period.lowest && { date: period.lowest.date, kwh: period.lowest.kwh, bdt: period.lowest.taka },
                    // Gap rows cover several days; the model must not read them as one day.
                    daily: period.entries.map((entry) => ({
                        date: entry.date,
                        kwh: Number(entry.kwh.toFixed(2)),
                        bdt: Number(entry.taka.toFixed(2)),
                        coversDays: entry.spanDays,
                    })),
                };
            });
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

            return await cached(ctx.session, `recharges:${days}`, async () => {
                const result = await getRecharges(params, days);
                if (!result.success || !result.recharges) {
                    return { error: result.error ?? "Could not reach DESCO" };
                }

                return {
                    count: result.recharges.length,
                    recharges: result.recharges.map((r) => ({
                        date: r.rechargeDate.slice(0, 10),
                        paidBDT: r.totalAmount,
                        energyBDT: r.energyAmount,
                        chargesBDT: r.chargeAmount,
                        operator: r.rechargeOperator,
                        status: r.orderStatus,
                    })),
                };
            });
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

            return await cached(ctx.session, `monthly:${months}`, async () => {
                const rows = await fetchMonthlyConsumption(params, months);
                if (!rows) return { error: "Could not load monthly consumption from DESCO." };

                return {
                    months: rows.map((row) => ({
                        month: row.month,
                        kwh: row.consumedUnit,
                        bdt: row.consumedTaka,
                    })),
                };
            });
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

            return await cached(ctx.session, "customerInfo", async () => {
                const info = await fetchCustomerInfo(params);
                return info ?? { error: "Could not load account info from DESCO." };
            });
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
                "the rate bands (slabs) observed. Use for questions about slabs, rates, why cost per unit " +
                "changed, or why electricity seems more expensive later in the month.",
        },
        handler: async (_args, ctx) => {
            const params = requireAccount(ctx);
            if (!params) return { error: "No DESCO account saved. Ask the user to run /start." };

            return await cached(ctx.session, "tariff", async () => {
                const balance = await getBalanceReport(params);
                if (!balance.success || !balance.report) {
                    return { error: balance.error ?? "Could not reach DESCO" };
                }

                const readingTime = balance.report.data.readingTime;
                const { dateFrom, dateTo } = consumptionRange(readingTime, TARIFF_WINDOW_DAYS);
                const rows = await fetchDailyConsumption(params, dateFrom, dateTo);
                if (!rows) return { error: "Could not load consumption readings from DESCO." };

                const curve = buildMonthCurves(rows).find((c) => c.month === readingTime.slice(0, 7));
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
            });
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
