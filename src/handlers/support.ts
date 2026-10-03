import { Context, Markup } from "telegraf";
import { UserService } from "../services/UserService";
import {
    ADMIN_REMOVE_PREFIX,
    REMOVED_MESSAGE,
    actingFor,
    describeUser,
    issueSupportCode,
    startActing,
    stopActing,
    userIdOf,
} from "../services/SupportService";
import { ADMIN_CHAT_ID, sendMessage } from "../bot";
import { resetSession } from "../ai/session";
import { refreshSchedules } from "../scheduler";
import { userSessions } from "./commands";
import { deleteSnapshotsFor } from "../descoStore";
import { User } from "../models/User";
import { SupportTicket } from "../models/SupportTicket";
import { raiseSupportTicket } from "../services/SupportTicketService";
import { detectReplyLanguage } from "../ai/language";
import { supportIntake } from "../utils/supportText";
import { handleSupportConversation, notifySupportAdmin, supportFeedbackButtons } from "./supportConversation";

/** Callback data for confirming /leave; the account id follows it. */
export const LEAVE_CONFIRM_PREFIX = "leave_confirm:";

const timeInDhaka = (date: Date) =>
    date.toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });

export async function handleSupport(ctx: Context) {
    // The sender's own account, even for the admin while acting: the code
    // is consent from the person holding it.
    const senderId = ctx.from?.id;
    if (!senderId) return;
    if (ctx.chat?.type !== "private") {
        await ctx.reply("Please send /support in a private chat with this bot.");
        return;
    }

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const issue = text.replace(/^\/support(?:@\w+)?\s*/i, "").trim();
    const ticket = await raiseSupportTicket(senderId, issue);
    const code = await issueSupportCode(senderId);

    const user = await UserService.getUser(senderId);
    const language = detectReplyLanguage(issue) ?? user?.language ?? "en";
    const consent = language === "bn"
        ? `অ্যাকাউন্টের সেটিংস বদলানোর অনুমতি চাইলে তবেই এই কোডটি এখানে পাঠাবেন: ${code} (15 মিনিটের জন্য)। অ্যাডমিন সর্বোচ্চ 1 ঘণ্টা অ্যাকাউন্টে সাহায্য করতে পারবেন।`
        : `Only if the admin asks for permission to change your account settings, send this code here: ${code} (valid for 15 minutes). Access lasts up to 1 hour.`;
    await ctx.reply((issue
        ? (language === "bn" ? "🆘 আপনার সমস্যাটি পেয়েছি। AI সহকারী দেখে সাহায্যের চেষ্টা করছে। অ্যাডমিন এই সাপোর্ট কথোপকথন দেখতে পারবেন। /cancel দিয়ে সাধারণ চ্যাটে ফিরতে পারেন।" : "🆘 Your issue is saved. The AI assistant will try to help now. The admin can review this support conversation. Use /cancel to return to normal chat.")
        : supportIntake(language)) + "\n\n" + consent, supportFeedbackButtons(ticket, language));

    if (senderId !== ADMIN_CHAT_ID && user) {
        const delivered = await notifySupportAdmin(ticket, "🆘 New support request");
        if (!delivered) await ctx.reply("Your ticket is saved, but the admin notification could not be delivered. You can continue describing the issue here.");
    }
    if (issue && senderId !== ADMIN_CHAT_ID) await handleSupportConversation(ctx, issue);
}

export async function handleActAs(ctx: Context) {
    if (ctx.from?.id !== ADMIN_CHAT_ID || ctx.chat?.id !== ADMIN_CHAT_ID || ctx.chat.type !== "private") return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const code = text.split(/\s+/)[1]?.trim() ?? "";

    if (!code) {
        const current = actingFor();
        await ctx.reply(
            current
                ? `🛠 Acting for ID <code>${current.userId}</code> until ${timeInDhaka(current.until)}. /done to stop.`
                : "Review raised support requests with /tickets or /ticket followed by their Telegram ID. " +
                  "To change their account, send /actas followed by their 6-digit support code.",
            { parse_mode: "HTML" }
        );
        return;
    }

    if (!/^\d{6}$/.test(code)) {
        await ctx.reply("❌ A support code is 6 digits.");
        return;
    }

    const user = await startActing(code);
    if (!user) {
        await ctx.reply("❌ That code is wrong, already used or expired. Ask them to send /support for a new one.");
        return;
    }

    await ctx.reply(
        `🛠 <b>Now acting for</b> ${describeUser(user)}.\n\n` +
        "Commands and chat now apply to their account: /me, /balance, /update, /subscribe, /leave. " +
        `Ends with /done, or at ${timeInDhaka(actingFor()!.until)}.`,
        { parse_mode: "HTML" }
    );
}

