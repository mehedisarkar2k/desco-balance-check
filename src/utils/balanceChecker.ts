import { Context } from "telegraf";
import { sendMessage, ADMIN_CHAT_ID } from "../bot";
import { getBalanceReport, formatBalanceMessage } from "./usage";
import { getOverview, formatOverviewMessage } from "./overview";

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

    const errorMessage = `
🚨 <b>${title}</b>

<b>User:</b> ${ctx.from?.first_name || "Unknown"} (@${ctx.from?.username || "no username"})
<b>User ID:</b> ${ctx.from?.id}
<b>Error:</b> ${errorMsg}

<b>Attempted URLs:</b>
${attemptedUrls?.map((url, i) => `${i + 1}. <code>${url}</code>`).join('\n') || 'No URLs attempted'}
`;
    await sendMessage(errorMessage, ADMIN_CHAT_ID);
}
