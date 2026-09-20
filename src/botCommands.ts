/**
 * The single source of truth for the bot's command list.
 *
 * Telegram stores the command menu on its own servers, so registering a
 * handler with `bot.command(...)` does not make it appear in the client. This
 * list is pushed with setMyCommands on startup and also renders /help, so the
 * menu, the help text and the handlers cannot drift apart.
 *
 * Kept free of imports so both the bot and the handlers can use it without a
 * circular dependency.
 */
export const BOT_COMMANDS = [
    { command: "start", description: "Set up your DESCO account and get started" },
    { command: "balance", description: "Check your current prepaid electricity balance" },
    { command: "usage", description: "Usage overview for the last N days" },
    { command: "me", description: "View your account details and subscription status" },
    { command: "update", description: "Update account info, notification times, or alerts" },
    { command: "subscribe", description: "Enable/disable automatic balance notifications" },
    { command: "help", description: "View all available commands and how to use them" },
] as const;

export function formatCommandList(exclude: string[] = []): string {
    return BOT_COMMANDS
        .filter(({ command }) => !exclude.includes(command))
        .map(({ command, description }) => `/${command} - ${description}`)
        .join("\n");
}
