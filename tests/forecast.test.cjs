const { report } = require('./fixtures.cjs');
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../dist/utils/usage');
const originalBalanceReport = usage.getBalanceReport;
const desco = require('../dist/desco');
const dates = require('../dist/utils/dates');
const { getSession, resetSession, expandDisplays } = require('../dist/ai/session');
const { executeTool, declarationsForRole } = require('../dist/ai/tools');
const { parseUsageOptions, resolveUsageScenario } = require('../dist/domain/usageScenario');
const { getClient, askGemini } = require('../dist/ai/gemini');

let ctx;
beforeEach(() => {
    resetSession(42);
    ctx = { userId: 42, role: 'user', accountNo: 'fixture', language: 'en', session: getSession(42).session };
    mock.method(dates, 'todayInBillingZone', () => '2026-10-04');
    mock.method(usage, 'getBalanceReport', async () => report());
});
afterEach(() => mock.restoreAll());

const run = (args) => executeTool('simulate_recharge', { amountBDT: 0, ...args }, ctx);
const card = (result) => expandDisplays(ctx.session, result.displayCard);

test('all forecast tools expose the three custom usage inputs', () => {
    for (const name of ['simulate_recharge', 'plan_recharge', 'estimate_month_bill']) {
        const declaration = declarationsForRole('user').find((d) => d.name === name);
        for (const key of ['dailyKwh', 'usageWindowDays', 'usageIncreasePercent']) {
            assert.ok(declaration.parameters.properties[key]);
        }
    }
});

