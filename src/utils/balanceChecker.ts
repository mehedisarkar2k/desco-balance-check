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

        // Validate that all required fields are present
        if (balance !== null && balance !== undefined &&
            currentMonthConsumption !== null && currentMonthConsumption !== undefined &&
            readingTime) {
            const message = `
✅ <b>DESCO Balance</b>

💰 <b>Balance:</b> <code>${balance.toFixed(2)} BDT</code>
⚡ <b>Consumption:</b> <code>${currentMonthConsumption.toFixed(2)} kWh</code>
📅 <b>Reading Time:</b> <code>${readingTime}</code>
`;
            await ctx.reply(message, { parse_mode: "HTML" });
            return;
        }
    }

    // If we reach here, either result failed or data is incomplete
    {
        // Error occurred
        const errorMsg = result.error || "Incomplete data received from API";
        console.error(`Balance check failed for user ${ctx.from?.id}:`, errorMsg);

        await ctx.reply(
            "❌ Something went wrong while fetching your balance.\n\n" +
            "This issue has been reported to support. Please wait while we investigate."
        );

        // Send error details to admin
        const errorDetails = result.data
            ? `Incomplete data: ${JSON.stringify(result.data)}`
            : errorMsg;

        const errorMessage = `
🚨 <b>Balance Fetch Failed</b>

<b>User:</b> ${ctx.from?.first_name || "Unknown"} (@${ctx.from?.username || "no username"})
<b>User ID:</b> ${ctx.from?.id}
<b>Error:</b> ${errorDetails}

<b>Attempted URLs:</b>
${result.attemptedUrls?.map((url, i) => `${i + 1}. <code>${url}</code>`).join('\n') || 'No URLs attempted'}
`;
        await sendMessage(errorMessage, ADMIN_CHAT_ID);
    }
}
