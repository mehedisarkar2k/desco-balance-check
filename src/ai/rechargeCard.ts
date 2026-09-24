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

export interface SimulationPhase {
    from: string;
    to: string;
    kwh: number;
    costBDT: number;
    balanceAfter: number;
}

export interface SimulationInput {
    language: ReplyLanguage;
    today: string;
    amountBDT: number;
    rechargeOn: string;
    away: { from: string; until: string; kwhPerDay: number } | null;
    balanceBDT: number;
    /** Phases before the recharge, then those after it. */
    before: SimulationPhase[];
    after: SimulationPhase[];
    balanceBeforeRecharge: number;
    charges: CardCharges;
    vatBDT: number;
    powerBDT: number;
    runsOutOn: string | null;
    runsOutWithout: string | null;
    runsOutBeforeRecharge: string | null;
    /** The month's slabs, from the readings, for the rates line. */
    slabs: { thresholds: number[]; rates: number[] } | null;
    kwhPerDay: number;
    usageWindowDays: number;
    savedCopyAsOf: string | null;
}

/** Phases shown before the rest are summed into one line, so a large amount stays readable. */
const MAX_PHASES_SHOWN = 8;

function range(from: string, to: string, language: ReplyLanguage): string {
    if (from === to) return day(from, language);
    const start = from.slice(0, 7) === to.slice(0, 7) ? String(parts(from).day) : day(from, language);
    return `${start}–${day(to, language)}`;
}

function rate(phase: SimulationPhase): string {
    return phase.kwh > 0 ? (phase.costBDT / phase.kwh).toFixed(2) : "0";
}

function slabsLine(slabs: SimulationInput["slabs"], language: ReplyLanguage): string | null {
    if (!slabs || slabs.rates.length === 0) return null;
    const { thresholds, rates } = slabs;
    const bn = language === "bn";

    const steps = rates.map((r, i) => {
        if (i === rates.length - 1) {
            return i === 0 ? `${r.toFixed(2)}` : bn ? `${thresholds[i - 1]}-এর পর ${r.toFixed(2)}` : `${r.toFixed(2)} after ${thresholds[i - 1]}`;
        }
        return bn ? `${thresholds[i]} ইউনিট পর্যন্ত ${r.toFixed(2)}` : `${r.toFixed(2)} up to ${thresholds[i]} units`;
    });

    // The lifeline: past 50 units the whole month is billed at the next rate.
    const lifeline = thresholds[0] === 50 && rates.length > 1
        ? bn
            ? `; 50 পার হলে আগের ইউনিটগুলোও ${rates[1].toFixed(2)} ধরা হয়`
            : `; past 50, the earlier units are billed at ${rates[1].toFixed(2)} too`
        : "";

    return bn
        ? `রেট (আপনার মিটারের রিডিং থেকে, প্রতি kWh): ${steps.join(", ")}${lifeline}। প্রতি মাসের 1 তারিখে আবার শুরু।`
        : `Rates (from your meter's readings, per kWh): ${steps.join(", ")}${lifeline}. They start again on the 1st.`;
}

function phaseLines(phases: SimulationPhase[], language: ReplyLanguage): string[] {
    const bn = language === "bn";
    const shown = phases.slice(0, MAX_PHASES_SHOWN);
    const lines = shown.map((p) => {
        const left = p.balanceAfter > 0
            ? (bn ? `বাকি ~${Math.round(p.balanceAfter)}` : `~${Math.round(p.balanceAfter)} left`)
            : (bn ? "শেষ" : "used up");
        return bn
            ? `• ${range(p.from, p.to, "bn")}: ~${Math.round(p.kwh)} kWh, ~${Math.round(p.costBDT)} টাকা (গড় ${rate(p)}/kWh) → ${left}`
            : `• ${range(p.from, p.to, "en")}: ~${Math.round(p.kwh)} kWh, ~${Math.round(p.costBDT)} BDT (avg ${rate(p)}/kWh) → ${left}`;
    });

    const rest = phases.slice(MAX_PHASES_SHOWN);
    if (rest.length > 0) {
        const last = rest[rest.length - 1];
        const kwh = rest.reduce((s, p) => s + p.kwh, 0);
        const cost = rest.reduce((s, p) => s + p.costBDT, 0);
        lines.push(
            bn
                ? `• ${range(rest[0].from, last.to, "bn")}: ~${Math.round(kwh)} kWh, ~${Math.round(cost)} টাকা`
                : `• ${range(rest[0].from, last.to, "en")}: ~${Math.round(kwh)} kWh, ~${Math.round(cost)} BDT`
        );
    }
    return lines;
}

