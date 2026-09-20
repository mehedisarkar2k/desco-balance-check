import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { ADMIN_CHAT_ID } from "../bot";
import { getSession, resetSession } from "./session";
import { askGemini, isAiConfigured } from "./gemini";
import { Role } from "./tools";

export { isAiConfigured, resetSession };

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

        await ctx.reply(reply.text, { parse_mode: "HTML" });
    } catch (error: any) {
        console.error(`AI failed for ${userId}:`, error.message);
        await ctx.reply(
            "🤖 Sorry, I couldn't answer that just now. You can still use /balance, /usage or /recharges."
        );
    }
}
