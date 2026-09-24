import mongoose from "mongoose";
import { DescoSnapshot } from "./models/DescoSnapshot";

/**
 * Saved copies of DESCO data.
 *
 * DESCO publishes one reading a day and a past day's figures never change,
 * yet every command used to fetch everything live, so whenever DESCO's
 * front-end was slow every user request was slow or failed with it. Reads now
 * go through here: a recent copy is served without calling DESCO at all, and
 * when a live call fails the last good copy is served, marked as stale, rather
 * than an error.
 */

/** Values served from a saved copy because the live call failed. */
const staleMarks = new WeakMap<object, Date>();

/** When the data in a returned value was last fetched from DESCO. */
const fetchedMarks = new WeakMap<object, Date>();

/** When a value's data was last fetched from DESCO, if known. */
export function fetchedAtOf(value: unknown): Date | undefined {
    return value && typeof value === "object" ? fetchedMarks.get(value as object) : undefined;
}

function markFetched<T extends object>(value: T, at: Date): T {
    fetchedMarks.set(value, at);
    return value;
}

/** When a value was originally fetched, if it is a stale saved copy. */
export function staleAsOf(value: unknown): Date | undefined {
    return value && typeof value === "object" ? staleMarks.get(value as object) : undefined;
}

export function markStale<T extends object>(value: T, asOf: Date): T {
    staleMarks.set(value, asOf);
    return value;
}

/**
 * Scripts and tests run without a database. Mongoose would buffer the query
 * and hang for ten seconds, so the store is simply skipped when not connected.
 */
function dbReady(): boolean {
    return mongoose.connection.readyState === 1;
}

export interface Snapshot<T> {
    payload: T;
    coveredFrom?: string;
    fetchedAt: Date;
}

export async function readSnapshot<T>(key: string): Promise<Snapshot<T> | null> {
    if (!dbReady()) return null;
    try {
        const doc = await DescoSnapshot.findOne({ key }).lean();
        return doc ? { payload: doc.payload as T, coveredFrom: doc.coveredFrom, fetchedAt: doc.fetchedAt } : null;
    } catch (error: any) {
        console.error(`Snapshot read failed for ${key}:`, error.message);
        return null;
    }
}

export async function writeSnapshot(key: string, payload: unknown, coveredFrom?: string): Promise<void> {
    if (!dbReady()) return;
    try {
        await DescoSnapshot.updateOne(
            { key },
            { payload, fetchedAt: new Date(), ...(coveredFrom ? { coveredFrom } : {}) },
            { upsert: true }
        );
    } catch (error: any) {
        // Failing to save must never fail the request that fetched the data.
        console.error(`Snapshot write failed for ${key}:`, error.message);
    }
}

export function isFresh(fetchedAt: Date, ttlMs: number): boolean {
    return Date.now() - new Date(fetchedAt).getTime() < ttlMs;
}

interface SeriesOptions<T> {
    key: string;
    ttlMs: number;
    /** Inclusive range wanted, in the same string form `dateOf` returns. */
    from: string;
    to: string;
    idOf: (row: T) => string;
    dateOf: (row: T) => string;
    sort: (a: T, b: T) => number;
    load: () => Promise<T[] | null>;
    /**
     * The newest entry a complete copy must contain, such as yesterday's
     * reading. A saved copy missing it is re-checked with DESCO once `retryMs`
     * has passed, rather than being trusted for the whole `ttlMs`.
     */
    expectedLatest?: string;
    retryMs?: number;
}

/**
 * A dated series (daily readings, recharges, monthly totals) kept as one
 * growing set per account.
 *
 * Every successful fetch is merged into the saved set, so the history served
 * can reach back further than DESCO's own window. A request is answered from
 * the saved set when it has been fetched recently and already covers the
 * range; otherwise DESCO is asked, and if that fails whatever is saved for the
 * range is served as stale.
 */
export async function cachedSeries<T extends object>(options: SeriesOptions<T>): Promise<T[] | null> {
    const { key, ttlMs, from, to, idOf, dateOf, sort, load, expectedLatest, retryMs } = options;
    const inRange = (rows: T[]) => rows.filter((row) => dateOf(row) >= from && dateOf(row) <= to).sort(sort);

    const stored = await readSnapshot<T[]>(key);
    const storedRows = Array.isArray(stored?.payload) ? stored!.payload : [];
    const coversStart = Boolean(stored?.coveredFrom && stored.coveredFrom <= from);

    // Age alone does not make a copy good enough. A copy saved early in the
    // morning, before DESCO had published yesterday's reading, is young but
    // incomplete, and trusting it for hours meant the newest day stayed
    // missing all morning: the assistant then reported the day before as
    // "yesterday" and insisted yesterday had no reading. An incomplete copy is
    // only trusted until the short retry interval, so DESCO is asked again
    // soon, but not on every request while it has not published yet.
    const latestStored = storedRows.reduce((max, row) => (dateOf(row) > max ? dateOf(row) : max), "");
    const wantedEnd = expectedLatest && expectedLatest < to ? expectedLatest : to;
    const complete = !expectedLatest || latestStored >= wantedEnd;
    const trustFor = complete ? ttlMs : Math.min(retryMs ?? ttlMs, ttlMs);

    if (stored && coversStart && isFresh(stored.fetchedAt, trustFor)) {
        return markFetched(inRange(storedRows), new Date(stored.fetchedAt));
    }

    const live = await load();

    if (live !== null) {
        const merged = new Map<string, T>();
        for (const row of storedRows) merged.set(idOf(row), row);
        for (const row of live) merged.set(idOf(row), row);
        const rows = [...merged.values()];

        const coveredFrom = stored?.coveredFrom && stored.coveredFrom < from ? stored.coveredFrom : from;
        await writeSnapshot(key, rows, coveredFrom);

        return markFetched(inRange(rows), new Date());
    }

    const fallback = inRange(storedRows);
    if (stored && fallback.length > 0) {
        console.warn(`DESCO unavailable, serving saved ${key} from ${stored.fetchedAt.toISOString()}`);
        return markFetched(markStale(fallback, stored.fetchedAt), new Date(stored.fetchedAt));
    }

    return null;
}
