import type { ReplyLanguage } from "./language";

/**
 * The recharge plan as the user sees it, written here rather than by the model.
 *
 * Given a dozen figures and a page of rules, the model quoted the energy credit
 * (1188.59) as the amount to pay, which is short by the VAT; presented the
 * September option as cheaper than October's when the fixed charge is paid
 * either way; and dropped the line saying it was all an estimate once the
 * conversation moved on. A fixed card keeps the amounts, the charges and the
 * assumption together every time.
 */

export interface CardCharges {
    months: string[];
    totalBDT: number;
}

export interface CardOption {
    from: string;
    to: string;
    suggestedBDT: number;
    safeBDT: number;
    includes: CardCharges;
    /** Charges this recharge does not pay; the next one after it does. */
    later: CardCharges | null;
}

export interface CardInput {
    language: ReplyLanguage;
    today: string;
    until: string;
    balanceBDT: number;
    /** Null when the balance lasts past `until`. */
    balanceRunsOutOn: string | null;
    away: { from: string; until: string; kwhPerDay: number } | null;
    runsOutWhileAway: boolean;
    options: CardOption[];
    /** When no recharge is needed at the recent average but one is at the safe margin. */
    safeOnlyBDT: number | null;
    /** Charges the next recharge will take, when no recharge is needed before `until`. */
    pendingNext: CardCharges | null;
    kwhPerDay: number;
    usageWindowDays: number;
    safeMarginPercent: number;
    /** The departure date was uncertain and the later one was planned for. */
    earlierDeparturePossible: boolean;
    /** "YYYY-MM-DD HH:mm" when the figures come from a saved copy, else null. */
    savedCopyAsOf: string | null;
}

const MONTHS = {
    en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    bn: ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"],
};

/** "সেপ্টেম্বরের", for "by 30 September". The ending follows the name's last sound. */
const MONTHS_BN_OF = [
    "জানুয়ারির", "ফেব্রুয়ারির", "মার্চের", "এপ্রিলের", "মে-র", "জুনের",
    "জুলাইয়ের", "আগস্টের", "সেপ্টেম্বরের", "অক্টোবরের", "নভেম্বরের", "ডিসেম্বরের",
];

function parts(date: string): { day: number; month: number } {
    return { day: Number(date.slice(8, 10)), month: Number(date.slice(5, 7)) - 1 };
}

function day(date: string, language: ReplyLanguage): string {
    const { day, month } = parts(date);
    return `${day} ${MONTHS[language][month]}`;
}

/** "25 অক্টোবরের", for "before 25 October". */
function dayOfBn(date: string): string {
    const { day, month } = parts(date);
    return `${day} ${MONTHS_BN_OF[month]}`;
}

function monthNames(months: string[], language: ReplyLanguage): string {
    const names = months.map((m) => MONTHS[language][Number(m.slice(5, 7)) - 1]);
    if (names.length <= 1) return names.join("");
    const joiner = language === "bn" ? " ও " : " and ";
    return `${names.slice(0, -1).join(", ")}${joiner}${names[names.length - 1]}`;
}

/** "অক্টোবর ও নভেম্বরের": the list with its last name in the possessive. */
function monthNamesOfBn(months: string[]): string {
    const last = months[months.length - 1];
    const lastOf = MONTHS_BN_OF[Number(last.slice(5, 7)) - 1];
    return months.length === 1 ? lastOf : `${monthNames(months.slice(0, -1), "bn")} ও ${lastOf}`;
}

/** When to recharge: "by 30 Sep" from today, otherwise the window. */
function when(option: CardOption, today: string, language: ReplyLanguage): string {
    const sameMonth = option.from.slice(0, 7) === option.to.slice(0, 7);

    if (language === "bn") {
            const by = `${dayOfBn(option.to)} মধ্যে`;
        if (option.from === today) return by;
        if (option.from === option.to) return `${day(option.to, "bn")} তারিখে`;
        const start = sameMonth ? String(parts(option.from).day) : day(option.from, "bn");
        return `${start}–${by}`;
    }

    if (option.from === today) return `By ${day(option.to, "en")}`;
    if (option.from === option.to) return `On ${day(option.to, "en")}`;
    const start = sameMonth ? String(parts(option.from).day) : day(option.from, "en");
    return `${start}–${day(option.to, "en")}`;
}

