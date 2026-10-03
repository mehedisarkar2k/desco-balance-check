# DESCO Balance Check Bot 🔋

A Telegram bot to check DESCO (Dhaka Electric Supply Company) electricity balance with user management, subscriptions, and automated notifications.

## Features ✨

### User Management

- **MongoDB Integration**: All user data is stored in MongoDB
- **Auto-registration**: Users are automatically registered on first interaction
- **Account Setup**: Users can set up their Account Number and/or Meter Number
- **Profile Management**: View and update account details anytime

### Balance Checking

- **Instant Balance Check**: Check your DESCO balance on demand
- **Runway Estimate**: Shows how many days of power you have left and the date it runs out
- **Burn Rate**: Average daily spend in BDT and kWh, from your last 14 days of readings
- **Custom Forecasts**: Ask for a specific daily usage ("use 7 kWh"), an increase ("1–3% more use"), or a different averaging window ("last 5 days"). Balance runway, recharge plans and monthly estimates recalculate the slabs with those assumptions.
- **Usage Overview**: `/usage` reports any period up to 90 days — total consumption, daily average, highest/lowest day, and recharges in that window
- **Multiple API Support**: Automatically tries both `unified` and `tkdes` API endpoints
- **Flexible Input**: Use saved account details or enter custom ones
- **SSL Certificate Handling**: Handles certificate issues gracefully

### Subscription & Notifications

- **Scheduled Notifications**: Get balance updates at your preferred times
- **Custom Schedule**: Set multiple notification times (e.g., 08:00, 16:00, 20:00)
- **Low Balance Alerts**: Get warned when balance falls below your threshold
- **Days-Left Warning**: Get warned when you're a set number of days from running out, which gives more notice than a fixed BDT amount
- **One Alert Per Reading**: DESCO publishes one reading per day, so low-balance alerts don't repeat hourly
- **Subscribe/Unsubscribe**: Easy toggle for notifications

## A note on DESCO's API 📝

`getBalance` returns a field named `currentMonthConsumption`. Despite the name it is
**month-to-date cost in BDT, not kWh** — it matches the `consumedTaka` series from
`getCustomerDailyConsumption`. This bot exposes it as `currentMonthTaka` to avoid the confusion.

In the daily series, `consumedTaka` is a month-to-date total that resets on the 1st, while
`consumedUnit` is a lifetime meter reading. Days can also be missing from the series, so the
burn rate is computed from per-step deltas divided by the days actually spanned.

## Commands 📋

| Command      | Description                                              |
| ------------ | -------------------------------------------------------- |
| `/start`     | Set up your account (first time) or view welcome message |
| `/balance`   | Check your current DESCO balance                         |
| `/me`        | View your account and subscription information           |
| `/update`    | Update account details, notification times, or threshold |
| `/subscribe` | Manage notification subscriptions                        |
| `/help`      | Show all available commands                              |
| `/support [issue]` | Raise or update a support ticket and get a support code |

## Support tickets

`/support` asks the customer to describe the problem in the bot, in Bangla, English, or Banglish. `/support <issue>` starts with those details immediately. Up to six recent AI-chat messages are attached, including rendered calculation cards; chat outside the active 30-minute AI session is not available to attach. The support conversation itself is stored in MongoDB and survives restarts.

The AI assistant asks for missing details or tries to answer using read-only account tools. It cannot change settings. Failed lookups, requests for a person, unsupported problems and unresolved issues after two attempts are escalated with a summary, reason, attempted lookups and recent messages. Suggested answers do not close a ticket: the customer presses **Solved**, or the admin resolves it.

When escalation is delivered, the user is told the admin will reply through the bot. The late-night notice is included only from 23:00 to 06:59 in **Asia/Dhaka**. Failed deliveries are reported honestly, and the ticket remains saved. Support text is routed for 24 hours after the last activity; `/cancel` returns to normal chat without deleting the ticket. Commands and guided account-setup flows retain priority.

In the admin's private chat:

- `/tickets` lists open tickets; `/tickets 2` opens the next page.
- `/ticket <telegramId>` shows the issue, saved conversation and account settings. **Inspect balance** reads that ticket's DESCO balance without switching the admin's active account.
- **Reply through bot**, a Telegram reply to a support notification, or `/reply <telegramId> <message>` sends a message as **Support team** through the bot. The recipient is matched to the saved ticket; no impersonation or personal Telegram conversation is needed. The customer's replies return to the admin, without further AI answers while the admin is handling it.
- **Mark resolved** closes the ticket. Another `/support` reopens it with the latest context.
- `/actas <6-digit support code>` is still required to act on the user's account. The code expires after 15 minutes, works once, and grants at most one hour. `/done` ends that session.

If account changes are needed, ask the customer to send their current support code in the bot. A matching, unexpired code is delivered only to the admin; it is redacted from the saved transcript. Regular support messages and read-only diagnosis require no code.

Older support alerts are recovered where the user's support-code expiry record still exists, even if the code has expired. Those alerts have no saved conversation; requests whose code was already consumed cannot be reconstructed. Deleting a user also deletes their ticket.

## Verification

Run `yarn test` to build TypeScript and run the forecast and support regressions. Tests use synthetic readings, an in-memory ticket fixture, and mocked Telegram/Gemini calls; they do not connect to the live database or send messages.

## Setup 🛠️

### Prerequisites

- Node.js (v18 or higher)
- MongoDB Atlas account or local MongoDB
- Telegram Bot Token (from @BotFather)

### Installation

1. Clone the repository
2. Install dependencies:

```bash
yarn install
```

3. Create `.env` file:

```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_admin_chat_id
DB_URL=mongodb+srv://username:password@cluster.mongodb.net
ACCOUNT_NO=your_default_account_no
METER_NO=your_default_meter_no
THRESHOLD=100
TZ=Asia/Dhaka
```

4. Run in development:

```bash
yarn dev
```

## Usage 🔄

### First Time User

1. Start bot with `/start`
2. Enter Account Number (or skip)
3. Enter Meter Number (or skip)
4. Check balance with `/balance`
5. Subscribe for notifications with `/subscribe`

### Subscription Setup

1. Run `/subscribe`
2. Toggle notifications ON/OFF
3. Set custom notification times
4. Adjust low balance threshold

## Technologies 🔧

- TypeScript
- Telegraf (Telegram bot framework)
- Mongoose (MongoDB)
- Node-cron (Task scheduling)
- Axios (HTTP client)

---

Made with ❤️ for the people of Dhaka
