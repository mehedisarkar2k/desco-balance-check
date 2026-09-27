import { Context, Markup } from "telegraf";
import { UserService } from "../services/UserService";
import {
    actingFor,
    describeUser,
    issueSupportCode,
    startActing,
    stopActing,
    userIdOf,
} from "../services/SupportService";
import { ADMIN_CHAT_ID, ADMIN_USERNAME, sendMessage } from "../bot";
import { resetSession } from "../ai/session";
import { refreshSchedules } from "../scheduler";
import { userSessions } from "./commands";
import { deleteSnapshotsFor } from "../descoStore";
import { User } from "../models/User";

/** Callback data for confirming /leave; the account id follows it. */
export const LEAVE_CONFIRM_PREFIX = "leave_confirm:";

const timeInDhaka = (date: Date) =>
    date.toLocaleTimeString("en-GB", { timeZone: "Asia/Dhaka", hour: "2-digit", minute: "2-digit" });

export async function handleSupport(ctx: Context) {
    // The sender's own account, even for the admin while acting: the code
    // is consent from the person holding it.
    const senderId = ctx.from?.id;
    if (!senderId) return;

    const code = await issueSupportCode(senderId);

    await ctx.reply(
        "🆘 <b>Contact the admin</b>\n\n" +
        `Message @${ADMIN_USERNAME} with your question.\n\n` +
        `Your support code: <code>${code}</code>\n\n` +
        "Share this code only with the admin, and only if they ask for it. It lets them see and change " +
        "your bot settings, or remove you from the bot, for up to 1 hour. It works once, within 15 minutes; " +
        "send /support again for a new one. You'll get a message when they start and when they finish.",
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [Markup.button.url("💬 Message the admin", `https://t.me/${ADMIN_USERNAME}`)],
            ]),
        }
    );

    const user = await UserService.getUser(senderId);
    if (senderId !== ADMIN_CHAT_ID && user) {
        await sendMessage(
            `🆘 <b>Support request</b> from ${describeUser(user)}.\n\n` +
            "If you need their account, ask for their support code, then send /actas followed by the code.",
            ADMIN_CHAT_ID
        );
    }
}

export async function handleActAs(ctx: Context) {
    if (ctx.from?.id !== ADMIN_CHAT_ID) return;

    const text = ctx.message && "text" in ctx.message ? ctx.message.text : "";
    const code = text.split(/\s+/)[1]?.trim() ?? "";

    if (!code) {
        const current = actingFor();
        await ctx.reply(
            current
                ? `🛠 Acting for ID <code>${current.userId}</code> until ${timeInDhaka(current.until)}. /done to stop.`
                : "Send /actas followed by the user's 6-digit support code.",
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

export async function handleLeaveConfirm(ctx: Context, data: string) {
    const userId = userIdOf(ctx);
    const confirmedFor = Number(data.slice(LEAVE_CONFIRM_PREFIX.length));
    if (!userId || confirmedFor !== userId) {
        await ctx.reply("This button is out of date. Send /leave again.");
        return;
    }

    const forSomeoneElse = userId !== ctx.from?.id;
    const user = await UserService.getUser(userId);
    await UserService.deleteUser(userId);
    userSessions.delete(userId);

    // Saved DESCO copies are per account, and a family often shares one; they
    // go only when nobody else in the bot still uses the account.
    const hasAccount = Boolean(user?.accountNo || user?.meterNo);
    if (user && hasAccount && !(await User.exists({ accountNo: user.accountNo, meterNo: user.meterNo }))) {
        await deleteSnapshotsFor(user.accountNo, user.meterNo);
    }
    resetSession(userId);
    await refreshSchedules();

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
