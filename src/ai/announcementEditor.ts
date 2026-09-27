import { getClient, MODEL } from "./gemini";
import { sanitizeTelegramHtml } from "./telegramHtml";

export async function rewriteAnnouncement(current: string, request: string): Promise<string> {
    const response = await getClient().models.generateContent({
        model: MODEL,
        contents: [
            {
                role: "user",
                parts: [{
                    text:
                        "Apply the admin's requested change to this Telegram announcement. " +
                        "Keep every fact and feature unless asked to drop it. " +
                        "Do not invent features. " +
                        "Output only the announcement in Telegram HTML " +
                        "(<b>, <i>, <code>, <a> only, no Markdown, no code fences, no preamble).\n\n" +
                        `Announcement:\n${current}\n\nRequested change:\n${request}`,
                }],
            },
        ],
        config: { temperature: 0.3 },
    });

    const result = sanitizeTelegramHtml(response.text?.trim() ?? "");
    if (!result) throw new Error("The rewrite came back empty.");
    return result;
}
