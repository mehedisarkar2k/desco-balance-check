import type { ReplyLanguage } from "../ai/language";
import { escapeHtml } from "./html";

/**
 * What a new user reads while setting up, in their language.
 *
 * Setup used to ask for the account number and then the meter number. People
 * typed whichever number they had into the first box, so a meter number was
 * saved as an account number and every check after it failed. Now one number
 * is asked for and the bot works out which it is.
 */

export type NumberKind = "account" | "meter";

export interface WelcomeSettings {
    kind: NumberKind;
    number: string;
    time: string;
    thresholdTaka: number;
    thresholdDays: number;
}

export function askNumberText(language: ReplyLanguage): string {
    return language === "bn"
        ? "👋 <b>স্বাগতম!</b> আমি আপনার DESCO প্রিপেইড ব্যালেন্স দেখাই, আর কমে গেলে আগেই জানিয়ে দিই।\n\n" +
          "শুরু করতে আপনার <b>অ্যাকাউন্ট নম্বর</b> বা <b>মিটার নম্বর</b> পাঠান — যেকোনো একটা হলেই চলবে।\n\n" +
          "<i>অ্যাকাউন্ট নম্বর সাধারণত ৮ সংখ্যার, রিচার্জের রসিদে থাকে।\n" +
          "মিটার নম্বর সাধারণত ১২ সংখ্যার, মিটারের গায়ে লেখা থাকে।</i>"
        : "👋 <b>Welcome!</b> I show your DESCO prepaid balance and warn you before it runs out.\n\n" +
          "To start, send your <b>account number</b> or <b>meter number</b>. Either one is enough.\n\n" +
          "<i>The account number usually has 8 digits and is on your recharge receipt.\n" +
          "The meter number usually has 12 digits and is printed on the meter.</i>";
}

export function checkingNumberText(language: ReplyLanguage): string {
    return language === "bn" ? "DESCO-তে নম্বরটা মিলিয়ে দেখছি… ⏳" : "Checking this number with DESCO… ⏳";
}

/** The prompt for changing a saved number or checking a different one. */
export function sendNumberText(language: ReplyLanguage): string {
    return language === "bn"
        ? "আপনার <b>অ্যাকাউন্ট নম্বর</b> বা <b>মিটার নম্বর</b> পাঠান (থামাতে /cancel)।"
        : "Send your <b>account number</b> or <b>meter number</b> (or /cancel to stop).";
}

/** Short confirmation after a saved number is replaced. */
export function numberUpdatedText(language: ReplyLanguage): string {
    return language === "bn"
        ? "✅ নতুন নম্বর সেভ হয়ে গেছে।"
        : "✅ Your new number is saved.";
}

export function notANumberText(language: ReplyLanguage): string {
    return language === "bn"
        ? "শুধু নম্বরটা পাঠান, যেমন <code>41426704</code>। থামাতে /cancel।"
        : "Please send just the number, for example <code>41426704</code>. Send /cancel to stop.";
}

export function numberNotFoundText(language: ReplyLanguage, number: string): string {
    const shown = `<code>${escapeHtml(number)}</code>`;
    return language === "bn"
        ? `❌ DESCO-তে ${shown} নম্বরে কোনো অ্যাকাউন্ট বা মিটার পাইনি।\n\n` +
          "একবার মিলিয়ে দেখুন, তারপর আবার পাঠান:\n" +
          "• অ্যাকাউন্ট নম্বর: সাধারণত ৮ সংখ্যার, রিচার্জের রসিদে থাকে\n" +
          "• মিটার নম্বর: সাধারণত ১২ সংখ্যার, মিটারের গায়ে লেখা\n\n" +
          "<i>সাহায্য লাগলে /support</i>"
        : `❌ DESCO has no account or meter with the number ${shown}.\n\n` +
          "Please check it and send it again:\n" +
          "• Account number: usually 8 digits, on your recharge receipt\n" +
          "• Meter number: usually 12 digits, printed on the meter\n\n" +
          "<i>Need help? Send /support</i>";
}

export function descoUnreachableText(language: ReplyLanguage): string {
    return language === "bn"
        ? "⚠️ DESCO এখন সাড়া দিচ্ছে না, তাই নম্বরটা মিলিয়ে দেখতে পারলাম না। কয়েক মিনিট পরে আবার পাঠান।"
        : "⚠️ DESCO isn't answering right now, so I couldn't check the number. Please send it again in a few minutes.";
}

export function welcomeText(language: ReplyLanguage, settings: WelcomeSettings): string {
    const number = `<code>${escapeHtml(settings.number)}</code>`;
    const { time, thresholdTaka, thresholdDays } = settings;

    if (language === "bn") {
        const saved = settings.kind === "meter" ? `মিটার নম্বর ${number}` : `অ্যাকাউন্ট নম্বর ${number}`;
        return [
            `✅ <b>সব ঠিক আছে!</b> আপনার ${saved} সেভ হয়েছে।`,
            "",
            "<b>যা চালু করে দিয়েছি:</b>",
            `🔔 প্রতিদিন <b>${time}</b>-এ ব্যালেন্সের আপডেট — কত আছে, গতকাল কত খরচ হলো, আর কত দিন চলবে।`,
            `⚠️ ব্যালেন্স <b>${thresholdTaka} টাকায়</b> নামলে বা <b>${thresholdDays} দিনের</b> মতো বাকি থাকলে সতর্ক করব।`,
            "",
            "<b>বদলাতে চাইলে শুধু লিখে দিন:</b>",
            "• <i>\"রিমাইন্ডার সকাল ৮টায় দাও\"</i>",
            "• <i>\"২০০ টাকা হলে জানাবে\"</i>",
            "• <i>\"রিমাইন্ডার বন্ধ করো\"</i>",
            "",
            "<b>যা খুশি জিজ্ঞেস করতে পারেন:</b>",
            "• <i>\"আর কত দিন চলবে?\"</i>",
            "• <i>\"গত ৭ দিনে কত খরচ হলো?\"</i>",
            "• <i>\"মাসের শেষ পর্যন্ত চালাতে কত রিচার্জ লাগবে?\"</i>",
            "",
            "<i>বাংলা, Banglish বা English — যেভাবে সুবিধা লিখুন।</i>",
            "<i>কমান্ড: /balance · /usage · /recharges · /help</i>",
        ].join("\n");
    }

    const saved = settings.kind === "meter" ? `meter number ${number}` : `account number ${number}`;
    return [
        `✅ <b>All set!</b> Your ${saved} is saved.`,
        "",
        "<b>What's on for you:</b>",
        `🔔 A balance update every day at <b>${time}</b>: what's left, yesterday's use, and how many days it will last.`,
        `⚠️ A warning when the balance drops to <b>${thresholdTaka} BDT</b> or about <b>${thresholdDays} days</b> of power are left.`,
        "",
        "<b>To change anything, just tell me:</b>",
        "• <i>\"send the update at 8 am\"</i>",
        "• <i>\"warn me at 200 taka\"</i>",
        "• <i>\"stop the daily update\"</i>",
        "",
        "<b>Ask me anything:</b>",
        "• <i>\"how many days will my balance last?\"</i>",
        "• <i>\"usage for the last 7 days\"</i>",
        "• <i>\"how much should I recharge to last the month?\"</i>",
        "",
        "<i>Write in English, Bangla or Banglish.</i>",
        "<i>Commands: /balance · /usage · /recharges · /help</i>",
    ].join("\n");
}
