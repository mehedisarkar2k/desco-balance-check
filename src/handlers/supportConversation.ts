import { Context, Markup } from "telegraf";
import { ADMIN_CHAT_ID, bot } from "../bot";
import { ISupportTicket, SupportTicket, TicketMessage } from "../models/SupportTicket";
import { UserService } from "../services/UserService";
import { SUPPORT_THREAD_MS } from "../services/SupportTicketService";
import { answerSupport } from "../ai/supportAgent";
import { detectReplyLanguage, ReplyLanguage } from "../ai/language";
import { escalationNotice } from "../utils/supportText";

export const SUPPORT_REPLY_PREFIX = "support_reply:";
export const SUPPORT_FEEDBACK_PREFIX = "support_feedback:";
const MAX_AI_ATTEMPTS = 2;
const queues = new Map<number, Promise<unknown>>();

export function isSupportAdmin(ctx: Context): boolean {
    return ctx.from?.id === ADMIN_CHAT_ID && ctx.chat?.id === ADMIN_CHAT_ID && ctx.chat.type === "private";
}

function filter(ticket: ISupportTicket) {
    return { telegramId: ticket.telegramId, status: "open", raisedAt: ticket.raisedAt };
}

function activeUntil() { return new Date(Date.now() + SUPPORT_THREAD_MS); }

function storedMessage(role: TicketMessage["role"], text: string): TicketMessage {
    return { role, text: text.replace(/\b\d{6}\b/g, "[6-digit code omitted]").slice(0, 3500) };
}

async function append(ticket: ISupportTicket, role: TicketMessage["role"], text: string) {
    await SupportTicket.updateOne(filter(ticket), {
        $push: { messages: { $each: [storedMessage(role, text)], $slice: -24 } },
    });
}

export function supportFeedbackButtons(ticket: ISupportTicket, language: ReplyLanguage, answered = false) {
    const key = `${ticket.telegramId}:${ticket.raisedAt.getTime()}`;
    return Markup.inlineKeyboard([
        ...(answered ? [[Markup.button.callback(language === "bn" ? "✅ সমাধান হয়েছে" : "✅ Solved", `${SUPPORT_FEEDBACK_PREFIX}${key}:resolved`)]] : []),
        [Markup.button.callback(language === "bn" ? "🙋 অ্যাডমিনের সাহায্য চাই" : "🙋 Ask the admin", `${SUPPORT_FEEDBACK_PREFIX}${key}:admin`)],
    ]);
}

export async function registerAdminMessage(ticket: ISupportTicket, messageId: number) {
    await SupportTicket.updateOne(filter(ticket), {
        $push: { adminMessageIds: { $each: [messageId], $slice: -40 } },
    });
}

/** Delivery goes to the admin's private chat; replies are matched using stored Telegram message IDs. */
export async function notifySupportAdmin(ticket: ISupportTicket, heading: string, sharedCode?: string): Promise<boolean> {
    const user = await UserService.getUser(ticket.telegramId);
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || "User";
    const conversation = ticket.messages.slice(-4).map((m) => `${m.role}: ${m.text.slice(0, 550)}`).join("\n\n");
    const text = `${heading}\n${name} — ID ${ticket.telegramId}\n\n` +
        `Issue: ${(ticket.summary || ticket.issue || "Details requested").slice(0, 700)}\n` +
        (ticket.escalationReason ? `Why you are needed: ${ticket.escalationReason.slice(0, 500)}\n` : "") +
        `AI attempts: ${ticket.aiAttempts ?? 0}\n\n${conversation}\n\n` +
        (sharedCode ? `The user explicitly shared their support code: /actas ${sharedCode}\n\n` : "") +
        `Reply to this message to answer through the bot, or use /reply ${ticket.telegramId} your message.\n/ticket ${ticket.telegramId}`;
    try {
        const message = await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, Markup.inlineKeyboard([
            [Markup.button.callback("💬 Reply through bot", `${SUPPORT_REPLY_PREFIX}${ticket.telegramId}:${ticket.raisedAt.getTime()}`)],
        ]));
        try { await registerAdminMessage(ticket, message.message_id); }
        catch { console.error("Could not save the support reply mapping; /reply is still available."); }
        return true;
    } catch {
        console.error(`Support notification failed for ticket ${ticket.telegramId}`);
        return false;
    }
}

