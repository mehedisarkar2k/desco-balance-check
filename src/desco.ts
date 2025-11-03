import axios from "axios";
import dotenv from "dotenv";
import https from "https";

dotenv.config();

const { ACCOUNT_NO, METER_NO } = process.env;

export interface DescoResponse {
    balance: number;
    currentMonthConsumption: number;
    readingTime: string;
}

export interface FetchBalanceParams {
    accountNo?: string;
    meterNo?: string;
    useDefaults?: boolean; // Flag to indicate whether to use env defaults
}

const API_ENDPOINTS = [
    "https://prepaid.desco.org.bd/api/unified/customer/getBalance",
    "https://prepaid.desco.org.bd/api/tkdes/customer/getBalance"
];

async function tryFetchFromEndpoint(url: string, params: FetchBalanceParams): Promise<DescoResponse | null> {
    try {
        const queryParams = new URLSearchParams();
        if (params.accountNo) {
            queryParams.append("accountNo", params.accountNo);
        }
        if (params.meterNo) {
            queryParams.append("meterNo", params.meterNo);
        }

        const fullUrl = `${url}?${queryParams.toString()}`;
        const { data } = await axios.get(fullUrl, {
            timeout: 10000,
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            })
        });

        if (data.code === 200 && data.data) {
            const { balance, currentMonthConsumption, readingTime } = data.data;
            return { balance, currentMonthConsumption, readingTime };
        }
        return null;
    } catch (error) {
        return null;
    }
}

export async function fetchBalance(params?: FetchBalanceParams): Promise<{
    success: boolean;
    data?: DescoResponse;
    error?: string;
    attemptedUrls?: string[];
}> {
    // If useDefaults is true or params is undefined, use env variables as fallback
    const useEnvDefaults = !params || params.useDefaults;

    const accountNo = params?.accountNo || (useEnvDefaults ? ACCOUNT_NO : undefined);
    const meterNo = params?.meterNo || (useEnvDefaults ? METER_NO : undefined);

    // Both cannot be empty
    if (!accountNo && !meterNo) {
        return { success: false, error: "Either Account Number or Meter Number is required" };
    }

    const attemptedUrls: string[] = [];

    // Try both endpoints
    for (const endpoint of API_ENDPOINTS) {
        const queryParams = new URLSearchParams();
        if (accountNo) {
            queryParams.append("accountNo", accountNo);
        }
        if (meterNo) {
            queryParams.append("meterNo", meterNo);
        }
        const fullUrl = `${endpoint}?${queryParams.toString()}`;
        attemptedUrls.push(fullUrl);

        const result = await tryFetchFromEndpoint(endpoint, { accountNo, meterNo });
        if (result) {
            return { success: true, data: result };
        }
    }

    return {
        success: false,
        error: "Failed to fetch balance from both API endpoints",
        attemptedUrls
    };
}