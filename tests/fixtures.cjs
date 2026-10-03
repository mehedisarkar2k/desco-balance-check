// Never load real credentials or connect to production from the regression suite.
require('dotenv').config = () => ({ parsed: {} });
process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
process.env.TELEGRAM_CHAT_ID = '932626321';
process.env.GEMINI_API_KEY = 'test-key';
process.env.TZ = 'Asia/Dhaka';

const { shiftDate } = require('../dist/utils/dates');

function report() {
    const rows = [{ date: '2026-08-31', consumedUnit: 1000, consumedTaka: 1200 }];
    let lifetime = 1000;
    let monthUnits = 0;
    // Synthetic progressive tariff, deliberately nonlinear at 75 kWh.
    for (let date = '2026-09-01'; date <= '2026-10-03'; date = shiftDate(date, 1)) {
        if (date.endsWith('-01')) monthUnits = 0;
        const units = date >= '2026-09-29' ? 8 : 6.89;
        lifetime += units;
        monthUnits += units;
        rows.push({ date, consumedUnit: lifetime, consumedTaka: Math.min(monthUnits, 75) * 5 + Math.max(0, monthUnits - 75) * 9 });
    }
    return {
        success: true,
        report: {
            data: { balance: 1546.15, readingTime: '2026-10-04', currentMonthTaka: 120 },
            usage: { kwhPerDay: 6.89, sampleDays: 14 },
            rows,
            recharges: [],
            terms: { energyShare: 0.958, monthlyChargeBDT: 176, lastRechargeMonth: '2026-09', derived: true },
            pending: { months: ['2026-10'], amountBDT: 176 },
        },
    };
}

module.exports = { report };
