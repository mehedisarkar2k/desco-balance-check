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
|---|---|---|---|
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

## Proposed order

1. Multi-meter model with a provider field, plus the adapter interface; DESCO becomes the first adapter.
2. NESCO: reachability test from Render, then the scraper.
3. Menu-driven UX.
4. Remaining alerts: computed recharge advice, spike alerts, recharge-received notification.
5. ekpay name confirmation at signup.
6. WZPDCL, only if users ask.

Not planned without an official partnership: DPDC, BPDB, BREB prepaid.

## Needed before starting

- A NESCO customer number from someone who agrees to be the test case. Without one the scraper can be written from the references but not verified.
- One DESCO number that "cannot be checked", with a few digits masked, to confirm the postpaid explanation.
- A Gemini key in the local `.env`. Chat changes currently cannot be tested before they are deployed.
