require('./fixtures.cjs');
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { SupportTicket } = require('../dist/models/SupportTicket');
const { UserService } = require('../dist/services/UserService');
const { bot, ADMIN_CHAT_ID } = require('../dist/bot');
const agent = require('../dist/ai/supportAgent');
const { getClient } = require('../dist/ai/gemini');
const { executeTool, declarationsForRole } = require('../dist/ai/tools');
const { createSession, resetSession } = require('../dist/ai/session');
const { escalationNotice, isLateInDhaka } = require('../dist/utils/supportText');
const {
    handleSupportConversation, handleSupportFeedback, handleSupportReplyCommand,
    handleAdminSupportReply, handleSupportReplyButton, pauseSupportConversation,
} = require('../dist/handlers/supportConversation');

let records, sent, replies, nextId, user;
const copy = (value) => structuredClone(value);
function ticket(id = 123) {
    return { telegramId: id, status: 'open', raisedAt: new Date('2026-10-04T00:00:00Z'),
        stage: 'awaiting_details', activeUntil: new Date(Date.now() + 100000),
        issue: '', messages: [], aiAttempts: 0, adminMessageIds: [], legacy: false };
}
function matches(record, filter) {
    return Object.entries(filter).every(([key, expected]) => {
        if (key === '$or') return expected.some((alternative) => matches(record, alternative));
        const actual = record[key];
        if (expected instanceof Date) return +actual === +expected;
        if (expected && typeof expected === 'object') return Object.entries(expected).every(([operator, value]) => {
            if (operator === '$exists') return (actual !== undefined) === value;
            if (operator === '$lt') return actual < value;
            if (operator === '$gt') return actual > value;
            throw new Error('Unsupported query in test: ' + operator);
        });
        return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
    });
}
function update(record, change) {
    Object.assign(record, copy(change.$set ?? {}));
    for (const key of Object.keys(change.$unset ?? {})) delete record[key];
    for (const [key, value] of Object.entries(change.$inc ?? {})) record[key] = (record[key] ?? 0) + value;
    for (const [key, value] of Object.entries(change.$push ?? {})) {
        record[key] = [...(record[key] ?? []), ...copy(value.$each)];
        if (value.$slice) record[key] = record[key].slice(value.$slice);
    }
}
function ctx(id = 123, text = 'The balance estimate is wrong', messageId = nextId++) {
    return {
        from: { id }, chat: { id, type: 'private' }, message: { message_id: messageId, text },
        sendChatAction: async () => {},
        reply: async (text, extra) => { const message = { message_id: nextId++, text, extra, chat: { id } }; replies.push(message); return message; },
    };
}

beforeEach(() => {
    records = new Map([[123, ticket()]]); sent = []; replies = []; nextId = 500;
    user = { telegramId: 123, firstName: 'Customer', language: 'en', accountNo: 'fixture' };
    mock.method(UserService, 'getUser', async () => user);
    mock.method(bot.telegram, 'sendMessage', async (id, text, extra) => {
        const message = { message_id: nextId++, chat: { id }, text, extra }; sent.push(message); return message;
    });
    mock.method(SupportTicket, 'findOne', (query) => ({ lean: async () => copy([...records.values()].find((r) => matches(r, query)) ?? null) }));
    mock.method(SupportTicket, 'updateOne', async (query, change) => {
        const record = [...records.values()].find((r) => matches(r, query));
        if (!record) return { matchedCount: 0, modifiedCount: 0 };
        update(record, change); return { matchedCount: 1, modifiedCount: 1 };
    });
    mock.method(SupportTicket, 'findOneAndUpdate', async (query, change) => {
        const record = [...records.values()].find((r) => matches(r, query));
        if (!record) return null;
        update(record, change);
        const doc = copy(record); Object.defineProperty(doc, 'toObject', { value: () => copy(record) }); return doc;
    });
});
afterEach(() => mock.restoreAll());

test('support details get an AI attempt and remain open until the customer confirms', async () => {
    mock.method(agent, 'answerSupport', async () => ({ action: 'answer', reply: 'At 7 kWh per day, here is the updated estimate.', summary: 'Custom daily usage', reason: '' }));
    assert.equal(await handleSupportConversation(ctx(), 'Use 7 kWh per day'), true);
    assert.equal(records.get(123).stage, 'awaiting_feedback');
    assert.equal(records.get(123).status, 'open');
    assert.equal(records.get(123).aiAttempts, 1);
    assert.match(replies[0].text, /7 kWh/);
    const data = replies[0].extra.reply_markup.inline_keyboard[0][0].callback_data;
    await handleSupportFeedback(ctx(999), data);
    assert.equal(records.get(123).status, 'open');
    await handleSupportFeedback(ctx(), data);
    assert.equal(records.get(123).status, 'resolved');
});

test('duplicate Telegram updates do not run the agent or store the message twice', async () => {
    let attempts = 0;
    mock.method(agent, 'answerSupport', async () => { attempts++; return { action: 'clarify', reply: 'Which calculation?', summary: 'Needs details', reason: '' }; });
    const input = ctx();
    await Promise.all([handleSupportConversation(input, 'Help'), handleSupportConversation(input, 'Help')]);
    assert.equal(attempts, 1);
    assert.equal(records.get(123).messages.filter((m) => m.role === 'user').length, 1);
});

