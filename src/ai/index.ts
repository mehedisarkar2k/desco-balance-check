import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { ADMIN_CHAT_ID } from "../bot";
import { getSession, resetSession } from "./session";
import { askGemini, isAiConfigured } from "./gemini";
import { Role } from "./tools";
import { sanitizeTelegramHtml, stripTelegramHtml } from "./telegramHtml";
import { detectReplyLanguage } from "./language";
import { countDescoCalls } from "../desco";
import { userIdOf } from "../services/SupportService";
import { performBalanceCheck } from "../utils/balanceChecker";

export { isAiConfigured, resetSession };

/**
 * Sends a model reply, falling back to plain text if Telegram still refuses
 * the markup. Losing an answer the model already produced -- and the DESCO
 * calls behind it -- over a formatting fault is the worse outcome.
 */
async function replySafely(ctx: Context, text: string) {
    try {
        await ctx.reply(sanitizeTelegramHtml(text), { parse_mode: "HTML" });
    } catch (error: any) {
        if (!/parse entities|can't parse/i.test(error?.message ?? "")) throw error;

        console.warn("Telegram rejected sanitized HTML, retrying as plain text:", error.message);
        await ctx.reply(stripTelegramHtml(text));
    }
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The admin is identified by chat id rather than anything the user can set,
 * so no profile field or message content can grant it.
 */
export function roleFor(userId: number): Role {
    return userId === ADMIN_CHAT_ID ? "admin" : "user";
}

/**
 * "balance", "balance koto?", "koto taka ache", "ব্যালেন্স কত". Answered with
 * the card directly: through the model it now and then came back empty and
 * the user got "sorry, I didn't understand" for the most common question.
 */
const PLAIN_BALANCE_REQUEST =
    /^((my|amar|what'?s my|what is my)\s+)?(current\s+)?(balance|ব্যালেন্স)(\s+(koto|kot|check|dekhao|dekhaw|dekhan|dao|daw|koto ache|please|pls|now|কত|দেখাও))?$|^koto taka (ache|baki)$|^কত টাকা (আছে|বাকি)$/;

function isPlainBalanceRequest(text: string): boolean {
    return PLAIN_BALANCE_REQUEST.test(text.toLowerCase().replace(/[?!.।]/g, "").trim().replace(/\s+/g, " "));
}

export async function handleAiMessage(ctx: Context, text: string) {
    // The account answered about is the one acted on; the conversation stays
    // with the sender, so the admin's chat never lands in a user's history.
    const senderId = ctx.from?.id;
    const userId = userIdOf(ctx);
    if (!senderId || !userId) return;

    if (!isAiConfigured()) {
        await ctx.reply(
            "🤖 Chat isn't set up yet. Use /help to see the available commands."
        );
        return;
    }

    const user = await UserService.getUser(userId);
    const { session, isNew } = getSession(senderId);

    await ctx.sendChatAction("typing");

    const detected = detectReplyLanguage(text);
    const language = detected ?? session.language;
    session.language = language;

    // The user's next guided flow greets them in this language, so it is worth
    // saving as soon as the message carries a signal.
    if (user && detected && detected !== user.language) {
        await UserService.updateLanguage(userId, detected);
    }

    if (isPlainBalanceRequest(text) && (user?.accountNo || user?.meterNo)) {
        await performBalanceCheck(ctx, { accountNo: user.accountNo, meterNo: user.meterNo });
        return;
    }

    try {
        // Counts requests that actually went to DESCO, not lookups: most are
        // now answered from the saved copy, and the old count of lookups read
        // as DESCO traffic that never happened.
        const { result: reply, calls } = await countDescoCalls(() =>
            askGemini(text, session, {
                userId,
                role: roleFor(userId),
                accountNo: user?.accountNo,
                meterNo: user?.meterNo,
            }, language)
        );

        console.log(
            `AI reply for ${userId} (${isNew ? "new" : "continuing"} session, ${language}): ` +
            `tools=[${reply.toolsUsed.join(", ")}] descoCalls=${calls}`
        );

        await replySafely(ctx, reply.text);
    } catch (error: any) {
        console.error(`AI failed for ${userId}:`, error?.stack || error?.message || error);

        // The admin gets the real error. Debugging this blind means guessing at
        // which of the API key, model name or request shape was rejected.
        if (roleFor(senderId) === "admin") {
            const detail = String(error?.message || error).slice(0, 600);
            await ctx.reply(
                `🤖 <b>AI request failed</b>\n\n<code>${escapeHtml(detail)}</code>`,
                { parse_mode: "HTML" }
            );
            return;
        }

        await ctx.reply(
            "🤖 Sorry, I couldn't answer that just now. You can still use /balance, /usage or /recharges."
        );
    }
}