function renderBn(input: CardInput): string {
    const lines: string[] = [`<b>📅 ${day(input.until, "bn")} পর্যন্ত চালাতে</b>`];

    if (input.away) {
        lines.push(`🧳 বাইরে: ${day(input.away.from, "bn")} – ${day(input.away.until, "bn")}`);
    }
    lines.push("");

    const balance = Math.floor(input.balanceBDT);
    lines.push(
        input.balanceRunsOutOn
            ? `• এখনকার ব্যালেন্স (${balance} টাকা) চলবে আনুমানিক ${day(input.balanceRunsOutOn, "bn")} পর্যন্ত`
            : `• এখনকার ব্যালেন্স (${balance} টাকা) দিয়েই ${day(input.until, "bn")} পর্যন্ত চলবে, রিচার্জ লাগবে না`
    );

    if (input.runsOutWhileAway && input.balanceRunsOutOn) {
        lines.push(
            `⚠️ ব্যালেন্স শেষ হবে আপনি বাইরে থাকার সময়। ${dayOfBn(input.balanceRunsOutOn)} আগে রিচার্জ করুন: ` +
            "যাওয়ার আগে, বা বাইরে থেকে অনলাইনে।"
        );
    }

    if (input.options.length > 0) {
        lines.push("", "<b>কত রিচার্জ করবেন:</b>");
        for (const option of input.options) {
            lines.push(`• ${when(option, input.today, "bn")}: <b>~${option.suggestedBDT} টাকা</b> (নিরাপদ: ~${option.safeBDT})`);
            if (option.includes.months.length > 0) {
                lines.push(`   ${monthNamesOfBn(option.includes.months)} ফিক্সড চার্জ ${option.includes.totalBDT} টাকা সহ`);
            }
            if (option.includes.months.length > 1) {
                lines.push(`   ⚠️ এর চেয়ে কম দিলে শুধু ফিক্সড চার্জ কাটবে, বিদ্যুৎ যোগ হবে না। একটু বেশি দিন।`);
            }
            if (option.later) {
                lines.push(
                    `   ${monthNamesOfBn(option.later.months)} ফিক্সড চার্জ (${option.later.totalBDT} টাকা) এতে নেই; ` +
                    "পরের রিচার্জ থেকে আগে কাটবে"
                );
            }
        }
        if (input.options.length > 1) {
            lines.push("", "যখনই করুন, মোট খরচ একই। শুধু ফিক্সড চার্জ কোন রিচার্জ থেকে কাটবে সেটা বদলায়।");
        }
    } else {
        if (input.safeOnlyBDT) {
            lines.push(`• ব্যবহার ${input.safeMarginPercent}% বাড়লে ~${input.safeOnlyBDT} টাকা রিচার্জ লাগতে পারে`);
        }
        if (input.pendingNext) {
            lines.push(
                `• পরের রিচার্জ থেকে আগে কাটবে: ${monthNamesOfBn(input.pendingNext.months)} ফিক্সড চার্জ ` +
                `${input.pendingNext.totalBDT} টাকা`
            );
        }
    }

    const kwh = input.kwhPerDay.toFixed(1);
    const awayPart = !input.away
        ? ""
        : input.away.kwhPerDay > 0
            ? `, বাইরে থাকার সময় দিনে ~${input.away.kwhPerDay} kWh`
            : ", বাইরে থাকার সময় সব বন্ধ";
    const safePart = input.options.length > 0
        ? ` "নিরাপদ" মানে ব্যবহার ${input.safeMarginPercent}% বাড়লেও চলবে।`
        : "";
    lines.push(
        "",
        `<i>অনুমান: বাসায় দিনে ~${kwh} kWh (গত ${input.usageWindowDays} দিনের গড়)${awayPart}।${safePart} ` +
        "বেশি এসি চালালে বেশি লাগবে।</i>"
    );
    if (input.away && input.away.kwhPerDay > 0) {
        lines.push("<i>বাইরে যাওয়ার পর প্রথম পুরো দিনের ব্যবহার দেখে আসল হিসাব পাবেন; তখন আবার জিজ্ঞেস করুন।</i>");
    }
    if (input.earlierDeparturePossible) {
        lines.push("<i>পরের তারিখে যাওয়া ধরে হিসাব করা; আগে গেলে একটু কম লাগবে।</i>");
    }
    if (input.savedCopyAsOf) {
        lines.push(`<i>⚠️ DESCO এখন সাড়া দিচ্ছে না, তাই এটা ${input.savedCopyAsOf}-এর সংরক্ষিত ডেটা থেকে।</i>`);
    }

    return lines.join("\n");
}

