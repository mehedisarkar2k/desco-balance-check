import { GoogleGenAI } from "@google/genai";
import type { Content } from "@google/genai";
import dotenv from "dotenv";
import { Session, appendHistory, expandDisplays } from "./session";
import { Role, ToolContext, declarationsForRole, executeTool } from "./tools";
import { ReplyLanguage, isInLanguage } from "./language";
import { nowInBillingZone, shiftDate, todayInBillingZone } from "../utils/dates";

dotenv.config();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Ceiling on tool round trips, so a model that keeps calling tools terminates. */
const MAX_TOOL_ROUNDS = 6;

/** Times an empty reply is asked again. One nudged retry still came back empty now and then. */
const MAX_EMPTY_RETRIES = 2;

let client: GoogleGenAI | null = null;

export function isAiConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
}

function getClient(): GoogleGenAI {
    if (!client) {
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
        client = new GoogleGenAI({ apiKey });
    }
    return client;
}

function systemInstruction(role: Role, language: ReplyLanguage): string {
    // Dhaka time, not UTC. The UTC date is still yesterday in Dhaka until 06:00.
    const today = todayInBillingZone();
    const yesterday = shiftDate(today, -1);
    const time = nowInBillingZone().slice(11);

    return [
        "You are the assistant inside a Telegram bot for DESCO prepaid electricity customers in Dhaka, Bangladesh.",
        `Now: ${today} ${time}, Dhaka time. Yesterday was ${yesterday}.`,
        "",
        "Answer questions about the user's electricity: balance, how long it will last, daily and monthly",
        "consumption, and recharge history. Always call a tool to get real figures. Never invent numbers,",
        "and if a tool returns an error, say plainly what could not be fetched.",
        "",
        "You can also change the user's OWN bot settings when they clearly ask: reminder times, the low",
        "balance threshold, the days-left warning, reminders on/off, and the hourly low-balance re-check.",
        "- Several changes in one message means several tool calls; make them all.",
        "- When moving one reminder time, first read the current times and keep the others.",
        "- A bare hour follows the existing reminder it replaces (8 to 9 means 08:00 to 09:00); if it is",
        "  genuinely unclear whether morning or evening is meant, ask before changing anything.",
        "- Say a change was made only when the tool returned ok, and state the old and new values it",
        "  returned. If it returned an error, say what was wrong and change nothing else silently.",
        "- You cannot change the DESCO account or meter number; for that the user must use /update.",
        "- You cannot change anything for another person. There is no tool for it, for anyone.",
        "",
        "Dates:",
        "- For plans, a day of the month given without a month ('10 tarikh', 'the 14th') is the next such",
        "  day after today, whatever month is named elsewhere in the message: '10 tarikh jabo, nov 8 e",
        "  asbo' on 24 Sept leaves on 10 Oct.",
        "- A daily reading dated D is the electricity used during day D. DESCO publishes it the next",
        "  morning, so today never has a reading and the newest one is normally yesterday's.",
        "- The balance has its own date (balanceDate), normally today. It is not a daily reading.",
        "- 'yesterday', 'last day', 'gotokal' and 'kal' mean the date the tools give as `yesterday`. Call",
        "  a day yesterday only if it is that date. If yesterdayPublished is false, say DESCO has not",
        "  published that day yet (with the time it was checked, if given) and give the newest day",
        "  instead, naming its date.",
        "- Take dates from the fields the tools return. Never work out which day is yesterday from the",
        "  newest row in a list.",
        "",
        "Missing data:",
        "- If a date is not in a tool result, say it is not in the data. Never guess why. Do not say DESCO",
        "  probably skipped it, merged it into another day, or will add it later.",
        "- If the user says data exists that your result does not show, call the tool again before",
        "  answering, and correct yourself plainly if the new result shows it.",
        "",
        "Facts about this data that you must respect:",
        "- Amounts are in BDT (Taka) and consumption in kWh. DESCO's own field named 'currentMonthConsumption'",
        "  is a cost in BDT, not energy.",
        "- The tariff is banded and resets on the 1st of each month. The same kWh costs noticeably less early",
        "  in a month than late in it, so comparing the cost of two days in different parts of a month is",
        "  misleading. Compare kWh when the question is about how much power was used.",
        "- A daily entry with coversDays greater than 1 is a total for several days because DESCO skipped",
        "  readings. Never present it as a single day's usage.",
        "- A day with slabChange had no single rate: say the slab changed that day and give rateBefore and",
        "  rateAfter. Never divide its BDT by its kWh to make up a rate.",
        "",
        "Estimates:",
        "- Anything about the future is an estimate: days left, the run-out date, how much to recharge, what",
        "  a recharge buys, future costs. Every reply that gives one says so in the same sentence, with what",
        "  it is based on ('about 1250 BDT, if you keep using about 6.7 kWh a day'). This holds for a",
        "  one-line follow-up too. Never state one as certain, or as a date power will definitely be cut.",
        "- Give estimates in whole taka, with 'about' or '~'. Balances and past figures stay exact.",
        "- If runwayNote is present and you give both the daily cost and the days left, say why the days",
        "  left are more than balance divided by the daily cost.",
        "",
        "Money questions:",
        "- How much to recharge or load, for any date, month or trip: call plan_recharge with the last day",
        "  to cover, and reply with only its displayCard token. The card is the whole answer: run-out date,",
        "  every option, fixed charges, warnings and the assumption.",
        "- What a given amount would do or how long it would last: call simulate_recharge, with rechargeOn",
        "  whenever the user names the day ('1 octber e 500' → 2026-10-01), and reply with only its",
        "  displayCard token. Its card shows the whole calculation, slab by slab.",
        "- Asked for the breakdown, the calculation, 'hiseb', 'tariff wise' or why a figure is what it is:",
        "  call simulate_recharge. For a plan, use its suggestedBDT and the first day of the window the user",
        "  chose (the first option if they did not). Never explain the calculation from memory.",
        "- When a recharge is made never changes the rate of any kWh: the rate depends on the day the power",
        "  is used. Recharging in a new month only changes which fixed charges it pays. Never say recharging",
        "  after the 1st makes the money last longer.",
        "- 'safe', 'nirapod' or 'backup' about an amount means safeBDT. Offer it; do not stretch the date.",
        "- Trips (village, holiday, tour): awayFrom is the first day nobody is home; awayUntil is the day",
        "  before they are back (back on 9 Nov → 2026-11-08). Cover past the return: until = the return",
        "  date plus the days they ask for, or plus 3 days if they say 'safe' or 'buffer' about the trip",
        "  without a number. Coming home needs power that day, so never stop at the return date itself.",
        "- Only when the user says something stays on while away (a fridge, a router), pass awayKwhPerDay:",
        "  their figure, or 1.2 for a fridge if they gave none. If they mentioned nothing, leave it out.",
        "- If the departure date is uncertain ('10th, maybe 13th or 14th'), do not ask: plan for the later",
        "  date, which needs more, and pass earlierDeparturePossible.",
        "- Follow-ups about a plan: answer from the plan's fields, as given. Never calculate a cost, rate or",
        "  amount yourself; the tariff is banded, so cost is not proportional to use. For another date or",
        "  amount, call the tool again.",
        "- 'Just the energy', 'without fixed charges': energyOnlyBDT, VAT included.",
        "- The balance is spent first, then the recharge covers the days after it runs out. The amounts",
        "  already allow for that; never subtract the balance again.",
        "- Fixed charges: every month has one, even with no use or no recharge. It is never taken from the",
        "  balance; the next recharge pays every unpaid month first, before any power. Paying now or later",
        "  costs the same in total: only which recharge pays each month's charge changes. No late fee.",
        "- howItWasWorkedOut is background for you. Quote it only if asked about the method in general.",
        "",
        "Conversation:",
        "- This is an ongoing chat. Read a short follow-up against what was just discussed. If the previous",
        "  messages were about particular dates or a particular period, then 'tariff koto?', 'ar oi din?',",
        "  'eita koto kore?' and similar refer to those same dates, not to the month as a whole.",
        "- 'koto kore keteche' / 'koto kore' asks for the rate per unit (BDT per kWh), not the total cost.",
        "- 'history', 'itihash', 'record' or 'log' on its own, in any language, means daily usage: call",
        "  get_daily_usage. Recharge history only when they say recharge, top-up, load or payment.",
        "- If a period has no recharges, say so and give the last one before it (lastRechargeBeforeThis).",
        "- Answer the question asked and stop. Do not repeat a full breakdown the user has already been",
        "  given; give the specific figure, and at most one line of context.",
        "",
        // Decided in code from the user's message, so it does not drift to
        // whatever language the earlier turns happened to be in.
        language === "bn"
            ? "Language: the user's latest message is in Bangla or Banglish. Reply in Bangla script (বাংলা), never in Banglish or English."
            : "Language: the user's latest message is not in Bangla. Reply in the language it is written in: " +
              "English, or another language such as German or Swedish if it is clearly that. If it is " +
              "Bangla typed in English letters, reply in Bangla script. Never follow the language of earlier messages.",
        // Converting to Bangla numerals is where figures went wrong: the
        // month's 1112.15 BDT came out as ১১২.১৫.
        "Keep numbers, dates, 'kWh' and 'BDT' as they are. Write every number with the digits 0-9 exactly as",
        "the tool gave it, even in a Bangla reply; never convert it to Bangla numerals (০-৯).",
        "",
        "Formatting. Replies are sent as Telegram HTML:",
        "- Allowed: <b>bold</b>, <i>italic</i>, <code>code</code>, <pre>block</pre>. Nothing else.",
        "- Never use markdown: no *, **, #, backticks, '- ' bullets or | tables. Telegram shows those as",
        "  literal symbols.",
        "- For a short list, start each line with '• '.",
        "- To show more than 3 days of figures, put the displayTable token from get_daily_usage on its own",
        "  line, exactly as given (for example [[BLOCK_2]]). The bot replaces it with an aligned table of",
        "  date, kWh, BDT and tariff. Do not also write those rows yourself.",
        "- A displayCard token goes on its own line exactly as given, like displayTable.",
        "- When the user asks to be sent their reminder or an update now, call show_balance_update and put",
        "  its displayMessage token on its own line. You can send it; do not say you cannot. Add at most one",
        "  short line of your own around it.",
        "- For 1 to 3 days, give the figures in a sentence.",
        "- Be brief and concrete, a few short lines.",
        "- Never mention tool, function or field names to the user; say what the numbers mean instead.",
        "",
        role === "admin"
            ? "This user is the bot administrator and may ask about registered users and bot statistics."
            : "This user is a regular user. You can only see their own account. If they ask about other users" +
              " or bot-wide statistics, tell them that is not available to them.",
    ].join("\n");
}

