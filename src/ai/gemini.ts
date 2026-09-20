import { GoogleGenAI } from "@google/genai";
import type { Content } from "@google/genai";
import dotenv from "dotenv";
import { Session, appendHistory } from "./session";
import { Role, ToolContext, declarationsForRole, executeTool } from "./tools";

dotenv.config();

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/** Ceiling on tool round trips, so a model that keeps calling tools terminates. */
const MAX_TOOL_ROUNDS = 6;

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

function systemInstruction(role: Role, today: string): string {
    return [
        "You are the assistant inside a Telegram bot for DESCO prepaid electricity customers in Dhaka, Bangladesh.",
        `Today is ${today}.`,
        "",
        "Answer questions about the user's electricity: balance, how long it will last, daily and monthly",
        "consumption, and recharge history. Always call a tool to get real figures. Never invent numbers,",
        "and if a tool returns an error, say plainly what could not be fetched.",
        "",
        "Facts about this data that you must respect:",
        "- Amounts are in BDT (Taka) and consumption in kWh. DESCO's own field named 'currentMonthConsumption'",
        "  is a cost in BDT, not energy.",
        "- DESCO publishes one reading per day, so the balance does not change through the day.",
        "- The tariff is banded and resets on the 1st of each month. The same kWh costs noticeably less early",
        "  in a month than late in it, so comparing the cost of two days in different parts of a month is",
        "  misleading. Compare kWh when the question is about how much power was used.",
        "- In daily usage results, a row with coversDays greater than 1 is a total for several days because",
        "  DESCO skipped readings. Never present it as a single day's usage.",
        "- daysRemaining and runoutDate are a forecast, not a fact. They assume consumption continues at the",
        "  recent average and price it against the slab rates, including the reset on the 1st. Whenever you",
        "  give either figure, say in the same breath that it is an estimate based on recent usage and will",
        "  change if usage changes. Never state it as a certainty or a date power will definitely be cut.",
        "- When advising how much to recharge, remember the slab resets on the 1st: consumption early in a",
        "  month is billed far more cheaply, and staying under the lifeline allowance prices the whole month",
        "  at the lowest rate. Advice given from the current late-month rate alone will overstate the cost.",
        "",
        "Style: reply in the language the user wrote in, including Banglish. Be brief and concrete, a few short",
        "lines. Telegram HTML is supported for <b>bold</b>, <i>italic</i> and <code>code</code>; do not use",
        "markdown, headings or tables.",
        "",
        role === "admin"
            ? "This user is the bot administrator and may ask about registered users and bot statistics."
            : "This user is a regular user. You can only see their own account. If they ask about other users" +
              " or bot-wide statistics, tell them that is not available to them.",
    ].join("\n");
}

export interface AiReply {
    text: string;
    toolsUsed: string[];
    /** DESCO calls made this session, including earlier turns. */
    apiCalls: number;
}

/**
 * Answers one message, letting the model call tools as needed.
 *
 * Conversation history and any DESCO data fetched live on the session, so a
 * follow-up question reuses what the previous turn already retrieved.
 */
export async function askGemini(
    message: string,
    session: Session,
    ctx: Omit<ToolContext, "session">
): Promise<AiReply> {
    const ai = getClient();
    const toolsUsed: string[] = [];

    const contents: Content[] = [
        ...session.history,
        { role: "user", parts: [{ text: message }] },
    ];

    const config = {
        systemInstruction: systemInstruction(ctx.role, new Date().toISOString().slice(0, 10)),
        tools: [{ functionDeclarations: declarationsForRole(ctx.role) }],
        temperature: 0.3,
    };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await ai.models.generateContent({ model: MODEL, contents, config });

        const calls = response.functionCalls ?? [];
        if (calls.length === 0) {
            const text = response.text?.trim() || "Sorry, I couldn't work that one out.";

            appendHistory(session, [
                { role: "user", parts: [{ text: message }] },
                { role: "model", parts: [{ text }] },
            ]);

            return { text, toolsUsed, apiCalls: session.apiCalls };
        }

        // Record the model's request, then answer every call before looping.
        contents.push({
            role: "model",
            parts: calls.map((call) => ({ functionCall: call })),
        });

        const responses = await Promise.all(
            calls.map(async (call) => {
                const name = call.name ?? "";
                toolsUsed.push(name);

                const result = await executeTool(name, call.args, { ...ctx, session });
                return { functionResponse: { name, response: { result } } };
            })
        );

        contents.push({ role: "user", parts: responses });
    }

    // Tool rounds exhausted: keep the fetched data but do not claim an answer.
    return {
        text: "I couldn't finish working that out. Could you ask it a bit more specifically?",
        toolsUsed,
        apiCalls: session.apiCalls,
    };
}
