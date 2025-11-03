import * as cron from "node-cron";
import { fetchBalance } from "./desco";
import { sendMessage } from "./bot";
const threshold = Number(process.env.THRESHOLD) || 100;
let hourlyTask = null;
function formatMsg(balance, consumption, readingTime, prefix = "") {
    const head = prefix ? `<b>${prefix}</b>\n` : "";
    return `${head}<b>DESCO Balance:</b> <code>${balance.toFixed(2)}</code>\n` +
        `Consumption: <code>${consumption.toFixed(3)}</code>\n` +
        `Reading: <code>${readingTime}</code>`;
}
async function checkAndNotify(prefix = "") {
    try {
        const { balance, currentMonthConsumption, readingTime } = await fetchBalance();
        await sendMessage(formatMsg(balance, currentMonthConsumption, readingTime, prefix));
        if (balance <= threshold) {
            await sendMessage(`<b>⚠️ Low balance (≤ ${threshold})</b> — hourly alerts ON`);
            enableHourlyAlerts();
        }
        else {
            disableHourlyAlerts();
        }
    }
    catch (err) {
        await sendMessage(`<b>❌ Error checking DESCO:</b> ${err.message}`);
    }
}
function enableHourlyAlerts() {
    if (hourlyTask)
        return;
    hourlyTask = cron.schedule("0 * * * *", () => checkAndNotify("Hourly check"), {
        timezone: process.env.TZ || "Asia/Dhaka"
    });
    hourlyTask.start();
}
function disableHourlyAlerts() {
    if (hourlyTask) {
        hourlyTask.stop();
        hourlyTask = null;
    }
}
// Daily scheduled checks: 8AM & 4PM
export function startScheduler() {
    cron.schedule("0 8,16 * * *", () => checkAndNotify("Scheduled"), {
        timezone: process.env.TZ || "Asia/Dhaka",
    });
    checkAndNotify("Startup");
}
