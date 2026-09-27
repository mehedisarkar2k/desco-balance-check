import { Context } from "telegraf";
import { UserService } from "../services/UserService";
import { verifyDescoNumber } from "../desco";
import { refreshSchedules } from "../scheduler";
import { performBalanceCheck } from "../utils/balanceChecker";
import { asciiDigits } from "../utils/times";
import { userLanguage } from "../ai/language";
import {
    NumberKind,
    askNumberText,
    checkingNumberText,
    notANumberText,
    numberNotFoundText,
    numberUpdatedText,
    descoUnreachableText,
    sendNumberText,
    welcomeText,
} from "../utils/onboardingText";
import { userSessions } from "./commands";
import { userIdOf } from "../services/SupportService";

/**
 * One number step, asked for three reasons: "setup_number" saves the user's
 * first number, "update_number" replaces the saved one, "one_off_number" only
 * checks a number without saving it.
 */
export type NumberStep = "setup_number" | "update_number" | "one_off_number";

export function isNumberStep(step: string): step is NumberStep {
    return step === "setup_number" || step === "update_number" || step === "one_off_number";
}

/** Asks for the number and records the step the answer will be read against. */
export async function startNumberStep(ctx: Context, step: NumberStep): Promise<void> {
    const userId = userIdOf(ctx);
    if (!userId) return;

    const language = userLanguage(await UserService.getUser(userId), ctx);
    const prompt = step === "setup_number" ? askNumberText(language) : sendNumberText(language);

    await ctx.reply(prompt, { parse_mode: "HTML" });
    userSessions.set(userId, { step });
}

function balanceParams(kind: NumberKind, number: string) {
    return kind === "account" ? { accountNo: number } : { meterNo: number };
}

/** Reads the answer to a number step: verifies it with DESCO, then acts on it. */
export async function handleNumberStep(ctx: Context, step: NumberStep, text: string): Promise<void> {
    const userId = userIdOf(ctx);
    if (!userId) return;

    const user = await UserService.getUser(userId);
    const language = userLanguage(user, ctx);

    const number = asciiDigits(text).replace(/[\s-]/g, "");
    if (!/^\d{6,14}$/.test(number)) {
        await ctx.reply(notANumberText(language), { parse_mode: "HTML" });
        return;
    }

    await ctx.reply(checkingNumberText(language));

    // Meter numbers have 12 digits, so a 12-digit input is tried as a meter
    // first; any other length fits an account better.
    const kinds: NumberKind[] = number.length === 12 ? ["meter", "account"] : ["account", "meter"];

    let found: NumberKind | null = null;
    for (const kind of kinds) {
        const outcome = await verifyDescoNumber(balanceParams(kind, number));
        if (outcome === "found") {
            found = kind;
            break;
        }
        if (outcome === "unreachable") {
            await ctx.reply(descoUnreachableText(language));
            return;
        }
    }

    if (!found) {
        await ctx.reply(numberNotFoundText(language, number), { parse_mode: "HTML" });
        // Re-set so the step's expiry clock starts over.
        userSessions.set(userId, { step });
        return;
    }

    if (step === "setup_number") {
        await UserService.setDescoNumber(userId, found, number);
        await UserService.enableDefaultAlerts(userId);
        await refreshSchedules();
        userSessions.delete(userId);

        await performBalanceCheck(ctx, balanceParams(found, number));
        await ctx.reply(
            welcomeText(language, {
                kind: found,
                number,
                time: "09:00",
                thresholdTaka: user?.threshold ?? 100,
                thresholdDays: user?.thresholdDays ?? 3,
            }),
            { parse_mode: "HTML" }
        );
        return;
    }

    if (step === "update_number") {
        await UserService.setDescoNumber(userId, found, number);
        userSessions.delete(userId);

        await ctx.reply(numberUpdatedText(language), { parse_mode: "HTML" });
        await performBalanceCheck(ctx, balanceParams(found, number));
        return;
    }

    userSessions.delete(userId);
    await performBalanceCheck(ctx, balanceParams(found, number));
}