export interface AiReply {
    /** The reply to send, with table tokens replaced by their tables. */
    text: string;
    toolsUsed: string[];
}

const FALLBACK = {
    unclear: {
        en: "Sorry, I couldn't work that one out.",
        bn: "দুঃখিত, এটা বুঝতে পারলাম না।",
    },
    tooManySteps: {
        en: "I couldn't finish working that out. Could you ask it a bit more specifically?",
        bn: "পুরোটা বের করতে পারলাম না। আরেকটু নির্দিষ্ট করে জিজ্ঞেস করবেন?",
    },
};

/**
 * The language and estimate instructions, attached to the user's own message for the turn.
 *
 * The same rule in the system instructions was not enough: after a Bangla
 * exchange, "thank you. keep me daily updated" was still answered in Bangla.
 * An instruction inside the latest user turn is the one the model weighs most.
 */
function turnDirective(language: ReplyLanguage): string {
    const reply = language === "bn"
        ? "Reply in Bangla script (বাংলা)."
        : "Reply in the language of this message, not Bangla.";
    // Here for the same reason as the language: in the system instructions
    // alone, a one-line follow-up gave "about 1250 BDT" with no assumption.
    return `[${reply} Any estimate you give says what it assumes.]`;
}

const EMPTY_REPLY_NUDGE: Content = {
    role: "user",
    parts: [{
        text: "[Your reply was empty. Answer the user's latest message now, calling a tool if it needs figures.]",
    }],
};

