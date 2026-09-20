import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { ADMIN_CHAT_ID } from "../bot";
import { getSession, resetSession } from "./session";
import { askGemini, isAiConfigured } from "./gemini";
import { Role } from "./tools";
import { sanitizeTelegramHtml, stripTelegramHtml } from "./telegramHtml";

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

export async function handleAiMessage(ctx: Context, text: string) {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!isAiConfigured()) {
        await ctx.reply(
            "🤖 Chat isn't set up yet. Use /help to see the available commands."
        );
        return;
    }

    const user = await UserService.getUser(userId);
    const { session, isNew } = getSession(userId);

    await ctx.sendChatAction("typing");

    try {
        const reply = await askGemini(text, session, {
            userId,
            role: roleFor(userId),
            accountNo: user?.accountNo,
            meterNo: user?.meterNo,
        });

        console.log(
            `AI reply for ${userId} (${isNew ? "new" : "continuing"} session): ` +
            `tools=[${reply.toolsUsed.join(", ")}] descoCalls=${reply.apiCalls}`
        );

        await replySafely(ctx, reply.text);
    } catch (error: any) {
        console.error(`AI failed for ${userId}:`, error?.stack || error?.message || error);

        // The admin gets the real error. Debugging this blind means guessing at
        // which of the API key, model name or request shape was rejected.
        if (roleFor(userId) === "admin") {
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