export async function escalateSupport(ctx: Context, ticket: ISupportTicket, language: ReplyLanguage, summary: string, reason: string, sharedCode?: string) {
    const updated = await SupportTicket.findOneAndUpdate({ ...filter(ticket), ...(ticket.stage ? { stage: ticket.stage } : {}) }, {
        $set: { stage: "admin", escalatedAt: new Date(), activeUntil: activeUntil(), summary, escalationReason: reason },
    }, { new: true });
    if (!updated) return;
    const delivered = await notifySupportAdmin(updated, "🆘 Support needs your help", sharedCode);
    if (delivered) await SupportTicket.updateOne(filter(updated), { $set: { adminNotifiedAt: new Date() } });
    const notice = escalationNotice(language, delivered);
    await ctx.reply(notice);
    await append(updated, "bot", notice);
}

async function processSupportMessage(ctx: Context, text: string): Promise<boolean> {
    const id = ctx.from?.id;
    if (!id || id === ADMIN_CHAT_ID || ctx.chat?.type !== "private" || ctx.chat.id !== id || text.startsWith("/")) return false;
    const ticket = await SupportTicket.findOne({ telegramId: id, status: "open", activeUntil: { $gt: new Date() } }).lean();
    if (!ticket) return false;
    if (text.length > 3500) {
        await ctx.reply("Please send the details in shorter messages (up to 3500 characters each).");
        return true;
    }
    const messageId = ctx.message?.message_id;
    if (!messageId) return false;
    // A redelivered Telegram update must not make the AI answer or the admin receive it twice.
    const updated = await SupportTicket.findOneAndUpdate({
        ...filter(ticket), $or: [{ lastUserMessageId: { $lt: messageId } }, { lastUserMessageId: { $exists: false } }],
    }, {
        $set: { activeUntil: activeUntil(), lastUserMessageId: messageId, ...(ticket.issue ? {} : { issue: text.slice(0, 1000) }) },
        $push: { messages: { $each: [storedMessage("user", text)], $slice: -24 } },
    }, { new: true });
    if (!updated) return true;
    const user = await UserService.getUser(id);
    const language = detectReplyLanguage(text) ?? user?.language ?? "en";
    if (/^\d{6}$/.test(text.trim()) && text.trim() === user?.supportCode) {
        if (!user.supportCodeExpiresAt || user.supportCodeExpiresAt <= new Date()) {
            await ctx.reply(language === "bn" ? "কোডটির মেয়াদ শেষ হয়েছে। নতুন কোডের জন্য /support দিন।" : "That support code expired. Send /support for a new one.");
            return true;
        }
        await escalateSupport(ctx, updated, language, updated.summary || updated.issue,
            "The user shared their code to authorize account help.", text.trim());
        return true;
    }
    if (updated.stage === "admin") {
        const delivered = await notifySupportAdmin(updated, "💬 New reply on a support ticket");
        await ctx.reply(delivered
            ? (language === "bn" ? "আপনার মেসেজ অ্যাডমিনকে পাঠিয়েছি। তিনি এখানেই উত্তর দেবেন।" : "Your message has been sent to the admin. They will reply here.")
            : escalationNotice(language, false));
        return true;
    }
    if ((updated.aiAttempts ?? 0) >= MAX_AI_ATTEMPTS) {
        await escalateSupport(ctx, updated, language, updated.summary || updated.issue, "The issue remains open after two AI support attempts.");
        return true;
    }
    await ctx.sendChatAction("typing");
    const claimed = await SupportTicket.updateOne({ ...filter(updated), ...(updated.stage ? { stage: updated.stage } : {}) }, {
        $inc: { aiAttempts: 1 }, $set: { stage: "ai" },
    });
    if (!claimed.matchedCount) {
        const current = await SupportTicket.findOne(filter(updated)).lean();
        if (current?.stage === "admin") {
            const delivered = await notifySupportAdmin(current, "💬 New reply on a support ticket");
            await ctx.reply(delivered
                ? (language === "bn" ? "আপনার মেসেজ অ্যাডমিনকে পাঠিয়েছি।" : "Your message has been sent to the admin.")
                : escalationNotice(language, false));
        }
        return true;
    }
    updated.aiAttempts = (updated.aiAttempts ?? 0) + 1;
    updated.stage = "ai";
    // The latest message is passed separately; preserve only the earlier transcript as history.
    const decision = await answerSupport({ ...updated.toObject(), messages: updated.messages.slice(0, -1) }, user, text, language);
    if (decision.action === "escalate") {
        await escalateSupport(ctx, updated, language, decision.summary,
            decision.reason + (decision.toolsUsed?.length ? ` Lookups tried: ${decision.toolsUsed.join(", ")}.` : ""));
        return true;
    }
    const stage = decision.action === "answer" ? "awaiting_feedback" : "awaiting_details";
    const saved = await SupportTicket.updateOne({ ...filter(updated), stage: "ai" }, {
        $set: { stage, summary: decision.summary },
        $push: { messages: { $each: [storedMessage("bot", decision.reply)], $slice: -24 } },
    });
    if (!saved.modifiedCount) return true; // An admin took over or the ticket closed during diagnosis.
    await ctx.reply(decision.reply, supportFeedbackButtons(updated, language, decision.action === "answer"));
    if (decision.action === "answer") await ctx.reply(language === "bn"
        ? "এতে সমস্যার সমাধান হয়েছে? না হলে বিস্তারিত লিখুন বা অ্যাডমিনের সাহায্য চান।"
        : "Did this solve it? If not, add details here or ask the admin.");
    return true;
}