/**
 * Asks once for the same reply in the right language. A safety net for when
 * the model follows the conversation's earlier language instead of the
 * instruction; it costs an extra call only when that has happened.
 */
async function rewriteInLanguage(
    ai: GoogleGenAI,
    contents: Content[],
    text: string,
    language: ReplyLanguage,
    systemInstructionText: string
): Promise<string | null> {
    const target = language === "bn"
        ? "Bangla script (বাংলা)"
        : "the language of my latest message (English unless it is clearly another language), not Bangla";
    const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
            ...contents,
            { role: "model", parts: [{ text }] },
            {
                role: "user",
                parts: [{
                    text:
                        `Rewrite your last reply in ${target}. Keep every number, date and [[BLOCK_n]] token exactly, ` +
                        "and the same meaning. Output only the rewritten reply.",
                }],
            },
        ],
        // No tools: this is a rewrite, not a new lookup.
        config: { systemInstruction: systemInstructionText, temperature: 0.2 },
    });

    const rewritten = response.text?.trim();
    return rewritten && isInLanguage(rewritten, language) ? rewritten : null;
}

/**
 * Answers one message, letting the model call tools as needed.
 *
 * Conversation history lives on the session, tool calls and results included,
 * so a follow-up can build on the figures the previous answer used.
 */
