import axios from "axios";
import dotenv from "dotenv";
import https from "https";

dotenv.config();

export interface DescoResponse {
    balance: number;
    currentMonthConsumption: number;
    readingTime: string;
}

export interface FetchBalanceParams {
    accountNo?: string;
    meterNo?: string;
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

        console.log(`Fetching from: ${fullUrl}`);

        const { data } = await axios.get(fullUrl, {
            timeout: 15000, // Increased timeout to 15 seconds
            httpsAgent: new https.Agent({
                rejectUnauthorized: false
            }),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache',
                'Referer': 'https://prepaid.desco.org.bd/',
                'Origin': 'https://prepaid.desco.org.bd'
            },
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        });

        console.log(`API Response from ${url}:`, JSON.stringify(data));

        if (data.code === 200 && data.data) {
            const { balance, currentMonthConsumption, readingTime } = data.data;

            // Validate data fields
            if (balance !== null && balance !== undefined &&
                currentMonthConsumption !== null && currentMonthConsumption !== undefined &&
                readingTime) {
                return { balance, currentMonthConsumption, readingTime };
            } else {
                console.warn(`Incomplete data from ${url}:`, data.data);
                return null;
            }
        } else if (data.code) {
            console.warn(`API returned code ${data.code}:`, data.message || data);
        }

        return null;
    } catch (error: any) {
        console.error(`Error fetching from ${url}:`, error.message);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
        return null;
    }
}

export async function fetchBalance(params?: FetchBalanceParams): Promise<{
    success: boolean;
    data?: DescoResponse;
    error?: string;
    attemptedUrls?: string[];
    apiResponses?: any[]; // Store actual API responses for debugging
}> {
    // Require params to be provided
    if (!params) {
        return { success: false, error: "Account parameters are required" };
    }

    const { accountNo, meterNo } = params;

    // Both cannot be empty
    if (!accountNo && !meterNo) {
        return { success: false, error: "Either Account Number or Meter Number is required" };
    }

    console.log(`Fetching balance for Account: ${accountNo || 'N/A'}, Meter: ${meterNo || 'N/A'}`);

    const attemptedUrls: string[] = [];
    const apiResponses: any[] = [];

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
            console.log(`✅ Successfully fetched balance for ${accountNo || meterNo}`);
            return { success: true, data: result };
        } else {
            // Store the failed attempt
            apiResponses.push({
                endpoint,
                params: { accountNo, meterNo }
            });
        }
    }

    console.error(`❌ All API endpoints failed for Account: ${accountNo}, Meter: ${meterNo}`);

    return {
        success: false,
        error: "Failed to fetch balance from both API endpoints",
        attemptedUrls,
        apiResponses
    };
}