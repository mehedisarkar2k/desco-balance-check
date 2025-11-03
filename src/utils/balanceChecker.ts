import { Context } from "telegraf";
import { fetchBalance } from "../desco";
import { sendMessage, ADMIN_CHAT_ID } from "../bot";

export async function performBalanceCheck(
    ctx: Context,
    params: { accountNo?: string; meterNo?: string; useDefaults?: boolean }
) {
    // Validate that at least one parameter is provided when not using defaults
    if (!params.useDefaults && !params.accountNo && !params.meterNo) {
        await ctx.reply("❌ Please provide either Account Number or Meter Number.");
        return;
    }

    const result = await fetchBalance({
        accountNo: params.accountNo,
        meterNo: params.meterNo,
        useDefaults: params.useDefaults
    });

    if (result.success && result.data) {
        const { balance, currentMonthConsumption, readingTime } = result.data;
        const message = `
✅ <b>DESCO Balance</b>

💰 <b>Balance:</b> <code>${balance.toFixed(2)} BDT</code>
⚡ <b>Consumption:</b> <code>${currentMonthConsumption.toFixed(2)} kWh</code>
📅 <b>Reading Time:</b> <code>${readingTime}</code>
`;
        await ctx.reply(message, { parse_mode: "HTML" });
    } else {
        // Error occurred
        await ctx.reply(
            "❌ Something went wrong while fetching your balance.\n\n" +
            "This issue has been reported to support. Please wait while we investigate."
        );

        // Send error details to admin
        if (result.attemptedUrls && result.attemptedUrls.length > 0) {
            const errorMessage = `
🚨 <b>Balance Fetch Failed</b>

<b>User:</b> ${ctx.from?.first_name || "Unknown"} (@${ctx.from?.username || "no username"})
<b>User ID:</b> ${ctx.from?.id}
<b>Error:</b> ${result.error}

<b>Attempted URLs:</b>
${result.attemptedUrls.map((url, i) => `${i + 1}. <code>${url}</code>`).join('\n')}
`;
            await sendMessage(errorMessage, ADMIN_CHAT_ID);
        }
    }
}
