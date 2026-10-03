import { Context, Markup } from "telegraf";
import { ADMIN_CHAT_ID } from "../bot";
import { SupportTicket } from "../models/SupportTicket";
import { UserService } from "../services/UserService";
import { recoverLegacyTickets } from "../services/SupportTicketService";
import { describeUser } from "../services/SupportService";
import { escapeHtml, maskNumber } from "../utils/html";
import { getBalanceReport } from "../utils/usage";
import { formatBalanceMessage } from "../utils/balanceCard";
import { SUPPORT_REPLY_PREFIX } from "./supportConversation";

export const TICKET_VIEW_PREFIX = "ticket_view:";
export const TICKET_BALANCE_PREFIX = "ticket_balance:";
export const TICKET_RESOLVE_PREFIX = "ticket_resolve:";
const PAGE_SIZE = 10;

function isAdminChat(ctx: Context): boolean {
    return ctx.from?.id === ADMIN_CHAT_ID && ctx.chat?.id === ADMIN_CHAT_ID && ctx.chat.type === "private";
}

function argument(ctx: Context): string {
    return ctx.message && "text" in ctx.message ? ctx.message.text.split(/\s+/)[1] ?? "" : "";
}

function userId(value: string): number | null {
    const id = /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function handleTickets(ctx: Context) {
    if (!isAdminChat(ctx)) return;
    const rawPage = argument(ctx);
    const page = rawPage ? userId(rawPage) : 1;
    if (!page || page > 10000) {
        await ctx.reply("Use /tickets or /tickets 2 for the next page.");
        return;
    }
    await recoverLegacyTickets();
    const tickets = await SupportTicket.find({ status: "open", telegramId: { $ne: ADMIN_CHAT_ID } })
        .sort({ raisedAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE + 1).lean();
    if (!tickets.length) {
        await ctx.reply(page === 1 ? "No open support tickets." : "No tickets on this page. /tickets for the first page.");
        return;
    }
    const lines = [`🆘 <b>Open support tickets — page ${page}</b>`];
    for (const ticket of tickets.slice(0, PAGE_SIZE)) {
        const user = await UserService.getUser(ticket.telegramId);
        lines.push(`\n${user ? describeUser(user) : `ID ${ticket.telegramId}`}\n` +
            `${escapeHtml((ticket.issue || ticket.messages.filter((m) => m.role === "user").slice(-1)[0]?.text || "No issue description").slice(0, 120))}\n` +
            `<code>/ticket ${ticket.telegramId}</code>`);
    }
    if (tickets.length > PAGE_SIZE) lines.push(`\nNext: /tickets ${page + 1}`);
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

export async function handleTicket(ctx: Context, value = argument(ctx)) {
    if (!isAdminChat(ctx)) return;
    const id = userId(value);
    if (!id) { await ctx.reply("Use /ticket followed by the user's Telegram ID from /tickets."); return; }
    await recoverLegacyTickets();
    const ticket = await SupportTicket.findOne({ telegramId: id }).lean();
    const user = ticket ? await UserService.getUser(id) : null;
    if (!ticket || !user) { await ctx.reply("No support ticket found for that user."); return; }
    const raised = ticket.raisedAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" });
    await ctx.reply(
        `🆘 <b>Support ticket — ${ticket.status}</b>\n${describeUser(user)}\nRaised: ${raised} (Dhaka)\n\n` +
        `Issue: ${escapeHtml(ticket.issue || "No description provided; see recent conversation below.")}\n\n` +
        `Support: ${ticket.stage ?? "legacy"}; AI attempts: ${ticket.aiAttempts ?? 0}\n` +
        (ticket.summary ? `Summary: ${escapeHtml(ticket.summary)}\n` : "") +
        (ticket.escalationReason ? `Escalation: ${escapeHtml(ticket.escalationReason)}\n\n` : "") +
        `Account: ${escapeHtml(maskNumber(user.accountNo))}; meter: ${escapeHtml(maskNumber(user.meterNo))}\n` +
        `Reminders: ${user.isSubscribed ? "on" : "off"}; ${escapeHtml(user.notificationTimes.join(", "))}\n` +
        `Low balance: ${user.threshold ?? 100} BDT / ${user.thresholdDays ?? 3} days\n\n` +
        "Review is read-only. Account changes still require /actas with the user's support code; /done ends that session.",
        { parse_mode: "HTML" }
    );
    if (!ticket.messages.length) {
        await ctx.reply("No recent conversation was available when this ticket was raised. Earlier alerts did not store conversations.");
    } else {
        // Each transcript message stays below Telegram's length limit.
        for (const message of ticket.messages) {
            await ctx.reply(`<b>${message.role === "user" ? "User" : message.role === "admin" ? "Support team" : "Bot"}:</b>\n${escapeHtml(message.text)}`, { parse_mode: "HTML" });
        }
    }
    const buttons = [[Markup.button.callback("🔋 Inspect balance", `${TICKET_BALANCE_PREFIX}${id}`)]];
    if (ticket.status === "open") {
        buttons.push([Markup.button.callback("💬 Reply through bot", `${SUPPORT_REPLY_PREFIX}${id}:${ticket.raisedAt.getTime()}`)]);
        buttons.push([Markup.button.callback("✅ Mark resolved", `${TICKET_RESOLVE_PREFIX}${id}:${ticket.raisedAt.getTime()}`)]);
    }
    await ctx.reply("Ticket actions (your active account is unchanged):", { ...Markup.inlineKeyboard(buttons) });
}

export async function handleTicketCallback(ctx: Context, data: string) {
    if (!isAdminChat(ctx)) return;
    if (data.startsWith(TICKET_VIEW_PREFIX)) {
        await handleTicket(ctx, data.slice(TICKET_VIEW_PREFIX.length));
        return;
    }
    const resolving = data.startsWith(TICKET_RESOLVE_PREFIX);
    const prefix = resolving ? TICKET_RESOLVE_PREFIX : TICKET_BALANCE_PREFIX;
    if (!data.startsWith(prefix)) return;
    const [idText, version] = data.slice(prefix.length).split(":");
    const id = userId(idText);
    if (!id) return;
    if (resolving) {
        if (!version || !/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) return;
        const result = await SupportTicket.updateOne(
            { telegramId: id, status: "open", raisedAt: new Date(Number(version)) },
            { $set: { status: "resolved", resolvedAt: new Date() } }
        );
        await ctx.reply(result.modifiedCount ? `✅ Ticket for ID ${id} marked resolved.` : "That ticket was already resolved or updated. Open it again with /ticket.");
        return;
    }
    const ticket = await SupportTicket.exists({ telegramId: id });
    const user = ticket ? await UserService.getUser(id) : null;
    if (!user || (!user.accountNo && !user.meterNo)) { await ctx.reply("No saved DESCO account for this ticket."); return; }
    const result = await getBalanceReport({ accountNo: user.accountNo, meterNo: user.meterNo });
    if (!result.success || !result.report) { await ctx.reply("Could not load this ticket's balance. Try again shortly."); return; }
    const { data: balance, usage, pending } = result.report;
    await ctx.reply(`Read-only balance for ID ${id}:`);
    await ctx.reply(formatBalanceMessage(balance, usage, {
        language: "en", thresholdTaka: user.threshold ?? 100, thresholdDays: user.thresholdDays ?? 3,
    }, undefined, pending), { parse_mode: "HTML" });
}
