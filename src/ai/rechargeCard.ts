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
 *
 * Kept short on purpose: the answer, the one or two things to act on, and the
 * assumption. A card that explained every charge and caveat was read as a
 * wall of text, and a note about a charge read as "recharge again".
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

type CardAway = { from: string; until: string; kwhPerDay: number; openEnded: boolean };

export interface CardInput {
    language: ReplyLanguage;
    today: string;
    until: string;
    balanceBDT: number;
    /** Null when the balance lasts past `until`. */
    balanceRunsOutOn: string | null;
    away: CardAway | null;
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

function range(from: string, to: string, language: ReplyLanguage): string {
    if (from === to) return day(from, language);
    const start = from.slice(0, 7) === to.slice(0, 7) ? String(parts(from).day) : day(from, language);
    return `${start}–${day(to, language)}`;
}

function awayLine(away: CardAway, language: ReplyLanguage): string {
    if (language === "bn") {
        return away.openEnded
            ? `🧳 বাইরে: ${day(away.from, "bn")} থেকে`
            : `🧳 বাইরে: ${range(away.from, away.until, "bn")}`;
    }
    return away.openEnded
        ? `🧳 Away from ${day(away.from, "en")}`
        : `🧳 Away: ${range(away.from, away.until, "en")}`;
}

/** "দিনে ~6.7 kWh (গত 14 দিনের গড়), বাইরে থাকলে ~1.2 kWh". */
function usageAssumption(kwhPerDay: number, windowDays: number, away: CardAway | null, language: ReplyLanguage): string {
    const bn = language === "bn";
    const home = bn
        ? `দিনে ~${kwhPerDay.toFixed(1)} kWh (গত ${windowDays} দিনের গড়)`
        : `~${kwhPerDay.toFixed(1)} kWh a day (your last ${windowDays} days' average)`;
    if (!away) return home;
    if (away.kwhPerDay > 0) {
        return bn ? `${home}, বাইরে থাকলে ~${away.kwhPerDay} kWh` : `${home}, ~${away.kwhPerDay} kWh while away`;
    }
    return bn ? `${home}, বাইরে থাকলে সব বন্ধ` : `${home}, nothing while away`;
}

function savedCopyLine(asOf: string | null, language: ReplyLanguage): string | null {
    if (!asOf) return null;
    return language === "bn"
        ? `<i>⚠️ DESCO এখন সাড়া দিচ্ছে না; ${asOf}-এর ডেটা থেকে হিসাব।</i>`
        : `<i>⚠️ DESCO is not responding; this uses data from ${asOf}.</i>`;
}

/** When to recharge: "by 30 Sep" from today, otherwise the window. */
function when(option: CardOption, today: string, language: ReplyLanguage): string {
    if (language === "bn") {
        if (option.from === today) return `${dayOfBn(option.to)} মধ্যে`;
        if (option.from === option.to) return `${day(option.to, "bn")} তারিখে`;
        const start = option.from.slice(0, 7) === option.to.slice(0, 7) ? String(parts(option.from).day) : day(option.from, "bn");
        return `${start}–${dayOfBn(option.to)} মধ্যে`;
    }
    if (option.from === today) return `By ${day(option.to, "en")}`;
    if (option.from === option.to) return `On ${day(option.to, "en")}`;
    return range(option.from, option.to, "en");
}

export function renderRechargeCard(input: CardInput): string {
    const bn = input.language === "bn";
    const d = (date: string) => day(date, input.language);
    const lines: string[] = [bn ? `<b>📅 ${d(input.until)} পর্যন্ত চালাতে</b>` : `<b>📅 To last until ${d(input.until)}</b>`];
    if (input.away) lines.push(awayLine(input.away, input.language));

    const runsOut = input.balanceRunsOutOn;
    lines.push(runsOut
        ? (bn ? `এখনকার ব্যালেন্সে চলবে ~${d(runsOut)} পর্যন্ত।` : `Your balance lasts until about ${d(runsOut)}.`)
        : (bn ? "এখনকার ব্যালেন্সেই চলবে, রিচার্জ লাগবে না।" : "Your balance is enough; no recharge needed."));

    if (input.runsOutWhileAway && runsOut) {
        lines.push(bn
            ? `⚠️ ${d(runsOut)} আপনি বাইরে থাকবেন, তাই যাওয়ার আগেই রিচার্জ করে যান।`
            : `⚠️ You will be away on ${d(runsOut)}, so recharge before you leave.`);
    }

    if (input.options.length > 0) {
        lines.push("", bn ? "<b>রিচার্জ:</b>" : "<b>Recharge:</b>");
        for (const option of input.options) {
            const charge = option.includes.months.length > 0
                ? (bn ? `, ${monthNamesOfBn(option.includes.months)} ফিক্সড চার্জ সহ` : `, with ${monthNames(option.includes.months, "en")}'s fixed charge`)
                : "";
            lines.push(bn
                ? `• ${when(option, input.today, "bn")}: <b>~${option.suggestedBDT} টাকা</b> (নিরাপদ ~${option.safeBDT})${charge}`
                : `• ${when(option, input.today, "en")}: <b>~${option.suggestedBDT} BDT</b> (safe ~${option.safeBDT})${charge}`);
            if (option.includes.months.length > 1) {
                lines.push(bn ? "   ⚠️ এর চেয়ে কম দিলে বিদ্যুৎ যোগ না-ও হতে পারে" : "   ⚠️ Pay less and it may add no power");
            }
        }

        // One line for every charge left for later, instead of one per option.
        const later = input.options.find((o) => o.later)?.later;
        if (later) {
            const perMonth = Math.round(later.totalBDT / later.months.length);
            const same = input.options.length > 1;
            lines.push(bn
                ? `বাকি মাসের ফিক্সড চার্জ (মাসে ~${perMonth}) পরের রিচার্জ থেকে কাটবে${same ? "; মোট খরচ একই" : ""}।`
                : `Later months' fixed charge (~${perMonth} a month) comes out of your next recharge${same ? "; the total is the same" : ""}.`);
        }
    } else {
        if (input.safeOnlyBDT) {
            lines.push(bn ? `ব্যবহার বাড়লে ~${input.safeOnlyBDT} টাকা লাগতে পারে।` : `If you use more, you may need ~${input.safeOnlyBDT} BDT.`);
        }
        if (input.pendingNext) {
            lines.push(bn
                ? `পরের রিচার্জ থেকে আগে ফিক্সড চার্জ ~${input.pendingNext.totalBDT} টাকা কাটবে।`
                : `Your next recharge first pays ~${input.pendingNext.totalBDT} BDT of fixed charges.`);
        }
    }

    const safe = input.options.length > 0
        ? (bn ? ` "নিরাপদ" মানে ব্যবহার ${input.safeMarginPercent}% বাড়লেও চলবে।` : ` "Safe" allows ${input.safeMarginPercent}% more use.`)
        : "";
    const earlier = input.earlierDeparturePossible ? (bn ? " আগে গেলে একটু কম লাগবে।" : " Leaving earlier costs a little less.") : "";
    lines.push("", bn
        ? `<i>অনুমান: ${usageAssumption(input.kwhPerDay, input.usageWindowDays, input.away, "bn")}।${safe}${earlier}</i>`
        : `<i>Estimate: ${usageAssumption(input.kwhPerDay, input.usageWindowDays, input.away, "en")}.${safe}${earlier}</i>`);

    const saved = savedCopyLine(input.savedCopyAsOf, input.language);
    if (saved) lines.push(saved);

    return lines.join("\n");
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
    away: CardAway | null;
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
    /** The user named only the month of the recharge. */
    dayUnspecified: boolean;
    /** Show the slab-by-slab calculation; only when the user asked for it. */
    showBreakdown: boolean;
    /** The month's slabs, from the readings, for the rates line. */
    slabs: { thresholds: number[]; rates: number[] } | null;
    kwhPerDay: number;
    usageWindowDays: number;
    savedCopyAsOf: string | null;
}

/** Phases shown before the rest are summed into one line, so a large amount stays readable. */
const MAX_PHASES_SHOWN = 6;

/** "75 ইউনিট পর্যন্ত 5.26 (মাসে 50-এর কম হলে 4.63), তারপর 8.50". */
function ratesLine(slabs: SimulationInput["slabs"], language: ReplyLanguage): string | null {
    if (!slabs || slabs.rates.length === 0) return null;
    const bn = language === "bn";
    let { thresholds, rates } = slabs;
    let lifeline = "";

    // Under 50 units the whole month is cheaper, and past 50 it is all billed
    // at the next rate, so the lifeline is a note on that rate, not a step.
    if (thresholds[0] === 50 && rates.length > 1) {
        lifeline = bn ? ` (মাসে 50-এর কম হলে ${rates[0].toFixed(2)})` : ` (${rates[0].toFixed(2)} if the month stays under 50)`;
        thresholds = thresholds.slice(1);
        rates = rates.slice(1);
    }

    const steps = rates.map((r, i) => {
        const rate = r.toFixed(2) + (i === 0 ? lifeline : "");
        if (i === rates.length - 1) return i === 0 ? rate : bn ? `তারপর ${rate}` : `then ${rate}`;
        return bn ? `${thresholds[i]} ইউনিট পর্যন্ত ${rate}` : `${rate} up to ${thresholds[i]} units`;
    });

    return bn
        ? `রেট (প্রতি kWh): ${steps.join(", ")}। প্রতি মাসের 1 তারিখে আবার শুরু।`
        : `Rates per kWh: ${steps.join(", ")}. They start again on the 1st.`;
}

function phaseLines(phases: SimulationPhase[], language: ReplyLanguage): string[] {
    const bn = language === "bn";
    const line = (from: string, to: string, kwh: number, cost: number, left: number) => {
        const rate = kwh > 0 ? ` (${(cost / kwh).toFixed(2)}/kWh)` : "";
        const rest = left > 0 ? (bn ? `বাকি ~${Math.round(left)}` : `~${Math.round(left)} left`) : (bn ? "শেষ" : "used up");
        return bn
            ? `• ${range(from, to, "bn")}: ~${Math.round(cost)} টাকা${rate} → ${rest}`
            : `• ${range(from, to, "en")}: ~${Math.round(cost)} BDT${rate} → ${rest}`;
    };

    const lines = phases.slice(0, MAX_PHASES_SHOWN).map((p) => line(p.from, p.to, p.kwh, p.costBDT, p.balanceAfter));
    const rest = phases.slice(MAX_PHASES_SHOWN);
    if (rest.length > 0) {
        const last = rest[rest.length - 1];
        lines.push(line(
            rest[0].from, last.to,
            rest.reduce((s, p) => s + p.kwh, 0), rest.reduce((s, p) => s + p.costBDT, 0), last.balanceAfter
        ));
    }
    return lines;
}

/**
 * What a recharge of a given amount on a given day does: when the power runs
 * out, and what the recharge buys after its fixed charge and VAT. The
 * slab-by-slab calculation is added only when asked for.
 */
export function renderSimulationCard(input: SimulationInput): string {
    const bn = input.language === "bn";
    const d = (date: string) => day(date, input.language);
    const recharging = input.amountBDT > 0;
    const when = input.rechargeOn === input.today ? (bn ? "আজ" : "today") : d(input.rechargeOn);

    const lines: string[] = [
        !recharging
            ? (bn ? "<b>💡 রিচার্জ না করলে</b>" : "<b>💡 Without a recharge</b>")
            : bn
                ? `<b>💡 ${when} ${input.amountBDT} টাকা দিলে</b>`
                : `<b>💡 Recharging ${input.amountBDT} BDT ${input.rechargeOn === input.today ? "today" : `on ${when}`}</b>`,
    ];
    if (input.away) lines.push(awayLine(input.away, input.language));

    const without = recharging && input.runsOutWithout
        ? (bn ? ` (না দিলে ~${d(input.runsOutWithout)})` : ` (without it, ~${d(input.runsOutWithout)})`)
        : "";
    lines.push(input.runsOutOn
        ? (bn ? `চলবে <b>~${d(input.runsOutOn)}</b> পর্যন্ত${without}` : `Lasts until <b>~${d(input.runsOutOn)}</b>${without}`)
        : (bn ? "চলবে 1 বছরের বেশি" : "Lasts more than a year"));

    if (recharging) {
        const charge = input.charges.months.length > 0
            ? (bn ? `ফিক্সড চার্জ ${input.charges.totalBDT} ও ` : `the ${input.charges.totalBDT} fixed charge and `)
            : "";
        lines.push(bn
            ? `${input.amountBDT} থেকে ${charge}VAT ${input.vatBDT} কেটে বিদ্যুৎ ~${input.powerBDT} টাকার।`
            : `${input.amountBDT} less ${charge}${input.vatBDT} VAT buys ~${input.powerBDT} of power.`);
    }

    // Things to act on, one line each.
    const notes: string[] = [];
    if (input.runsOutBeforeRecharge) {
        notes.push(bn
            ? `⚠️ ${d(input.runsOutBeforeRecharge)} ব্যালেন্স শেষ হবে, তাই তার আগেই দিন।`
            : `⚠️ Your balance runs out on ${d(input.runsOutBeforeRecharge)}, so recharge before then.`);
    }
    if (input.dayUnspecified && recharging) {
        const month = input.rechargeOn.slice(0, 7);
        const deadline = input.runsOutWithout && input.runsOutWithout.slice(0, 7) === month ? input.runsOutWithout : null;
        const index = Number(month.slice(5, 7)) - 1;
        notes.push(bn
            ? `• ${MONTHS_BN_OF[index]} যেকোনো দিন দিলেই হবে${deadline ? `, ${parts(deadline).day} তারিখের আগে` : ""}।`
            : `• Any day in ${MONTHS.en[index]} works${deadline ? `, before ${d(deadline)}` : ""}.`);
    }
    const away = input.away;
    if (away && input.runsOutOn && input.runsOutOn >= away.from && input.runsOutOn <= away.until) {
        const what = away.kwhPerDay > 0 ? (bn ? "ফ্রিজ" : "the fridge") : (bn ? "বিদ্যুৎ" : "the power");
        notes.push(away.openEnded
            ? bn
                ? `• ${dayOfBn(input.runsOutOn)} পরেও বাইরে থাকলে তখন ${what} বন্ধ হবে।`
                : `• If you are still away after ${d(input.runsOutOn)}, ${what} goes off then.`
            : bn
                ? `⚠️ বাইরে থাকতেই শেষ হবে; ${what} চালু রাখতে ${dayOfBn(input.runsOutOn)} আগে আরেকবার রিচার্জ লাগবে।`
                : `⚠️ It runs out while you are away; to keep ${what} on, recharge again before ${d(input.runsOutOn)}.`);
    } else if (away && input.runsOutOn && input.runsOutOn < away.from) {
        notes.push(bn ? `⚠️ যাওয়ার (${d(away.from)}) আগেই শেষ হবে।` : `⚠️ It runs out before you leave on ${d(away.from)}.`);
    }
    if (notes.length > 0) lines.push("", ...notes);

    if (input.showBreakdown) {
        const after = Math.round(Math.max(0, input.balanceBeforeRecharge) + input.powerBDT);
        lines.push(
            "",
            bn ? `<b>হিসাব</b> (এখন ব্যালেন্স ${Math.floor(input.balanceBDT)}):` : `<b>Breakdown</b> (balance now ${Math.floor(input.balanceBDT)}):`,
            ...phaseLines(input.before, input.language)
        );
        if (recharging) {
            lines.push(bn ? `• ${when} রিচার্জ: +${input.powerBDT} → ~${after}` : `• Recharge ${when}: +${input.powerBDT} → ~${after}`);
        }
        lines.push(...phaseLines(input.after, input.language));
        const rates = ratesLine(input.slabs, input.language);
        if (rates) lines.push(`<i>${rates}</i>`);
    }

    lines.push("", bn
        ? `<i>অনুমান: ${usageAssumption(input.kwhPerDay, input.usageWindowDays, input.away, "bn")}।</i>`
        : `<i>Estimate: ${usageAssumption(input.kwhPerDay, input.usageWindowDays, input.away, "en")}.</i>`);

    const saved = savedCopyLine(input.savedCopyAsOf, input.language);
    if (saved) lines.push(saved);

    return lines.join("\n");
}
