require('./fixtures.cjs');
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { User } = require('../dist/models/User');
const { SupportTicket } = require('../dist/models/SupportTicket');
const { UserService } = require('../dist/services/UserService');
const { raiseSupportTicket, recoverLegacyTickets } = require('../dist/services/SupportTicketService');
const { getSession, resetSession, appendHistory, registerDisplay, supportTranscript } = require('../dist/ai/session');
const { handleSupport, handleActAs } = require('../dist/handlers/support');
const { handleTickets, handleTicket, handleTicketCallback } = require('../dist/handlers/tickets');
const { actingFor, userIdOf, stopActing } = require('../dist/services/SupportService');
const { bot, ADMIN_CHAT_ID, sendMessage } = require('../dist/bot');
const usage = require('../dist/utils/usage');

const customerId = 1739853363;
let tickets, customer, sent;
function context(id = ADMIN_CHAT_ID, text = '', chatId = id) {
    const replies = [];
    return {
        from: { id }, chat: { id: chatId, type: chatId === id ? 'private' : 'group' },
        message: { text }, replies,
        reply: async (text, extra) => { replies.push({ text, extra }); },
    };
}
function seedChat() {
    const session = getSession(customerId).session;
    const token = registerDisplay(session, '<b>About 30 days</b> at 6.89 kWh');
    appendHistory(session, [
        { role: 'user', parts: [{ text: 'Use 7 kWh instead' }, { text: '[internal directive]' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_balance', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_balance', response: { secret: 'tool-only-data' } } }] },
        { role: 'model', parts: [{ text: token }] },
    ]);
}

beforeEach(() => {
    resetSession(customerId); resetSession(ADMIN_CHAT_ID);
    tickets = new Map(); sent = [];
    customer = { telegramId: customerId, firstName: 'Taqi <script>', accountNo: 'fixture-account', notificationTimes: ['09:00'], threshold: 100, thresholdDays: 3 };
    mock.method(UserService, 'getUser', async (id) => id === customerId ? customer : null);
    mock.method(bot.telegram, 'sendMessage', async (...args) => { sent.push(args); return {}; });
    mock.method(User, 'exists', async () => false);
    mock.method(User, 'updateOne', async (filter, fields) => { Object.assign(customer, fields); return {}; });
    mock.method(User, 'find', () => ({ select: () => ({ lean: async () => customer.supportCodeExpiresAt ? [customer] : [] }) }));
    mock.method(User, 'findOneAndUpdate', async (filter) => {
        if (filter.supportCode === customer.supportCode && customer.supportCodeExpiresAt > filter.supportCodeExpiresAt.$gt) {
            delete customer.supportCode; delete customer.supportCodeExpiresAt; return customer;
        }
        return null;
    });
    mock.method(SupportTicket, 'findOneAndUpdate', async ({ telegramId }, update) => {
        const value = { telegramId, ...update.$set };
        tickets.set(telegramId, value); return value;
    });
    mock.method(SupportTicket, 'bulkWrite', async (operations) => {
        for (const { updateOne } of operations) {
            if (!tickets.has(updateOne.filter.telegramId)) tickets.set(updateOne.filter.telegramId, updateOne.update.$setOnInsert);
        }
    });
    mock.method(SupportTicket, 'findOne', ({ telegramId }) => ({ lean: async () => tickets.get(telegramId) ?? null }));
    mock.method(SupportTicket, 'exists', async ({ telegramId }) => tickets.has(telegramId));
    mock.method(SupportTicket, 'find', () => ({ sort: () => ({ skip: (skip) => ({ limit: (limit) => ({
        lean: async () => [...tickets.values()].filter((t) => t.status === 'open').slice(skip, skip + limit),
    }) }) }) }));
    mock.method(SupportTicket, 'updateOne', async (filter, update) => {
        const ticket = tickets.get(filter.telegramId);
        if (!ticket || ticket.status !== filter.status || +ticket.raisedAt !== +filter.raisedAt) return { modifiedCount: 0 };
        Object.assign(ticket, update.$set); return { modifiedCount: 1 };
    });
});
afterEach(async () => {
    await stopActing('done');
    mock.restoreAll();
});