function renderEn(input: CardInput): string {
    const lines: string[] = [`<b>📅 To last until ${day(input.until, "en")}</b>`];

    if (input.away) {
        lines.push(`🧳 Away: ${day(input.away.from, "en")} – ${day(input.away.until, "en")}`);
    }
    lines.push("");

    const balance = Math.floor(input.balanceBDT);
    lines.push(
        input.balanceRunsOutOn
            ? `• Your balance (${balance} BDT) lasts until about ${day(input.balanceRunsOutOn, "en")}`
            : `• Your balance (${balance} BDT) lasts past ${day(input.until, "en")}; no recharge needed`
    );

    if (input.runsOutWhileAway && input.balanceRunsOutOn) {
        lines.push(
            `⚠️ It runs out while you are away. Recharge before ${day(input.balanceRunsOutOn, "en")}: ` +
            "before you leave, or online while away."
        );
    }

    if (input.options.length > 0) {
        lines.push("", "<b>How much to recharge:</b>");
        for (const option of input.options) {
            lines.push(`• ${when(option, input.today, "en")}: <b>~${option.suggestedBDT} BDT</b> (safe: ~${option.safeBDT})`);
            if (option.includes.months.length > 0) {
                lines.push(`   includes the fixed charge for ${monthNames(option.includes.months, "en")}, ${option.includes.totalBDT} BDT`);
            }
            if (option.includes.months.length > 1) {
                lines.push("   ⚠️ Pay less than the charges and it adds no power. Pay a little more to be sure.");
            }
            if (option.later) {
                lines.push(
                    `   the fixed charge for ${monthNames(option.later.months, "en")} (${option.later.totalBDT} BDT) is not ` +
                    "in it; your next recharge pays it first"
                );
            }
        }
        if (input.options.length > 1) {
            lines.push("", "The total you pay is the same either way. Only which recharge pays the fixed charges changes.");
        }
    } else {
        if (input.safeOnlyBDT) {
            lines.push(`• If you use ${input.safeMarginPercent}% more, you may need ~${input.safeOnlyBDT} BDT`);
        }
        if (input.pendingNext) {
            lines.push(
                `• Your next recharge first pays the fixed charge for ${monthNames(input.pendingNext.months, "en")}, ` +
                `${input.pendingNext.totalBDT} BDT`
            );
        }
    }

    const kwh = input.kwhPerDay.toFixed(1);
    const awayPart = !input.away
        ? ""
        : input.away.kwhPerDay > 0
            ? `, ~${input.away.kwhPerDay} kWh a day while away`
            : ", nothing while away";
    const safePart = input.options.length > 0
        ? ` "Safe" still covers you if you use ${input.safeMarginPercent}% more.`
        : "";
    lines.push(
        "",
        `<i>Estimate: ~${kwh} kWh a day at home (your last ${input.usageWindowDays} days' average)${awayPart}.${safePart} ` +
        "More AC means more.</i>"
    );
    if (input.away && input.away.kwhPerDay > 0) {
        lines.push("<i>Your first full day away will show what is really left on; ask again then.</i>");
    }
    if (input.earlierDeparturePossible) {
        lines.push("<i>Planned for the later departure; leaving earlier costs a little less.</i>");
    }
    if (input.savedCopyAsOf) {
        lines.push(`<i>⚠️ DESCO is not responding right now, so this uses saved data from ${input.savedCopyAsOf}.</i>`);
    }

    return lines.join("\n");
}

export function renderRechargeCard(input: CardInput): string {
    return input.language === "bn" ? renderBn(input) : renderEn(input);
}