test('7 kWh replaces 6.89 and is labelled as an assumption, not a historical average', async () => {
    const baseline = await run({});
    const result = await run({ dailyKwh: 7 });
    assert.equal(result.usageScenario.dailyKwh, 7);
    assert.equal(result.usageScenario.usageWindowDays, null);
    assert.ok(result.lastsUntilWithoutRecharge <= baseline.lastsUntilWithoutRecharge);
    assert.match(card(result), /7.00 kWh.*specified daily use/);
    assert.doesNotMatch(card(result), /14 days' average/);
    assert.match(card(result), /About \d+ days from today/);
    assert.equal(result.fixedChargesPaid.totalBDT, 0);
    assert.equal(result.powerBDT, 0);
});

test('1% and 3% increases reprice the daily consumption and do not extend runway', async () => {
    const baseline = await run({});
    const one = await run({ usageIncreasePercent: 1 });
    const three = await run({ usageIncreasePercent: 3 });
    assert.equal(one.usageScenario.dailyKwh, 6.89 * 1.01);
    assert.equal(three.usageScenario.dailyKwh, 6.89 * 1.03);
    assert.ok(one.lastsUntilWithoutRecharge <= baseline.lastsUntilWithoutRecharge);
    assert.ok(three.lastsUntilWithoutRecharge <= one.lastsUntilWithoutRecharge);
    assert.match(card(one), /1% more use/);
    assert.match(card(three), /3% more use/);
});

test('last-five-day average is used by recharge plans, simulations and monthly bills', async () => {
    for (const [name, args] of [
        ['simulate_recharge', { amountBDT: 1330 }],
        ['plan_recharge', { until: '2026-10-31' }],
        ['estimate_month_bill', { month: '2026-10' }],
    ]) {
        const result = await executeTool(name, { ...args, usageWindowDays: 5 }, ctx);
        assert.ok(!result.error, result.error);
        assert.equal(result.usageScenario.dailyKwh, 8);
        assert.equal(result.usageScenario.sampleDays, 5);
        assert.match(result.mainAssumption, /last 5 days/);
        if (name === 'estimate_month_bill') assert.equal(result.electricity.restOfMonthKwh, 27 * 8);
        if (result.displayCard) assert.match(card(result), /last 5 days' average/);
    }
});

test('changing daily usage changes the energy actually priced, including the monthly slab reset', async () => {
    const low = await executeTool('estimate_month_bill', { month: '2026-11', dailyKwh: 3 }, ctx);
    const high = await executeTool('estimate_month_bill', { month: '2026-11', dailyKwh: 10 }, ctx);
    assert.equal(low.electricity.restOfMonthKwh, 90);
    assert.equal(high.electricity.restOfMonthKwh, 300);
    // At this fixture's tariff: 75 × 5 + 225 × 9. The counter starts at zero in November.
    assert.equal(high.electricity.restOfMonthBDT, 2400);
    assert.ok(high.electricity.restOfMonthBDT / 300 > low.electricity.restOfMonthBDT / 90);
});

test('long averaging windows request additional history, and short windows retain tariff history', async () => {
    const calls = [];
    mock.method(usage, 'getBalanceReport', async (...args) => { calls.push(args); return report(); });
    const long = await run({ usageWindowDays: 90 });
    assert.equal(calls[0][1], 91);
    assert.equal(long.usageScenario.sampleDays, 33);
    assert.match(card(long), /33 days available/);
    const short = await run({ usageWindowDays: 5 });
    assert.ok(short.lastsUntilWithoutRecharge, 'retains the completed-month tariff baseline');
});

test('window average weights missing readings and clips a delta crossing the window boundary', () => {
    const rows = [
        { date: '2026-09-25', consumedUnit: 100 },
        { date: '2026-09-30', consumedUnit: 150 },
        { date: '2026-10-03', consumedUnit: 171 },
    ];
    const scenario = resolveUsageScenario(rows, null, { usageWindowDays: 5 }, 14);
    assert.equal(scenario.kwhPerDay, (20 + 21) / 5);
    assert.equal(scenario.sampleDays, 5);
});

test('the report fetch preserves forty days for tariffs and expands for a ninety-day scenario', async () => {
    const fixture = report().report;
    const ranges = [];
    mock.method(desco, 'fetchBalance', async () => ({ success: true, data: fixture.data, prefix: 'unified' }));
    mock.method(desco, 'fetchRechargeHistory', async () => []);
    mock.method(desco, 'fetchDailyConsumption', async (_params, from, to) => {
        ranges.push([from, to]); return fixture.rows;
    });
    await originalBalanceReport({ accountNo: 'fixture' }, 6);
    await originalBalanceReport({ accountNo: 'fixture' }, 91);
    assert.deepEqual(ranges, [['2026-08-25', '2026-10-04'], ['2026-07-05', '2026-10-04']]);
});

test('invalid and conflicting usage inputs fail before loading the account', async () => {
    let lookups = 0;
    mock.method(usage, 'getBalanceReport', async () => { lookups++; return report(); });
    for (const args of [
        { dailyKwh: 0 }, { dailyKwh: '7' }, { dailyKwh: null }, { dailyKwh: Infinity },
        { usageWindowDays: 0 }, { usageWindowDays: 91 }, { usageWindowDays: 5.5 },
        { usageIncreasePercent: -1 }, { usageIncreasePercent: NaN },
        { dailyKwh: 7, usageWindowDays: 5 },
    ]) {
        assert.ok(parseUsageOptions(args).error);
        assert.ok((await run(args)).error);
    }
    assert.equal(lookups, 0);
});

test('explicit daily usage still works when the historical average is unavailable', async () => {
    mock.method(usage, 'getBalanceReport', async () => {
        const result = report(); result.report.usage = null; return result;
    });
    assert.ok((await run({})).error);
    assert.equal((await run({ dailyKwh: 7 })).usageScenario.dailyKwh, 7);
});

test('fixed charges only reduce the recharge credit, not the current-balance runway', async () => {
    const baseline = await run({});
    const early = await run({ amountBDT: 1330, rechargeOn: '2026-10-04' });
    const later = await run({ amountBDT: 1330, rechargeOn: '2026-10-08' });
    assert.equal(early.fixedChargesPaid.totalBDT, 176);
    assert.equal(early.powerBDT + early.vatBDT + 176, 1330);
    assert.equal(early.lastsUntilWithoutRecharge, baseline.lastsUntilWithoutRecharge);
    assert.equal(later.lastsUntilWithRecharge, early.lastsUntilWithRecharge);
    assert.equal(later.powerBDT, early.powerBDT);
});

test('percentage comparison retains both cards even when the model replies with only the last', async () => {
    let step = 0;
    mock.method(getClient().models, 'generateContent', async () => {
        if (step++ === 0) return {
            functionCalls: [1, 3].map((p) => ({ name: 'simulate_recharge', args: { amountBDT: 0, usageIncreasePercent: p } })),
        };
        return { text: '[[BLOCK_2]]' };
    });
    const reply = await askGemini('How long with 1–3% more use?', ctx.session, ctx, 'en');
    assert.match(reply.text, /1% more use/);
    assert.match(reply.text, /3% more use/);
    assert.deepEqual(reply.toolsUsed, ['simulate_recharge', 'simulate_recharge']);
});