/**
 * What a recharge of a given amount on a given day does, step by step: the
 * balance spent at this month's rate, the recharge less its fixed charges and
 * VAT, and the power it buys spent at the new month's slabs. Asked for this
 * breakdown, the model listed its inputs and never showed the arithmetic.
 */
export function renderSimulationCard(input: SimulationInput): string {
    const bn = input.language === "bn";
    const d = (date: string) => day(date, input.language);
    const when = input.rechargeOn === input.today ? (bn ? "আজ" : "today") : d(input.rechargeOn);
    const lines: string[] = [
        bn
            ? `<b>💡 ${when} ${input.amountBDT} টাকা রিচার্জ করলে</b>`
            : `<b>💡 If you recharge ${input.amountBDT} BDT ${input.rechargeOn === input.today ? "today" : `on ${when}`}</b>`,
    ];
    if (input.away) {
        lines.push(bn
            ? `🧳 বাইরে: ${d(input.away.from)} – ${d(input.away.until)}`
            : `🧳 Away: ${d(input.away.from)} – ${d(input.away.until)}`);
    }
    lines.push("", bn ? `এখনকার ব্যালেন্স: ${Math.floor(input.balanceBDT)} টাকা` : `Balance now: ${Math.floor(input.balanceBDT)} BDT`);

    lines.push(...phaseLines(input.before, input.language));

    const charges = input.charges.months.length > 0
        ? bn
            ? `${monthNamesOfBn(input.charges.months)} ফিক্সড চার্জ ${input.charges.totalBDT} ও `
            : `the fixed charge for ${monthNames(input.charges.months, "en")} (${input.charges.totalBDT}) and `
        : "";
    const after = Math.round(Math.max(0, input.balanceBeforeRecharge) + input.powerBDT);
    lines.push(bn
        ? `• ${when} রিচার্জ ${input.amountBDT}: ${charges}VAT ~${input.vatBDT} বাদে বিদ্যুৎ ~${input.powerBDT} → ব্যালেন্স ~${after}`
        : `• Recharge ${input.amountBDT} ${input.rechargeOn === input.today ? "today" : `on ${when}`}: less ${charges}VAT ~${input.vatBDT}, ` +
          `~${input.powerBDT} of power → balance ~${after}`);

    lines.push(...phaseLines(input.after, input.language));

    lines.push("");
    if (input.runsOutBeforeRecharge) {
        lines.push(bn
            ? `⚠️ রিচার্জের আগেই ${d(input.runsOutBeforeRecharge)} ব্যালেন্স শেষ হবে। তার আগে রিচার্জ করুন।`
            : `⚠️ The balance runs out on ${d(input.runsOutBeforeRecharge)}, before this recharge. Recharge before then.`);
    }
    const without = input.runsOutWithout
        ? (bn ? ` (রিচার্জ ছাড়া ${d(input.runsOutWithout)})` : ` (without it, ${d(input.runsOutWithout)})`)
        : "";
    lines.push(input.runsOutOn
        ? (bn ? `<b>শেষ হবে আনুমানিক ${d(input.runsOutOn)}</b>${without}` : `<b>Runs out about ${d(input.runsOutOn)}</b>${without}`)
        : (bn ? "<b>1 বছরের বেশি চলবে</b>" : "<b>Lasts more than a year</b>"));

    const rates = slabsLine(input.slabs, input.language);
    lines.push("");
    if (rates) lines.push(`<i>${rates}</i>`);
    lines.push(bn
        ? `<i>অনুমান: বাসায় দিনে ~${input.kwhPerDay.toFixed(1)} kWh (গত ${input.usageWindowDays} দিনের গড়)। ` +
          "রিচার্জের তারিখে রেট বদলায় না; রেট নির্ভর করে কোন দিন বিদ্যুৎ খরচ হচ্ছে তার উপর।</i>"
        : `<i>Estimate: ~${input.kwhPerDay.toFixed(1)} kWh a day at home (your last ${input.usageWindowDays} days' average). ` +
          "The day you recharge does not change the rate; the day the power is used does.</i>");
    if (input.savedCopyAsOf) {
        lines.push(bn
            ? `<i>⚠️ DESCO এখন সাড়া দিচ্ছে না, তাই এটা ${input.savedCopyAsOf}-এর সংরক্ষিত ডেটা থেকে।</i>`
            : `<i>⚠️ DESCO is not responding right now, so this uses saved data from ${input.savedCopyAsOf}.</i>`);
    }

    return lines.join("\n");
}
