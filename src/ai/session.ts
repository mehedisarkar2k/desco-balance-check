import type { Content } from "@google/genai";

/**
 * How long a conversation stays "the same session". Coming back after this
 * gap starts a fresh one: history is dropped and DESCO is queried again.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** Turns kept for context. Older turns are dropped to bound prompt size. */
const MAX_HISTORY_TURNS = 20;

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
 * Runs `loader` only the first time a key is requested in a session, and
 * returns the stored value afterwards.
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
    session.cache.set(key, value);
    session.apiCalls += 1;

    return value;
}

export function appendHistory(session: Session, entries: Content[]) {
    session.history.push(...entries);

    if (session.history.length > MAX_HISTORY_TURNS * 2) {
        session.history = session.history.slice(-MAX_HISTORY_TURNS * 2);
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