test('failed diagnosis sends the admin a detailed ticket, not an invented solution', async () => {
    mock.method(agent, 'answerSupport', async () => ({ action: 'escalate', reply: '', summary: 'Five-day forecast failed', reason: 'DESCO data unavailable', toolsUsed: ['get_balance'] }));
    await handleSupportConversation(ctx(), 'Last five days does not work');
    assert.equal(records.get(123).stage, 'admin');
    assert.match(sent[0].text, /Five-day forecast failed/);
    assert.match(sent[0].text, /DESCO data unavailable.*get_balance/);
    assert.match(sent[0].text, /Last five days does not work/);
    assert.match(replies[0].text, /sent your ticket/);
    assert.equal(sent[0].chat.id, ADMIN_CHAT_ID);
    assert.ok(records.get(123).adminMessageIds.includes(sent[0].message_id));
});

test('an unsuccessful second attempt escalates without another AI loop', async () => {
    records.get(123).aiAttempts = 2;
    mock.method(agent, 'answerSupport', async () => { throw new Error('must not run'); });
    await handleSupportConversation(ctx(), 'Still not working');
    assert.equal(records.get(123).stage, 'admin');
    assert.match(sent[0].text, /two AI support attempts/);
});

test('failed notification stays in the queue and does not claim the admin was contacted', async () => {
    records.get(123).aiAttempts = 2;
    mock.method(bot.telegram, 'sendMessage', async () => { throw new Error('blocked'); });
    await handleSupportConversation(ctx(), 'Still stuck');
    assert.equal(records.get(123).stage, 'admin');
    assert.equal(records.get(123).adminNotifiedAt, undefined);
    assert.match(replies[0].text, /could not be delivered/);
    assert.doesNotMatch(replies[0].text, /I've sent/);
});

test('reply-through-bot works after chat-memory reset and routes the customer response back', async () => {
    records.get(123).stage = 'admin'; records.get(123).adminMessageIds = [88];
    resetSession(123); resetSession(ADMIN_CHAT_ID);
    const admin = ctx(ADMIN_CHAT_ID, 'Please try /balance again');
    admin.message.reply_to_message = { message_id: 88 };
    assert.equal(await handleAdminSupportReply(admin, admin.message.text), true);
    assert.equal(sent[0].chat.id, 123);
    assert.match(sent[0].text, /Support team/);
    assert.match(sent[0].text, /Please try \/balance again/);
    await handleSupportConversation(ctx(), 'It works now');
    assert.equal(sent[1].chat.id, ADMIN_CHAT_ID);
    assert.match(sent[1].text, /It works now/);
});

test('only private admin messages may send replies, and commands require an open ticket', async () => {
    await handleSupportReplyCommand(ctx(123, '/reply 123 Hello'));
    const group = ctx(ADMIN_CHAT_ID, '/reply 123 Hello'); group.chat = { id: -100, type: 'group' };
    await handleSupportReplyCommand(group);
    await handleSupportReplyCommand(ctx(ADMIN_CHAT_ID, '/reply 456 Hello'));
    assert.equal(sent.length, 0);
    const admin = ctx(ADMIN_CHAT_ID, '/reply 123 Hello');
    await handleSupportReplyCommand(admin);
    await handleSupportReplyCommand(admin);
    assert.equal(sent.length, 1, 'duplicate updates must not send twice');
});

test('unmapped or closed support replies never send a message to a guessed user ID', async () => {
    const admin = ctx(ADMIN_CHAT_ID, 'Hello');
    admin.message.reply_to_message = { message_id: 88, text: 'Reply to this message to send to ID 456 through the bot.' };
    assert.equal(await handleAdminSupportReply(admin, 'Hello'), true);
    records.get(123).adminMessageIds = [88]; records.get(123).status = 'resolved';
    assert.equal(await handleAdminSupportReply(admin, 'Hello'), true);
    assert.equal(sent.length, 0);
    assert.match(replies.at(-1).text, /closed/);
});

test('failed admin delivery is reported and never recorded as a sent reply', async () => {
    mock.method(bot.telegram, 'sendMessage', async () => { throw new Error('unreachable'); });
    await handleSupportReplyCommand(ctx(ADMIN_CHAT_ID, '/reply 123 Try this'));
    assert.match(replies[0].text, /could not be delivered/);
    assert.equal(records.get(123).messages.length, 0);
});

test('an admin taking over while AI is running suppresses the outdated AI answer', async () => {
    let release, started;
    const running = new Promise((resolve) => { started = resolve; });
    mock.method(agent, 'answerSupport', async () => { started(); return new Promise((resolve) => { release = resolve; }); });
    const pending = handleSupportConversation(ctx(), 'Help');
    await running;
    await handleSupportReplyCommand(ctx(ADMIN_CHAT_ID, '/reply 123 I am checking')); 
    release({ action: 'answer', reply: 'Outdated AI answer', summary: '', reason: '' });
    await pending;
    assert.equal(records.get(123).stage, 'admin');
    assert.ok(!replies.some((r) => /Outdated/.test(r.text)));
});

test('commands, cancelled threads and expired threads remain normal bot interactions', async () => {
    assert.equal(await handleSupportConversation(ctx(), '/balance'), false);
    await pauseSupportConversation(ctx());
    assert.equal(await handleSupportConversation(ctx(), 'What is my balance?'), false);
    records.get(123).activeUntil = new Date(0);
    assert.equal(await handleSupportConversation(ctx(), 'Hello'), false);
});

test('support replies require the current ticket version', async () => {
    await handleSupportReplyButton(ctx(ADMIN_CHAT_ID), 'support_reply:123:1');
    assert.match(replies[0].text, /closed or changed/);
    assert.deepEqual(records.get(123).adminMessageIds, []);
});

test('an explicitly shared valid support code reaches only the admin and is redacted in history', async () => {
    user.supportCode = '123456'; user.supportCodeExpiresAt = new Date(Date.now() + 100000);
    await handleSupportConversation(ctx(), '123456');
    assert.match(sent[0].text, /\/actas 123456/);
    assert.equal(sent[0].chat.id, ADMIN_CHAT_ID);
    assert.ok(records.get(123).messages.every((m) => !m.text.includes('123456')));
});

test('night messaging uses Dhaka boundaries and never claims a delivery on failure', () => {
    for (const [utc, night] of [
        ['2026-10-04T16:59:00Z', false], ['2026-10-04T17:00:00Z', true],
        ['2026-10-05T00:59:00Z', true], ['2026-10-05T01:00:00Z', false],
    ]) assert.equal(isLateInDhaka(new Date(utc)), night);
    assert.match(escalationNotice('en', true, new Date('2026-10-04T18:00:00Z')), /late at night/);
    assert.doesNotMatch(escalationNotice('en', true, new Date('2026-10-04T06:00:00Z')), /late at night/);
    assert.doesNotMatch(escalationNotice('en', false), /I've sent/);
});

test('support tools enforce read-only access even if the model requests a settings change', async () => {
    const declarations = declarationsForRole('user', true);
    assert.ok(declarations.some((d) => d.name === 'get_my_settings'));
    assert.ok(!declarations.some((d) => d.name.startsWith('set_')));
    const result = await executeTool('set_reminders_enabled', { enabled: false }, {
        userId: 123, role: 'user', readOnly: true, language: 'en', session: createSession(123),
    });
    assert.match(result.error, /read-only/);
});

test('human requests and model failures escalate, while a missing detail prompts clarification', async () => {
    let calls = 0;
    mock.method(getClient().models, 'generateContent', async () => { calls++; throw new Error('unavailable'); });
    assert.equal((await agent.answerSupport(ticket(), user, 'Please connect me to admin', 'en')).action, 'escalate');
    assert.equal(calls, 0);
    assert.equal((await agent.answerSupport(ticket(), user, 'Help', 'en')).action, 'escalate');
    mock.method(getClient().models, 'generateContent', async () => ({ text: JSON.stringify({ action: 'clarify', reply: 'Which estimate seems wrong?', summary: 'Unclear calculation issue', reason: 'Need the affected estimate' }) }));
    const result = await agent.answerSupport(ticket(), user, 'Help', 'en');
    assert.equal(result.action, 'clarify');
    assert.match(result.reply, /Which estimate/);
});

test('the support agent checks the proposed answer before returning it to the user', async () => {
    let step = 0;
    mock.method(getClient().models, 'generateContent', async (request) => {
        step++;
        if (step === 1) return { text: JSON.stringify({ action: 'answer', reply: '', summary: 'How to see daily use', reason: '' }) };
        if (step === 2) {
            assert.ok(request.config.tools[0].functionDeclarations.every((tool) => !tool.name.startsWith('set_')));
            return { text: 'Use /usage to see your daily electricity consumption.' };
        }
        assert.match(request.contents, /candidate/);
        return { text: JSON.stringify({ action: 'answer', reply: '', summary: 'Explained the usage command', reason: '' }) };
    });
    const result = await agent.answerSupport(ticket(), user, 'How can I see daily consumption?', 'en');
    assert.equal(step, 3);
    assert.equal(result.action, 'answer');
    assert.match(result.reply, /\/usage/);
});

test('a claimed account change is escalated rather than sent as a successful solution', async () => {
    let step = 0;
    mock.method(getClient().models, 'generateContent', async () => {
        step++;
        if (step === 1) return { text: JSON.stringify({ action: 'answer', reply: '', summary: 'Reminder issue', reason: '' }) };
        if (step === 2) return { text: 'I have changed all your reminders.' };
        return { text: JSON.stringify({ action: 'escalate', reply: '', summary: 'Reminder configuration needs review', reason: 'No settings change was performed' }) };
    });
    const result = await agent.answerSupport(ticket(), user, 'My reminder is wrong', 'en');
    assert.equal(result.action, 'escalate');
    assert.equal(result.reply, '');
    assert.match(result.reason, /No settings change/);
});