export async function handleSupportConversation(ctx: Context, text: string): Promise<boolean> {
    const id = ctx.from?.id;
    if (!id || id === ADMIN_CHAT_ID) return false;
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => processSupportMessage(ctx, text));
    queues.set(id, next);
    try { return await next; }
    finally { if (queues.get(id) === next) queues.delete(id); }
}

export async function handleSupportFeedback(ctx: Context, data: string) {
    if (ctx.chat?.type !== "private" || ctx.chat.id !== ctx.from?.id) return;
    const [id, version, action] = data.slice(SUPPORT_FEEDBACK_PREFIX.length).split(":");
    if (!/^\d+$/.test(id) || !/^\d+$/.test(version) || Number(id) !== ctx.from.id) return;
    const ticket = await SupportTicket.findOne({ telegramId: Number(id), status: "open", raisedAt: new Date(Number(version)) }).lean();
    if (!ticket) { await ctx.reply("This support request has closed or changed. Send /support to open it again."); return; }
    const user = await UserService.getUser(ticket.telegramId);
    const language = user?.language ?? "en";
    if (action === "resolved") {
        await SupportTicket.updateOne(filter(ticket), { $set: { status: "resolved", resolvedAt: new Date() }, $unset: { activeUntil: 1 } });
        await ctx.reply(language === "bn" ? "✅ টিকিট বন্ধ করেছি। আবার সাহায্য লাগলে /support দিন।" : "✅ Ticket closed. Send /support whenever you need help again.");
    } else if (action === "admin") {
        if (ticket.stage === "admin" && ticket.adminNotifiedAt) {
            await ctx.reply(escalationNotice(language, true));
            return;
        }
        await escalateSupport(ctx, ticket, language, ticket.summary || ticket.issue, "The customer asked for human help.");
    }
}

export async function pauseSupportConversation(ctx: Context) {
    if (ctx.chat?.type !== "private" || ctx.from?.id === ADMIN_CHAT_ID) return;
    await SupportTicket.updateOne({ telegramId: ctx.from?.id, status: "open" }, { $unset: { activeUntil: 1 } });
}

