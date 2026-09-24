import axios from "axios";
import dotenv from "dotenv";
import https from "https";
import { AsyncLocalStorage } from "async_hooks";
import { cachedSeries, isFresh, markStale, readSnapshot, waitBriefly, writeSnapshot } from "./descoStore";
import { previousMonthInBillingZone, shiftDate, todayInBillingZone } from "./utils/dates";
import { maskNumber } from "./utils/html";

dotenv.config();

export interface DescoResponse {
    balance: number;
    /**
     * Month-to-date cost in BDT, NOT kWh. DESCO names this field
     * "currentMonthConsumption", which reads like energy but matches the
     * `consumedTaka` series from getCustomerDailyConsumption.
     */
    currentMonthTaka: number;
    readingTime: string;
}

export interface DailyConsumption {
    date: string;
    /** Month-to-date cost in BDT. Resets to ~0 on the 1st of each month. */
    consumedTaka: number;
    /** Lifetime meter reading in kWh. Only resets if the meter is replaced. */
    consumedUnit: number;
}

export interface RechargeRecord {
    orderID: string;
    /** "YYYY-MM-DD HH:mm:ss.S" in DESCO's response. */
    rechargeDate: string;
    totalAmount: number;
    /** Portion of totalAmount that actually became energy credit. */
    energyAmount: number;
    /** Demand charge, meter rent and VAT, less any rebate. */
    chargeAmount: number;
    rechargeOperator: string;
    orderStatus: string;
}

export interface FetchBalanceParams {
    accountNo?: string;
    meterNo?: string;
}

const API_BASE = "https://prepaid.desco.org.bd/api";

/**
 * An account lives on exactly one of these; the other answers with
 * code 16001 ("The Account No. does not exist").
 */
const API_PREFIXES = ["unified", "tkdes"];

/**
 * DESCO's API answers in about 10ms; the time goes into the TLS handshake on
 * its front-end, measured at 5-15s when it is struggling. A timeout shorter
 * than the handshake is the worst possible setting: it abandons a handshake
 * that was most of the way done and starts another from zero. So the timeout
 * is patient, and the saved copy in descoStore covers the case where even that
 * is not enough.
 */
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 700;

/**
 * A hard limit on one request, counted from when it is issued. axios's own
 * timeout only starts once the request has a connection, so requests queued
 * behind a stalled handshake waited far longer than it suggested, and one
 * stall held up every user queued behind it.
 */
const REQUEST_DEADLINE_MS = 30_000;

/**
 * DESCO's server does not send its intermediate certificate, so Node cannot
 * build the chain and fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. Kept as a
 * single shared agent rather than one per request.
 */
const httpsAgent = new https.Agent({
    rejectUnauthorized: false,
    keepAlive: true,
    // Few connections, kept open and reused. The handshake is the expensive
    // part, so calls share connections instead of each paying it. Two rather
    // than one, so a single stalled handshake cannot hold up everyone.
    maxSockets: 2,
});

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': 'https://prepaid.desco.org.bd/',
    'Origin': 'https://prepaid.desco.org.bd'
};

/**
 * Which prefix last served an account, so the one known to work is tried
 * first. An account does not move between prefixes, and the other answers
 * "The Account No. does not exist", which is misleading in logs and wastes a
 * full timeout when DESCO is slow.
 */
const prefixMemo = new Map<string, string>();

function memoKey(params: FetchBalanceParams): string {
    return `${params.accountNo ?? ""}:${params.meterNo ?? ""}`;
}

/** Prefixes to try, best guess first. */
function prefixesFor(params: FetchBalanceParams, forced?: string): string[] {
    if (forced) return [forced];

    const known = prefixMemo.get(memoKey(params));
    if (!known) return API_PREFIXES;

    return [known, ...API_PREFIXES.filter((prefix) => prefix !== known)];
}

/** A timeout or dropped connection, as opposed to DESCO answering with an error. */
function isTransient(error: any): boolean {
    if (error?.response) return false; // DESCO answered; not a network fault.
    // The hard deadline passed: the request already used its full time, and
    // retrying would only make the user wait that long again.
    if (error?.code === "ERR_CANCELED") return false;
    return (
        error?.code === "ECONNABORTED" ||
        error?.code === "ETIMEDOUT" ||
        error?.code === "ECONNRESET" ||
        /timeout/i.test(error?.message ?? "")
    );
}

function buildUrl(prefix: string, endpoint: string, query: Record<string, string | undefined>): string {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value) {
            queryParams.append(key, value);
        }
    }
    return `${API_BASE}/${prefix}/customer/${endpoint}?${queryParams.toString()}`;
}

/**
 * Counts requests actually sent to DESCO within a scope, such as one chat
 * turn. The chat log used to report cache misses as "descoCalls", which read
 * as DESCO traffic when most of it was served from the saved copy.
 */
