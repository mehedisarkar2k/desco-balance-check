# Feature plan

Written 20 September 2026. This records what was researched and decided so the
next session can start from here instead of redoing it.

## Where the bot stands

Live as v2.0.0, DESCO prepaid only, 5 users.

- `/balance`, `/usage` (day-by-day table with a tariff column), `/recharges`
- Days-left forecast priced against DESCO's slab rates, including the reset on the 1st
- Low-balance alerts by BDT amount or by days remaining
- Chat in Bangla or English (Gemini), limited to a fixed set of tools; admin-only tools for user lists and stats
- Version announcements, sent only after admin approval
- Saved-data store in MongoDB (`descosnapshots`): commands are answered from a recent copy, and from the last good copy when DESCO is down

### Things learned about DESCO that the code depends on

- `currentMonthConsumption` in `getBalance` is BDT, not kWh.
- DESCO publishes one reading a day. Daily history only goes back about 45 days; the store now keeps it longer.
- The tariff is banded and resets monthly. At or under 50 units the whole month bills at the lifeline rate; above that, bands apply progressively. The 76–200 band changed from 7.20 to 8.50 in June 2026, which is why rates are derived from readings and never hardcoded.
- The first recharge of a month carries the demand charge, so small top-ups lose a large share to charges.
- DESCO's API answers in about 10 ms. When it is slow, the time is in the TLS handshake (5–15 s measured), and it closes idle connections within 10 s. Hence one shared connection and a 30 s timeout.
- An account lives on exactly one of two systems, `unified` or `tkdes`. The portal itself tries both. Accounts that cannot be checked are most likely postpaid, which the prepaid API does not cover. Account numbers are exactly 8 digits.

## Decisions already made

The redesign was approved in four parts. Only the first is partly done.

1. **Smarter alerts and advice** — tariff engine and forecast are done. Still open: recharge-amount advice as a computed tool (the chat model currently does this arithmetic itself, which is not reliable), usage-spike alerts, and a "recharge received" notification when a new `orderID` appears.
2. **Multi-meter support** — not started. One user, several meters. Do this first; it reshapes the `User` model and gets more expensive with every new user.
3. **Menu-driven UX** — not started. One home screen with buttons instead of remembered commands. Do it after multi-meter so screens are designed against the final data model.
4. **Code architecture** — partly done (`src/domain/`, `src/ai/`, `src/descoStore.ts`). No tests exist yet; the tariff and usage math are the first things worth covering.

## Other electricity providers

Researched on 20 September 2026 by reading each provider's portal code and existing open-source projects. No real customer numbers were used, so nothing below has been confirmed with a live account.

Meter counts are from a July 2026 news report, approximate, and do not sum exactly to the reported national total.

| Provider | Prepaid meters | Verdict | Notes |
| --- | --- | --- | --- |
| DESCO | ~9.2 lakh | Done | |
| NESCO | ~9.4 lakh | Feasible, next | Customer number only, no login or captcha. HTML scraping with a session cookie and CSRF token at `customer.nesco.gov.bd/pre/panel`. Gives balance, recharge history, monthly usage; no daily data. About ten open-source projects do this; `mdminhazulhaque/python-nesco` is the cleanest reference. |
| WZPDCL | ~9.1 lakh | Partial | Open JSON API at `api.wzpdcl.gov.bd` (endpoint list is public at `/Help`). Customer info without login was verified. Usage, payment and token endpoints exist but were not tested. Balance appears to need phone + OTP registration. |
| DPDC | ~10.8 lakh | Closed | Anonymous balance lookup worked until 8 Sept 2026, then a Cloudflare captcha was added; an open-source DPDC bot has failed daily since. Richer data needs each user's DPDC password. |
| BPDB | ~35.4 lakh | Not possible | Keypad meters hold the balance themselves; no server has it. Only recharge history exists, behind a captcha or phone OTP. |
| BREB (Palli Bidyut) | ~18 lakh | Not possible | Same keypad meters, no prepaid portal. |

Realistic reach is about 30% of the country's prepaid meters: DESCO and NESCO fully, WZPDCL in part.

**ekpay.gov.bd** (government payment platform) has a bill lookup that answered without login in testing, covering DESCO, NESCO, WZPDCL-postpaid and BREB-postpaid. It returns customer name, meter, tariff, and dues for postpaid accounts — not balance or usage. Possible uses: confirming an account at signup, and a bill-due reminder for postpaid users (DESCO postpaid needs a bill number). No successful response was ever observed, the API is undocumented, and its legal standing for automated use is unclear.

### How multiple providers would fit

One adapter per provider, each declaring what it supports (balance, daily usage, monthly usage, recharges). The bot shows only what that provider has, so a NESCO user gets balance, recharges and alerts but no day-by-day table or slab dates. The multi-meter model gains a provider field. The saved-data store already works for any provider.

### Risks to keep in mind

- **Reachability.** NESCO's server timed out for two researchers connecting from outside Bangladesh, and Render is outside Bangladesh. Test one request from Render before writing any NESCO code; if it fails, NESCO needs a small relay inside Bangladesh.
- **Privacy.** WZPDCL, and one BREB endpoint, return a real person's name, address and mobile number (BREB also NID and date of birth) for any number typed in. Only ever look up numbers the bot's own users supply. Do not build on the BREB endpoint.
- **Access can vanish.** Every one of these is undocumented; DPDC closed theirs overnight. Each adapter must fail gracefully and tell the user plainly.