export async function handleDone(ctx: Context) {
    if (ctx.from?.id !== ADMIN_CHAT_ID) return;

    const current = actingFor();
    if (!current) {
        await ctx.reply("You're not acting for anyone.");
        return;
    }

    await stopActing("done");
    await ctx.reply(`✅ Stopped acting for ID ${current.userId}. You're back on your own account.`);
}

export async function handleLeave(ctx: Context) {
    const userId = userIdOf(ctx);
    if (!userId) return;

    const forSomeoneElse = userId !== ctx.from?.id;
    const user = await UserService.getUser(userId);
    const question = forSomeoneElse && user
        ? `Remove ${describeUser(user)} from the bot? Their saved details and settings are deleted, ` +
          "and they get no more messages. They'll be told."
        : "Leave this bot? Your saved DESCO details and settings are deleted, and you get no more " +
          "messages. You can come back any time with /start.";

    // The id travels with the button: pressed after acting has ended, the
    // button must not fall back to the admin's own account.
    await ctx.reply(question, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
            [Markup.button.callback("🗑 Yes, remove", `${LEAVE_CONFIRM_PREFIX}${userId}`)],
            [Markup.button.callback("❌ Cancel", "cancel")],
        ]),
    });
}

/** Deletes a user and everything the bot keeps for them. */
async function removeUser(userId: number): Promise<void> {
    const user = await UserService.getUser(userId);
    await UserService.deleteUser(userId);
    await SupportTicket.deleteMany({ telegramId: userId });
    userSessions.delete(userId);
    resetSession(userId);

    // Saved DESCO copies are per account, and a family often shares one; they
    // go only when nobody else in the bot still uses the account.
    const hasAccount = Boolean(user?.accountNo || user?.meterNo);
    if (user && hasAccount && !(await User.exists({ accountNo: user.accountNo, meterNo: user.meterNo }))) {
        await deleteSnapshotsFor(user.accountNo, user.meterNo);
    }
    await refreshSchedules();
}

export async function handleLeaveConfirm(ctx: Context, data: string) {
    const userId = userIdOf(ctx);
    const confirmedFor = Number(data.slice(LEAVE_CONFIRM_PREFIX.length));
    if (!userId || confirmedFor !== userId) {
        await ctx.reply("This button is out of date. Send /leave again.");
        return;
    }

    const forSomeoneElse = userId !== ctx.from?.id;
    await removeUser(userId);

    if (forSomeoneElse) {
        await stopActing("removed");
        await ctx.reply(`✅ Removed ID ${userId}. They've been told. You're back on your own account.`);
        return;
    }

    await ctx.reply(
        "👋 You've left the bot. Your saved details are deleted and you won't get any more messages.\n\n" +
        "Send /start any time to come back."
    );
}

/** The admin's confirm button from asking the chat to remove someone. */
export async function handleAdminRemove(ctx: Context, data: string) {
    if (ctx.from?.id !== ADMIN_CHAT_ID) {
        await ctx.reply("❌ Not available.");
        return;
    }

    const userId = Number(data.slice(ADMIN_REMOVE_PREFIX.length));
    const user = Number.isInteger(userId) ? await UserService.getUser(userId) : null;
    if (!user || userId === ADMIN_CHAT_ID) {
        await ctx.reply("Nothing to remove: that user is already gone.");
        return;
    }

    const who = describeUser(user);
    await removeUser(userId);

    if (actingFor()?.userId === userId) {
        await stopActing("removed");
    } else {
        await sendMessage(REMOVED_MESSAGE, userId);
    }
    await ctx.reply(`✅ Removed ${who}. They've been told.`, { parse_mode: "HTML" });
}