const callCounter = new AsyncLocalStorage<{ count: number }>();

export async function countDescoCalls<T>(work: () => Promise<T>): Promise<{ result: T; calls: number }> {
    const counter = { count: 0 };
    const result = await callCounter.run(counter, work);
    return { result, calls: counter.count };
}

/** A number from DESCO, or NaN when it is missing, so a gap is never read as zero. */
function toNumber(value: unknown): number {
    return value === null || value === undefined || value === "" ? NaN : Number(value);
}

/** Requests in progress, so identical ones issued together share a single call. */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Calls one endpoint on one prefix. Returns the `data` payload, or null if the
 * request failed or DESCO answered with a non-200 code in the body.
 */
async function descoGet<T>(
    prefix: string,
    endpoint: string,
    query: Record<string, string | undefined>,
    retries = 0
): Promise<T | null> {
    const url = buildUrl(prefix, endpoint, query);

    // The overview, the chat tools and the scheduler often ask for the same
    // thing at once; the second caller waits on the first call instead of
    // queueing another one behind it.
    const pending = inFlight.get(url);
    if (pending) return pending as Promise<T | null>;

    const request = requestWithRetries<T>(url, prefix, endpoint, retries);
    inFlight.set(url, request);
    try {
        return await request;
    } finally {
        inFlight.delete(url);
    }
}

async function requestWithRetries<T>(url: string, prefix: string, endpoint: string, retries: number): Promise<T | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const counter = callCounter.getStore();
        if (counter) counter.count += 1;

        try {
            const { data } = await axios.get(url, {
                timeout: REQUEST_TIMEOUT_MS,
                signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
                httpsAgent,
                headers: REQUEST_HEADERS,
                validateStatus: (status) => status < 500,
            });

            if (data?.code === 200 && data.data) {
                return data.data as T;
            }

            // DESCO answered with a refusal; retrying would get the same answer.
            if (data?.code) {
                console.warn(`${prefix}/${endpoint} returned code ${data.code}: ${data.desc || data.message || ""}`);
            }
            return null;
        } catch (error: any) {
            const canRetry = attempt < retries && isTransient(error);
            console.error(
                `Error calling ${prefix}/${endpoint}:`,
                error.code === "ERR_CANCELED" ? `no answer within ${REQUEST_DEADLINE_MS / 1000}s` : error.message,
                canRetry ? "(retrying)" : ""
            );
            if (error.response) {
                console.error(`Response status: ${error.response.status}`);
            }
            if (!canRetry) return null;

            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    return null;
}

/**
 * How long a saved copy is served without asking DESCO again. The balance is
 * kept briefly: after a recharge people check straight away, and a 30-minute
 * copy showed them the balance from before it.
 */
const BALANCE_TTL_MS = 5 * 60 * 1000;
const RECHARGE_TTL_MS = 30 * 60 * 1000;
const DAILY_TTL_MS = 3 * 60 * 60 * 1000;
const MONTHLY_TTL_MS = 12 * 60 * 60 * 1000;
const CUSTOMER_INFO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How soon an incomplete copy is re-checked: a balance not yet dated today,
 * or a series missing its newest expected entry. Short enough that a reading
 * DESCO has just published shows up within minutes, long enough not to hit
 * DESCO on every request while it has not published yet.
 */
const INCOMPLETE_RETRY_MS = 5 * 60 * 1000;

export async function fetchBalance(params?: FetchBalanceParams): Promise<{
    success: boolean;
    data?: DescoResponse;
    /** The prefix that answered, so follow-up calls can skip the other one. */
    prefix?: string;
    error?: string;
    attemptedUrls?: string[];
}> {
    if (!params) {
        return { success: false, error: "Account parameters are required" };
    }

    const { accountNo, meterNo } = params;

    if (!accountNo && !meterNo) {
        return { success: false, error: "Either Account Number or Meter Number is required" };
    }

    const key = `balance:${memoKey(params)}`;
    const stored = await readSnapshot<{ data: DescoResponse; prefix: string }>(key);

    if (stored?.payload?.prefix) {
        // Survives restarts, so a fresh process does not rediscover the prefix.
        prefixMemo.set(memoKey(params), stored.payload.prefix);
    }

    // DESCO dates the balance with the current day. A copy still carrying an
    // earlier date is incomplete, so it is re-checked soon rather than served
    // for the full interval.
    const datedToday = (stored?.payload?.data?.readingTime ?? "") >= todayInBillingZone();
    const trustFor = datedToday ? BALANCE_TTL_MS : INCOMPLETE_RETRY_MS;

    if (stored && isFresh(stored.fetchedAt, trustFor)) {
        return { success: true, prefix: stored.payload.prefix, data: stored.payload.data };
    }

    const live = fetchLiveBalance(params, key);

    // With a saved copy to fall back on, a slow DESCO is not waited on in full:
    // the copy is shown, marked with its time, and the live fetch carries on
    // to refresh it for next time.
    const outcome = stored ? await waitBriefly(live) : await live;

    if (outcome !== "slow" && outcome.data) {
        return { success: true, prefix: outcome.prefix, data: outcome.data };
    }

    if (stored) {
        console.warn(`DESCO ${outcome === "slow" ? "slow" : "unavailable"}, serving saved balance from ${stored.fetchedAt.toISOString()}`);
        return {
            success: true,
            prefix: stored.payload.prefix,
            data: markStale({ ...stored.payload.data }, stored.fetchedAt),
        };
    }

    const attemptedUrls = outcome === "slow" ? [] : outcome.attemptedUrls;
    console.error(`❌ All API endpoints failed for account ${maskNumber(accountNo)}, meter ${maskNumber(meterNo)}`);

    return {
        success: false,
        error: "Failed to fetch balance from both API endpoints",
        attemptedUrls,
    };
}

