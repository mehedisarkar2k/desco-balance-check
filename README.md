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