test('ticket snapshots retain readable chat after the AI session is reset, without tool payloads', async () => {
    seedChat();
    const saved = await raiseSupportTicket(customerId, 'Cannot calculate custom usage');
    assert.deepEqual(saved.messages, [
        { role: 'user', text: 'Use 7 kWh instead' },
        { role: 'bot', text: 'About 30 days at 6.89 kWh' },
    ]);
    resetSession(customerId);
    const ctx = context();
    await handleTicket(ctx, String(customerId));
    const shown = ctx.replies.map((r) => r.text).join('\n');
    assert.match(shown, /Use 7 kWh instead/);
    assert.match(shown, /Taqi &lt;script&gt;/);
    assert.doesNotMatch(shown, /tool-only-data|internal directive|\[\[BLOCK/);
    assert.equal(actingFor(), null);
    assert.equal(userIdOf(ctx), ADMIN_CHAT_ID);
});

test('transcripts are bounded, omit expired chats, and redact six-digit codes', () => {
    const session = getSession(customerId).session;
    appendHistory(session, [{ role: 'user', parts: [{ text: 'My code is 123456 <keep this text>' }] }]);
    assert.equal(supportTranscript(customerId)[0].text, 'My code is [6-digit code omitted] <keep this text>');
    for (let i = 0; i < 10; i++) appendHistory(session, [{ role: 'user', parts: [{ text: 'x'.repeat(2000) }] }]);
    assert.equal(supportTranscript(customerId).length, 6);
    assert.equal(supportTranscript(customerId)[0].text.length, 1500);
    session.lastActiveAt = 0;
    assert.deepEqual(supportTranscript(customerId), []);
});

test('/support persists the issue and sends a reply button without disclosing the code', async () => {
    seedChat();
    const ctx = context(customerId, '/support <urgent> please help');
    await handleSupport(ctx);
    assert.equal(tickets.get(customerId).issue, '<urgent> please help');
    const alert = sent.find(([id]) => id === ADMIN_CHAT_ID);
    assert.match(alert[1], /<urgent>/);
    assert.match(alert[1], /Reply to this message/);
    assert.doesNotMatch(alert[1], new RegExp(customer.supportCode));
    assert.match(alert[2].reply_markup.inline_keyboard[0][0].callback_data, new RegExp(`^support_reply:${customerId}:`));
    assert.match(ctx.replies[0].text, /asks for permission/);
});

test('failed support notification keeps the saved ticket and reports the delivery failure', async () => {
    mock.method(bot.telegram, 'sendMessage', async () => { throw new Error('delivery unavailable'); });
    const ctx = context(customerId, '/support Help');
    await handleSupport(ctx);
    assert.ok(tickets.has(customerId));
    assert.match(ctx.replies.at(-1).text, /could not be delivered/);
    assert.equal(await sendMessage('test', ADMIN_CHAT_ID), false);
});

test('ordinary users and group chats cannot inspect, list, resolve or impersonate tickets', async () => {
    await raiseSupportTicket(customerId, 'Help');
    for (const ctx of [context(customerId), context(ADMIN_CHAT_ID, '', -100)]) {
        await handleTickets(ctx);
        await handleTicket(ctx, String(customerId));
        await handleTicketCallback(ctx, `ticket_balance:${customerId}`);
        await handleTicketCallback(ctx, `ticket_resolve:${customerId}:${tickets.get(customerId).raisedAt.getTime()}`);
        await handleActAs(ctx);
        assert.equal(ctx.replies.length, 0);
    }
    assert.equal(tickets.get(customerId).status, 'open');
    assert.equal(actingFor(), null);
});

test('balance inspection uses only the ticket account and does not start an acting session', async () => {
    await raiseSupportTicket(customerId, 'Help');
    let requested;
    mock.method(usage, 'getBalanceReport', async (params) => {
        requested = params;
        return { success: true, report: { data: { balance: 1546.15, currentMonthTaka: 120, readingTime: '2026-10-03' }, usage: null, pending: null } };
    });
    const ctx = context();
    await handleTicketCallback(ctx, `ticket_balance:${customerId}`);
    assert.equal(requested.accountNo, customer.accountNo);
    assert.match(ctx.replies.at(-1).text, /1546.15/);
    assert.equal(userIdOf(ctx), ADMIN_CHAT_ID);
    assert.equal(actingFor(), null);
});

test('ticket inspection does not grant access to an account with no support request', async () => {
    let accessed = false;
    mock.method(usage, 'getBalanceReport', async () => { accessed = true; });
    await handleTicket(context(), String(customerId));
    await handleTicketCallback(context(), `ticket_balance:${customerId}`);
    assert.equal(accessed, false);
});

test('old alerts are recoverable even after code expiry; resolved tickets stay resolved', async () => {
    customer.supportCodeExpiresAt = new Date('2026-10-03T18:15:00Z');
    await recoverLegacyTickets();
    const ticket = tickets.get(customerId);
    assert.equal(ticket.raisedAt.toISOString(), '2026-10-03T18:00:00.000Z');
    assert.equal(ticket.legacy, true);
    assert.deepEqual(ticket.messages, []);
    const ctx = context();
    await handleTicketCallback(ctx, `ticket_resolve:${customerId}:${ticket.raisedAt.getTime()}`);
    await recoverLegacyTickets();
    assert.equal(tickets.get(customerId).status, 'resolved');
});

test('a stale resolve button cannot close a newly raised request', async () => {
    const old = await raiseSupportTicket(customerId, 'First');
    const oldVersion = old.raisedAt.getTime();
    const newer = await raiseSupportTicket(customerId, 'Still stuck');
    newer.raisedAt = new Date(oldVersion + 1);
    const ctx = context();
    await handleTicketCallback(ctx, `ticket_resolve:${customerId}:${oldVersion}`);
    assert.equal(tickets.get(customerId).status, 'open');
    assert.match(ctx.replies[0].text, /already resolved or updated/);
});

test('/actas still requires a valid single-use code; an empty command points to tickets', async () => {
    const ctx = context(ADMIN_CHAT_ID, '/actas');
    await handleActAs(ctx);
    assert.match(ctx.replies[0].text, /\/tickets/);
    assert.equal(actingFor(), null);
    customer.supportCode = '123456';
    customer.supportCodeExpiresAt = new Date(Date.now() + 10000);
    await handleActAs(context(ADMIN_CHAT_ID, '/actas 999999'));
    assert.equal(actingFor(), null);
    await handleActAs(context(ADMIN_CHAT_ID, '/actas 123456'));
    assert.equal(actingFor().userId, customerId);
    assert.equal(customer.supportCode, undefined);
    await stopActing('done');
    await handleActAs(context(ADMIN_CHAT_ID, '/actas 123456'));
    assert.equal(actingFor(), null);
});
