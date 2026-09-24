/**
 * Escapes text for Telegram's HTML parse mode. A single stray "<" or "&" in a
 * name, an error message or a DESCO status makes Telegram reject the whole
 * message, so anything not written by the bot itself goes through this.
 */
export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** An account or meter number reduced to its last digits, for logs. */
export function maskNumber(value?: string | null): string {
    return value ? `…${value.slice(-3)}` : "N/A";
}
