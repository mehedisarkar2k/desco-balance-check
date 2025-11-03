import axios from "axios";
import dotenv from "dotenv";
dotenv.config();
const { API_URL, ACCOUNT_NO, METER_NO } = process.env;
export async function fetchBalance() {
    if (!API_URL || !ACCOUNT_NO || !METER_NO) {
        throw new Error("Missing DESCO configuration in .env");
    }
    const url = `${API_URL}?accountNo=${ACCOUNT_NO}&meterNo=${METER_NO}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    if (data.code !== 200 || !data.data) {
        throw new Error(`Unexpected API response: ${JSON.stringify(data)}`);
    }
    const { balance, currentMonthConsumption, readingTime } = data.data;
    return { balance, currentMonthConsumption, readingTime };
}
