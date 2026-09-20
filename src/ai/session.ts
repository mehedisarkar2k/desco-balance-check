import type { Content } from "@google/genai";

/**
 * How long a conversation stays "the same session". Coming back after this
 * gap starts a fresh one: history is dropped and DESCO is queried again.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Turns kept for context. Older turns are dropped to bound prompt size. */
const MAX_HISTORY_TURNS = 12;

export interface Session {
    userId: number;
    startedAt: number;
    lastActiveAt: number;
    history: Content[];
    /**
     * DESCO responses fetched during this session.
     *
     * DESCO publishes one reading per day, so re-fetching within a
     * conversation would return identical data. Caching per session means a
     * multi-turn chat costs one call per kind of data rather than one per
     * question.
     */
    cache: Map<string, unknown>;
    /** Calls actually made to DESCO this session, for observability. */
    apiCalls: number;
}

const sessions = new Map<number, Session>();

function createSession(userId: number, now: number): Session {
    return {
        userId,
        startedAt: now,
        lastActiveAt: now,
        history: [],
        cache: new Map(),
        apiCalls: 0,
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

/**
 * A tool result that should not be kept for the session: a failure, or a saved
 * copy served because DESCO was down. Either would otherwise be replayed for
 * the rest of the chat after DESCO had recovered.
 */
function isFailure(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    return "error" in (value as object) || "savedCopy" in (value as object);
}

/**
 * Runs `loader` only the first time a key is requested in a session, and
 * returns the stored value afterwards.
 *
 * Failures are deliberately not stored. DESCO times out intermittently, and
 * caching the error would keep serving it for the rest of the session: a user
 * who asked again a minute later would get the same stale failure even once
 * DESCO had recovered. Retrying a failed lookup costs one request; caching it
 * costs the user the whole session.
 */
export async function cached<T>(
    session: Session,
    key: string,
    loader: () => Promise<T>
): Promise<T> {
    if (session.cache.has(key)) {
        return session.cache.get(key) as T;
    }

    const value = await loader();
    session.apiCalls += 1;

    if (!isFailure(value)) {
        session.cache.set(key, value);
    }

    return value;
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
