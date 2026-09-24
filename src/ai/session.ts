import type { Content } from "@google/genai";
import type { ReplyLanguage } from "./language";

/**
 * How long a conversation stays "the same session". Coming back after this
 * gap starts a fresh one with no history. How often DESCO itself is asked is
 * decided by the saved-data store, not by the chat.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Turns kept for context. Older turns are dropped to bound prompt size. */
const MAX_HISTORY_TURNS = 12;

/** Display blocks kept per session, so a token repeated in a later reply still resolves. */
const MAX_DISPLAYS = 8;

export interface Session {
    userId: number;
    startedAt: number;
    lastActiveAt: number;
    history: Content[];
    /**
     * Pre-rendered blocks (a table of days, the balance update) handed to the
     * model as short tokens. The model writes the token and the bot substitutes
     * the block, so these always render exactly as the commands render them
     * instead of however the model chose to format them, and the rows do not
     * have to be generated token by token.
     *
     * DESCO data itself is deliberately not cached here. The saved-data store
     * decides freshness, and a second copy per chat held whatever the first
     * question returned for as long as the conversation stayed active --
     * including a copy that was missing the newest day.
     */
    displays: Map<string, string>;
    displaySeq: number;
    /** Language of the last message that had one, for a bare "23?" or emoji. */
    language: ReplyLanguage;
}

const sessions = new Map<number, Session>();

function createSession(userId: number, now: number): Session {
    return {
        userId,
        startedAt: now,
        lastActiveAt: now,
        history: [],
        displays: new Map(),
        displaySeq: 0,
        language: "en",
    };
}

/**
 * The caller's live session, starting a new one when the previous has gone
 * idle. Touching it also extends the window.
 */
export function getSession(userId: number): { session: Session; isNew: boolean } {
    const now = Date.now();
    const existing = sessions.get(userId);

    if (existing && now - existing.lastActiveAt < SESSION_IDLE_MS) {
        existing.lastActiveAt = now;
        return { session: existing, isNew: false };
    }

    const session = createSession(userId, now);
    sessions.set(userId, session);
    return { session, isNew: true };
}

/** Matches a display token in model output. */
export const DISPLAY_TOKEN = /\[\[BLOCK_\d+\]\]/g;

/** Registers a rendered block (finished HTML) and returns the token the model should write for it. */
export function registerDisplay(session: Session, html: string): string {
    session.displaySeq += 1;
    const token = `[[BLOCK_${session.displaySeq}]]`;
    session.displays.set(token, html);

    while (session.displays.size > MAX_DISPLAYS) {
        session.displays.delete(session.displays.keys().next().value as string);
    }
    return token;
}

/**
 * Replaces display tokens in a reply with their blocks. A token that no
 * longer resolves is dropped rather than shown to the user as "[[BLOCK_3]]".
 */
export function expandDisplays(session: Session, text: string): string {
    return text.replace(DISPLAY_TOKEN, (token) => session.displays.get(token) ?? "");
}

/** A message the user typed, as opposed to a tool result sent in the user role. */
function isUserText(content: Content): boolean {
    return content.role === "user" && Boolean(content.parts?.some((part) => typeof part.text === "string"));
}

export function appendHistory(session: Session, entries: Content[]) {
    session.history.push(...entries);

    // History now includes tool calls and their results, and the API rejects a
    // tool result whose call is missing. So old turns are dropped whole, by
    // cutting only at a message the user typed, never mid-turn.
    const turnStarts = session.history
        .map((content, index) => (isUserText(content) ? index : -1))
        .filter((index) => index >= 0);

    if (turnStarts.length > MAX_HISTORY_TURNS) {
        session.history = session.history.slice(turnStarts[turnStarts.length - MAX_HISTORY_TURNS]);
    }
}

export function resetSession(userId: number) {
    sessions.delete(userId);
}

/**
 * Drops sessions that have gone idle. Without this the maps would grow with
 * every user who ever chatted, since a process can run for weeks.
 */
export function pruneSessions(): number {
    const now = Date.now();
    let removed = 0;

    for (const [userId, session] of sessions) {
        if (now - session.lastActiveAt >= SESSION_IDLE_MS) {
            sessions.delete(userId);
            removed += 1;
        }
    }

    return removed;
}

export function activeSessionCount(): number {
    return sessions.size;
}