## Admin: user list, contact and support threads

Today the admin finds users with "list users" in chat and removes one with "X ke remove koro", which sends a confirm button. Users have /support (a saved ticket with recent conversation and a one-time code for /actas) and /leave. Support now gathers details in the bot, attempts read-only AI diagnosis, and escalates unresolved issues. The admin can review with /tickets or /ticket, inspect the balance, reply through the bot, and mark tickets resolved. Account changes still use /actas.

### Part 1: user list and contact (easy, about 200 lines)

1. `/users` (admin only): one button per user name, 10 per page, with ◀ ▶.
2. Tapping a name shows a card: name, @username, ID, joined, subscribed, account set up. Buttons: 💬 Contact, ⚙️ Actions, ⬅ Back.
3. Actions: 🗑 Remove for now, reusing the existing confirm-and-delete (`admin_remove:` in `src/handlers/support.ts`). Later actions go on this screen.
4. Contact: the bot asks what to say; the admin types a rough note in any language; the AI turns it into a polished message and shows a preview with 📤 Send, ✏️ Change, 🗑 Discard. Nothing reaches the user until Send.
   - Keep one pending draft, and put its number in the button data, so Send on an older preview cannot send the newer text.
   - Report a failed delivery (403 means the user blocked the bot) instead of claiming it was sent.

### Part 2: support threads (implemented for text)

The implementation uses persisted Telegram reply-message IDs to route admin replies, plus `/reply <id> <message>`. Replies are sent as typed from the bot. Threads remain active for 24 hours after activity, or until `/cancel` or resolution. The original outline below is retained for comparison; attachments and optional AI polishing remain future work.

5. Send opens a thread with that user. While it is open, the user's messages go to the admin as "💬 Name (ID …): …" instead of to the AI. The admin replies with Telegram's reply, and the reply goes to the user. A Close button, or a period without messages, ends it.
   - Store the open thread on the user's record, not in memory: restarts would otherwise drop it and the user's messages would silently go to the AI.
   - Find the user for a reply by reading the ID in the message being replied to, so nothing else needs storing and it survives restarts.
   - Commands keep working during a thread. Text only at first; photos and voice need more work.
   - Taking messages away from the AI is where bugs would hurt: test ignored, misrouted and restart cases on the selftest DB.

Part 1 does not need redoing when Part 2 is added.

### Open decisions

- Language of the polished message: always Bangla, always English, or the language of the admin's note.
- In a thread, whether every user message goes to the admin or only replies to the admin's message; and the idle time before it closes (24 hours?).
- Whether the admin's replies in a thread go as typed or get AI polish with a preview.

### Known issue to fix alongside

After a removal the bot says "They've been told" even when the message was not delivered: `sendMessage` in `src/bot.ts` logs a failed send and carries on. The removal notice itself is English only.

## Proposed order

1. Multi-meter model with a provider field, plus the adapter interface; DESCO becomes the first adapter.
2. NESCO: reachability test from Render, then the scraper.
3. Menu-driven UX.
4. Remaining alerts: computed recharge advice, spike alerts, recharge-received notification.
5. ekpay name confirmation at signup.
6. WZPDCL, only if users ask.
7. Admin user list and contact (Part 1 above); support threads (Part 2) after it.

Not planned without an official partnership: DPDC, BPDB, BREB prepaid.

## Hosting: Render or Heroku

Render has not been sleeping. On 20 Sept the service showed 19 days of unbroken uptime before that day's deploys, and the health check answers in under 0.1 s; a sleeping service takes 30 s or more to wake. What looked like sleep was roughly ten deploys in one day (each restarts the bot), DESCO's slow front-end, and the scheduler that never started before it was fixed.

Moving to Heroku (student pack credit) is still reasonable, because a paid always-on dyno does not depend on the self-ping keep-alive. It is not urgent. Wait a few stable days first.

What the move needs:

- A `Procfile` containing `worker: node dist/index.js`. The bot uses long polling, so it needs no web dyno.
- An `engines` field in `package.json` pinning Node 24. It is missing today.
- Yarn 4 on Heroku's buildpack is untested; the first deploy may need a small adjustment.
- Confirm what the student credit covers. A Basic dyno does not sleep; Eco shares a limited pool of monthly hours.
- Suspend Render before starting Heroku. Only one instance can poll Telegram, and the bot now exits when it detects a second one, so both running together would crash-loop each other.
- Heroku restarts dynos about once a day, so the "bot started / shutting down" messages to the admin chat will appear daily unless they are reduced.

Heroku's servers are also outside Bangladesh, so it changes nothing for DESCO's slowness or the NESCO reachability question.

## Needed before starting

- A NESCO customer number from someone who agrees to be the test case. Without one the scraper can be written from the references but not verified.
- One DESCO number that "cannot be checked", with a few digits masked, to confirm the postpaid explanation.
- A Gemini key in the local `.env`. Chat changes currently cannot be tested before they are deployed.