async function sendAdminReply(ctx: Context, ticket: ISupportTicket, text: string) {
    const body = text.trim();
    if (!body || body.length > 3000) { await ctx.reply("Write a reply between 1 and 3000 characters."); return; }
    const messageId = ctx.message?.message_id;
    if (!messageId) return;
    const claimed = await SupportTicket.updateOne({
        ...filter(ticket), $or: [{ lastAdminMessageId: { $lt: messageId } }, { lastAdminMessageId: { $exists: false } }],
    }, { $set: { stage: "admin", activeUntil: activeUntil(), lastAdminMessageId: messageId } });
    if (!claimed.matchedCount) { await ctx.reply("This ticket has closed or this reply was already handled."); return; }
    const user = await UserService.getUser(ticket.telegramId);
    const heading = user?.language === "bn" ? "💬 সাপোর্ট টিম" : "💬 Support team";
    try {
        await bot.telegram.sendMessage(ticket.telegramId, `${heading}\n\n${body}`);
    } catch {
        await ctx.reply("❌ Your reply could not be delivered. The user may have blocked the bot. Nothing was marked as sent.");
        return;
    }
    await append(ticket, "admin", body);
    await ctx.reply(`✅ Reply sent through the bot to ID ${ticket.telegramId}. Their replies will come back here.`);
}

export async function handleSupportReplyCommand(ctx: Context) {
    if (!isSupportAdmin(ctx)) return;
    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const match = /^\/reply(?:@\w+)?\s+(\d+)\s+([\s\S]+)$/.exec(text);
    if (!match || !Number.isSafeInteger(Number(match[1]))) { await ctx.reply("Use /reply <Telegram ID> <message> to reply through the bot."); return; }
    const ticket = await SupportTicket.findOne({ telegramId: Number(match[1]), status: "open" }).lean();
    if (!ticket) { await ctx.reply("No open support ticket for that user."); return; }
    await sendAdminReply(ctx, ticket, match[2]);
}

/** Only genuine replies to stored support messages are relayed; arbitrary admin chat stays normal. */
export async function handleAdminSupportReply(ctx: Context, text: string): Promise<boolean> {
    if (!isSupportAdmin(ctx) || text.startsWith("/")) return false;
    const repliedTo = ctx.message && "reply_to_message" in ctx.message ? ctx.message.reply_to_message?.message_id : undefined;
    if (!repliedTo) return false;
    const ticket = await SupportTicket.findOne({ adminMessageIds: repliedTo }).lean();
    if (!ticket) {
        const reply = ctx.message && "reply_to_message" in ctx.message ? ctx.message.reply_to_message : undefined;
        if (reply && "text" in reply && /Reply to this message to (answer through|send to)|\/reply \d+ your message/.test(reply.text)) {
            await ctx.reply("That support reply link is no longer active. Open the ticket again with /ticket.");
            return true;
        }
        return false;
    }
    if (ticket.status !== "open") { await ctx.reply("That support ticket is closed. Open a current ticket before replying."); return true; }
    await sendAdminReply(ctx, ticket, text);
    return true;
}

export async function handleSupportReplyButton(ctx: Context, data: string) {
    if (!isSupportAdmin(ctx)) return;
    const [id, version] = data.slice(SUPPORT_REPLY_PREFIX.length).split(":");
    if (!/^\d+$/.test(id) || !/^\d+$/.test(version)) return;
    const ticket = await SupportTicket.findOne({ telegramId: Number(id), status: "open", raisedAt: new Date(Number(version)) }).lean();
    if (!ticket) { await ctx.reply("This ticket has closed or changed. Open it again with /ticket."); return; }
    const prompt = await ctx.reply(`Reply to this message to send to ID ${id} through the bot. /cancel to stop.`, {
        reply_markup: { force_reply: true, selective: true },
    });
    await registerAdminMessage(ticket, prompt.message_id);
}