/** Fetches the balance from DESCO and saves it. */
async function fetchLiveBalance(
    params: FetchBalanceParams,
    key: string
): Promise<{ data?: DescoResponse; prefix?: string; attemptedUrls: string[] }> {
    const { accountNo, meterNo } = params;
    console.log(`Fetching balance for account ${maskNumber(accountNo)}, meter ${maskNumber(meterNo)}`);

    const attemptedUrls: string[] = [];
    const prefixes = prefixesFor(params);

    for (const [index, prefix] of prefixes.entries()) {
        attemptedUrls.push(buildUrl(prefix, "getBalance", { accountNo, meterNo }));

        // Only the first prefix is retried, to keep the worst case bounded.
        const data = await descoGet<any>(prefix, "getBalance", { accountNo, meterNo }, index === 0 ? 1 : 0);
        if (!data) continue;

        const { balance, currentMonthConsumption, readingTime } = data;

        // currentMonthConsumption may legitimately be null early in a month.
        if (balance === null || balance === undefined || !readingTime) {
            console.warn(`Incomplete balance data from ${prefix}`);
            continue;
        }

        console.log(`✅ Fetched balance for ${maskNumber(accountNo || meterNo)} via ${prefix}`);
        prefixMemo.set(memoKey(params), prefix);

        const result: DescoResponse = {
            balance,
            currentMonthTaka: currentMonthConsumption ?? 0,
            // Date only. Every consumer treats this as a calendar date, and a
            // time part would be parsed in local time rather than UTC.
            readingTime: String(readingTime).slice(0, 10),
        };
        await writeSnapshot(key, { data: result, prefix });

        return { data: result, prefix, attemptedUrls };
    }

    return { attemptedUrls };
}

/**
 * Daily consumption rows for a date range, oldest first. Pass `prefix` from a
 * preceding fetchBalance call to avoid retrying the prefix that does not serve
 * this account.
 */
export async function fetchDailyConsumption(
    params: FetchBalanceParams,
    dateFrom: string,
    dateTo: string,
    prefix?: string
): Promise<DailyConsumption[] | null> {
    const query = {
        accountNo: params.accountNo,
        meterNo: params.meterNo,
        dateFrom,
        dateTo,
    };

    return cachedSeries<DailyConsumption>({
        key: `daily:${memoKey(params)}`,
        ttlMs: DAILY_TTL_MS,
        from: dateFrom,
        to: dateTo,
        // DESCO publishes a day's reading the next morning, so a complete copy
        // runs to yesterday.
        expectedLatest: shiftDate(todayInBillingZone(), -1),
        retryMs: INCOMPLETE_RETRY_MS,
        idOf: (row) => row.date,
        dateOf: (row) => row.date,
        sort: (a, b) => a.date.localeCompare(b.date),
        load: async () => {
            for (const candidate of prefixesFor(params, prefix)) {
                const rows = await descoGet<any[]>(candidate, "getCustomerDailyConsumption", query);

                // An account on the wrong prefix answers 200 with an empty list here.
                if (Array.isArray(rows) && rows.length > 0) {
                    // A missing reading must not become 0: Number(null) is 0,
                    // and one zero meter reading turned the next day into a
                    // 10,000 kWh day and the average with it.
                    return rows
                        .map((row) => ({
                            date: row.date,
                            consumedTaka: toNumber(row.consumedTaka),
                            consumedUnit: toNumber(row.consumedUnit),
                        }))
                        .filter((row) =>
                            Boolean(row.date) &&
                            Number.isFinite(row.consumedTaka) &&
                            Number.isFinite(row.consumedUnit) &&
                            row.consumedUnit > 0
                        );
                }
            }
            return null;
        },
    });
}

