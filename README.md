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
- **Multiple API Support**: Automatically tries both `unified` and `tkdes` API endpoints
- **Flexible Input**: Use saved account details or enter custom ones
- **SSL Certificate Handling**: Handles certificate issues gracefully

### Subscription & Notifications

- **Scheduled Notifications**: Get balance updates at your preferred times
- **Custom Schedule**: Set multiple notification times (e.g., 08:00, 16:00, 20:00)
- **Low Balance Alerts**: Get warned when balance falls below your threshold
- **Subscribe/Unsubscribe**: Easy toggle for notifications

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
