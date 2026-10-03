import type { ReplyLanguage } from "../ai/language";

export function supportIntake(language: ReplyLanguage): string {
    return language === "bn"
        ? "🆘 আপনার সাপোর্ট অনুরোধ পেয়েছি। কী সমস্যা হচ্ছে আর কী করতে চাচ্ছিলেন, একটু বিস্তারিত বলবেন?\n\nবাংলা, English বা Banglish—যেভাবে সুবিধা এখানেই লিখুন। AI সহকারী আগে সাহায্যের চেষ্টা করবে; না পারলে বিস্তারিতসহ অ্যাডমিনকে জানাবে। এই সাপোর্ট কথোপকথন অ্যাডমিন দেখতে পারবেন।\n\nসাধারণ বট চ্যাটে ফিরতে /cancel দিন।"
        : "🆘 We received your support request. Could you tell us a little more about the issue and what you were trying to do?\n\nReply here in Bangla, English, or Banglish. Our AI assistant will try to help first; if it cannot, it will pass the details to the admin. The admin can review this support conversation.\n\nUse /cancel to return to normal bot chat.";
}

export function isLateInDhaka(now = new Date()): boolean {
    const hour = Number(new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Dhaka", hour: "2-digit", hourCycle: "h23",
    }).format(now));
    return hour >= 23 || hour < 7;
}

export function escalationNotice(language: ReplyLanguage, delivered: boolean, now = new Date()): string {
    const bn = language === "bn";
    if (!delivered) return bn
        ? "আপনার সমস্যার বিস্তারিত টিকিটে সংরক্ষণ করেছি, তবে অ্যাডমিনকে নোটিফিকেশন পাঠানো যায়নি। টিকিটটি তাঁর সাপোর্ট তালিকায় আছে। এখানেই আরও তথ্য লিখতে পারেন।"
        : "Your details are saved in the support ticket, but the admin notification could not be delivered. The ticket is in their support queue. You can add more details here.";
    const base = bn
        ? "আপনার সমস্যার বিস্তারিত অ্যাডমিনকে পাঠিয়েছি। তিনি এখানেই বটের মাধ্যমে উত্তর দেবেন।"
        : "I've sent your ticket and the details to the admin. They will reply here through the bot.";
    return base + (isLateInDhaka(now)
        ? (bn ? " এখন ঢাকায় গভীর রাত, তাই উত্তর পেতে কিছুটা দেরি হতে পারে।" : " It is late at night in Dhaka, so a reply may take a little longer.")
        : (bn ? " যত দ্রুত সম্ভব দেখে জানাবেন।" : " They will review it as soon as they can."));
}