export interface CustomerInfo {
    customerName?: string;
    installationAddress?: string;
    tariffSolution?: string;
    sanctionLoad?: number;
    phaseType?: string;
    feederName?: string;
    meterModel?: string;
    installationDate?: string;
    SDName?: string;
}

export interface MonthlyConsumption {
    /** "YYYY-MM". */
    month: string;
    consumedTaka: number;
    consumedUnit: number;
    maximumDemand?: number;
}

/** Registered account details. Contains personal data, so handle with care. */
export async function fetchCustomerInfo(
    params: FetchBalanceParams,
    prefix?: string
): Promise<CustomerInfo | null> {
    const key = `customerInfo:${memoKey(params)}`;
    const stored = await readSnapshot<CustomerInfo>(key);

    if (stored && isFresh(stored.fetchedAt, CUSTOMER_INFO_TTL_MS)) {
        return stored.payload;
    }

    const query = { accountNo: params.accountNo, meterNo: params.meterNo };

    for (const candidate of prefixesFor(params, prefix)) {
        const data = await descoGet<CustomerInfo>(candidate, "getCustomerInfo", query);
        if (data) {
            await writeSnapshot(key, data);
            return data;
        }
    }

    return stored ? markStale({ ...stored.payload }, stored.fetchedAt) : null;
}

/** Monthly totals for the last `months` months, oldest first. */
export async function fetchMonthlyConsumption(
    params: FetchBalanceParams,
    months: number,
    prefix?: string
): Promise<MonthlyConsumption[] | null> {
    // Counted from the month in Dhaka. Using the UTC date, between midnight
    // and 06:00 on the 1st "last month" came out as the month before it.
    const [year, month] = previousMonthInBillingZone().split("-").map(Number);
    const to = new Date(Date.UTC(year, month - 1, 1));
    const from = new Date(Date.UTC(year, month - 1 - (months - 1), 1));
    const asMonth = (date: Date) => date.toISOString().slice(0, 7);

    const query = {
        accountNo: params.accountNo,
        meterNo: params.meterNo,
        monthFrom: asMonth(from),
        monthTo: asMonth(to),
    };

    return cachedSeries<MonthlyConsumption>({
        key: `monthly:${memoKey(params)}`,
        ttlMs: MONTHLY_TTL_MS,
        from: query.monthFrom,
        to: query.monthTo,
        expectedLatest: previousMonthInBillingZone(),
        retryMs: INCOMPLETE_RETRY_MS,
        idOf: (row) => row.month,
        dateOf: (row) => row.month,
        sort: (a, b) => a.month.localeCompare(b.month),
        load: async () => {
            for (const candidate of prefixesFor(params, prefix)) {
                const rows = await descoGet<any[]>(candidate, "getCustomerMonthlyConsumption", query);
                if (!Array.isArray(rows) || rows.length === 0) continue;

                return rows.map((row) => ({
                    month: row.month,
                    consumedTaka: Number(row.consumedTaka),
                    consumedUnit: Number(row.consumedUnit),
                    maximumDemand: row.maximumDemand ? Number(row.maximumDemand) : undefined,
                }));
            }
            return null;
        },
    });
}

/**
 * Recharges in a date range, newest first. Returns an empty array when the
 * account simply had no recharges, and null when the lookup failed.
 */
export async function fetchRechargeHistory(
    params: FetchBalanceParams,
    dateFrom: string,
    dateTo: string,
    prefix?: string
): Promise<RechargeRecord[] | null> {
    const query = {
        accountNo: params.accountNo,
        meterNo: params.meterNo,
        dateFrom,
        dateTo,
    };

    return cachedSeries<RechargeRecord>({
        key: `recharges:${memoKey(params)}`,
        ttlMs: RECHARGE_TTL_MS,
        from: dateFrom,
        to: dateTo,
        idOf: (row) => row.orderID,
        dateOf: (row) => row.rechargeDate.slice(0, 10),
        sort: (a, b) => b.rechargeDate.localeCompare(a.rechargeDate),
        load: async () => {
            // The system that does not hold an account can answer with an
            // empty list rather than an error, so an empty answer only counts
            // once every system has been asked.
            let answeredEmpty = false;
            for (const candidate of prefixesFor(params, prefix)) {
                const rows = await descoGet<any[]>(candidate, "getRechargeHistory", query);
                if (!Array.isArray(rows)) continue;
                if (rows.length === 0) {
                    answeredEmpty = true;
                    continue;
                }

                return rows.map((row) => ({
                    orderID: String(row.orderID),
                    rechargeDate: row.rechargeDate,
                    totalAmount: Number(row.totalAmount),
                    energyAmount: Number(row.energyAmount),
                    chargeAmount: Number(row.chargeAmount),
                    rechargeOperator: row.rechargeOperator,
                    orderStatus: row.orderStatus,
                }));
            }
            return answeredEmpty ? [] : null;
        },
    });
}