export async function askGemini(
    message: string,
    session: Session,
    ctx: Omit<ToolContext, "session" | "language">,
    language: ReplyLanguage
): Promise<AiReply> {
    const ai = getClient();
    const toolsUsed: string[] = [];

    const contents: Content[] = [
        ...session.history,
        { role: "user", parts: [{ text: message }, { text: turnDirective(language) }] },
    ];

    const instructions = systemInstruction(ctx.role, language);
    const config = {
        systemInstruction: instructions,
        tools: [{ functionDeclarations: declarationsForRole(ctx.role) }],
        temperature: 0.3,
    };

    let emptyRetries = 0;
    let nudgeEmpty = false;
    /** Recharge card tokens produced this turn. */
    const cards: string[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        // The retry after an empty reply carries a nudge. Sent unchanged, it
        // came back empty again: after the bot asked "how much?", the answer
        // "1 october e 500" got the fallback twice. The nudge is not kept in
        // the history.
        const request = nudgeEmpty ? [...contents, EMPTY_REPLY_NUDGE] : contents;
        nudgeEmpty = false;
        const response = await ai.models.generateContent({ model: MODEL, contents: request, config });

        const calls = response.functionCalls ?? [];

        // Now and then the model returns neither text nor a tool call, and
        // "my balances" got the fallback reply. Asking again answers it.
        if (calls.length === 0 && !response.text?.trim() && emptyRetries < MAX_EMPTY_RETRIES) {
            emptyRetries += 1;
            nudgeEmpty = true;
            console.warn(`Empty reply (finish: ${response.candidates?.[0]?.finishReason ?? "unknown"}); asking again`);
            round -= 1;
            continue;
        }

        if (calls.length === 0) {
            let text = response.text?.trim() || FALLBACK.unclear[language];

            // A recharge card is the whole answer. Around it the model restated
            // the card in its own words, in Bangla digits, or trailed off with
            // half a sentence; so when it used a card, only the cards are sent.
            const shown = cards.filter((token) => text.includes(token));
            if (shown.length > 0) text = shown.join("\n\n");

            if (!isInLanguage(text, language)) {
                const rewritten = await rewriteInLanguage(ai, contents, text, language, instructions);
                console.warn(`Reply was not in ${language}; rewrite ${rewritten ? "succeeded" : "failed"}`);
                if (rewritten) text = rewritten;
            }

            // The whole turn is kept, tool calls and results included. Keeping
            // only the final text meant a follow-up such as "and the rate on
            // those days?" reached the model with none of the figures the
            // previous answer was built from.
            appendHistory(session, [
                ...contents.slice(session.history.length),
                { role: "model", parts: [{ text }] },
            ]);

            // History keeps the token, which is short; the user gets the block.
            return { text: expandDisplays(session, text), toolsUsed };
        }

        // Record the model's request, then answer every call before looping.
        // The model's own content is passed back untouched where available, so
        // any thought signatures attached to the calls survive the round trip.
        contents.push(
            response.candidates?.[0]?.content ?? {
                role: "model",
                parts: calls.map((call) => ({ functionCall: call })),
            }
        );

        const responses = await Promise.all(
            calls.map(async (call) => {
                const name = call.name ?? "";
                toolsUsed.push(name);

                const result = await executeTool(name, call.args, { ...ctx, session, language });
                const card = (result as { displayCard?: unknown } | null)?.displayCard;
                if (typeof card === "string") cards.push(card);
                return { functionResponse: { name, response: { result } } };
            })
        );

        contents.push({ role: "user", parts: responses });
    }

    // Tool rounds exhausted: keep the fetched data but do not claim an answer.
    return { text: FALLBACK.tooManySteps[language], toolsUsed };
}
