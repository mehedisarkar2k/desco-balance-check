import { Context } from "telegraf";
import { sendMessage, ADMIN_CHAT_ID } from "../bot";
import { getBalanceReport, formatBalanceMessage } from "./usage";
import {
    getOverview,
    formatOverviewMessage,
    getRecharges,
    formatRechargeHistoryMessage,
} from "./overview";

export async function performBalanceCheck(
    ctx: Context,
    params: { accountNo?: string; meterNo?: string }
) {
    if (!params.accountNo && !params.meterNo) {
        await ctx.reply("❌ Please provide either Account Number or Meter Number.");
        return;
    }

    const result = await getBalanceReport({
        accountNo: params.accountNo,
        meterNo: params.meterNo
    });

    if (result.success && result.report) {
        const { data, usage } = result.report;
        await ctx.reply(
            formatBalanceMessage(data, usage, "✅ DESCO Balance"),
            { parse_mode: "HTML" }
        );
        return;
    }

    await reportFailure(ctx, "Balance Fetch Failed", result.error, result.attemptedUrls);
}

export async function performOverview(
    ctx: Context,
    params: { accountNo?: string; meterNo?: string },
    days: number
) {
    if (!params.accountNo && !params.meterNo) {
        await ctx.reply("❌ Please provide either Account Number or Meter Number.");
        return;
    }

    const result = await getOverview(
        { accountNo: params.accountNo, meterNo: params.meterNo },
        days
    );

    if (result.success && result.overview) {
        await ctx.reply(formatOverviewMessage(result.overview), { parse_mode: "HTML" });
        return;
    }

    await reportFailure(ctx, "Overview Fetch Failed", result.error, result.attemptedUrls);
}

export async function performRechargeHistory(
    ctx: Context,
    params: { accountNo?: string; meterNo?: string },
    days: number
) {
    if (!params.accountNo && !params.meterNo) {
        await ctx.reply("❌ Please provide either Account Number or Meter Number.");
        return;
    }

    const result = await getRecharges(params, days);

    if (result.success && result.recharges) {
        await ctx.reply(formatRechargeHistoryMessage(result.recharges, days), { parse_mode: "HTML" });
        return;
    }

    await reportFailure(ctx, "Recharge History Fetch Failed", result.error);
}

/** Tells the user something went wrong and forwards the detail to the admin. */
async function reportFailure(
    ctx: Context,
    title: string,
    error?: string,
    attemptedUrls?: string[]
) {
    const errorMsg = error || "Incomplete data received from API";
    console.error(`${title} for user ${ctx.from?.id}:`, errorMsg);

    await ctx.reply(
        "❌ Something went wrong while fetching your data.\n\n" +
        "This issue has been reported to support. Please wait while we investigate."
    );

    // Only shown when there is something to show. A bare "No URLs attempted"
    // reads like the bot never tried, when the caller simply does not collect
    // URLs, and that sent the last investigation down the wrong path.
    const urlSection = attemptedUrls?.length
        ? `\n\n<b>Attempted URLs:</b>\n${attemptedUrls.map((url, i) => `${i + 1}. <code>${url}</code>`).join("\n")}`
        : "";

    const errorMessage = `
🚨 <b>${title}</b>

<b>User:</b> ${ctx.from?.first_name || "Unknown"} (@${ctx.from?.username || "no username"})
<b>User ID:</b> ${ctx.from?.id}
<b>Error:</b> ${errorMsg}${urlSection}
`;
    await sendMessage(errorMessage, ADMIN_CHAT_ID);
}
