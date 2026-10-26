# Rondo

Scheduling, time clock and tips for bars and restaurants. This is the first
slice of Rondo: the part that replaces 7shifts. The POS (TouchBistro
replacement) comes later.

## What works today

| Screen | What it does |
| --- | --- |
| **Schedule** (`/schedule`) | Week grid, staff down the side, days across. Add a shift with +, remove with ×. Shifts past midnight are handled. Anyone scheduled over 48 hours in the week is highlighted (Nova Scotia overtime line). |
| **Time clock** (`/clock`) | Kiosk for a bar tablet or phone. Tap name, enter 4-digit PIN, clock in / start break / end break / clock out. Every punch shows a receipt code. If the Wi-Fi is down, the punch is saved on the device and sent when the connection is back, with the original tap time. |
| **My hours** (`/me`) | Staff sign in with name + PIN and see their scheduled shifts, worked sessions, every punch with its receipt, hours, overtime, estimated pay and tips for the week. |
| **Tips** (`/tips`) | Manager enters the night's tip pool; Rondo splits it by hours worked across tip-eligible staff, exact to the cent. |

## What Rondo does on its own

The reason to switch from 7shifts: the manager barely touches the schedule.

| Automation | What happens |
| --- | --- |
| **Auto-build the week** | One button on a draft week. Rondo copies the usual pattern from the last four weeks (the median week, so one-off shifts drop out), gives each shift to the person who usually works it, and works around availability, days off, weekly hour limits and overtime. Set a labour budget and it drops the least regular shifts first, never the last person in a role on a day. Shifts nobody can take become open shifts. 7shifts only offers this on its US$134.99/month Premium plan. |
| **Rule check before publishing** | Nova Scotia rules are checked before staff see anything. Blocks: double booking, shifts on approved time off, pay below minimum wage. Warnings with the dollar cost: overtime past 48h, the 3-hour call-in minimum, no 24 hours off in the week, outside availability, over someone's own weekly limit. Every shift over 5 hours gets its 30-minute break planned and written on the shift. |
| **Open shifts and call-outs fill themselves** | Staff press "Can't make it" (or the manager presses ↺). Rondo offers the shift to people who can take it without overtime or clashes, best fit first: days away, one person at a time with an hour to answer; same day, three at a time; under 3 hours, everyone at once. First yes gets it. The manager just gets "Priya picked up Fri 5 p.m." Staff never have to find their own replacement. |
| **Notifications** | Every message is in the app (free). Email copies go out once a free email provider is set up (see below). No text messages, because SMS costs money per message. |

Staff set their availability and ask for days off on **My hours**, and answer shift offers there.

The demo bar comes with sample staff and two weeks of shifts and punches. **Every demo PIN is `1234`.**

## Run it on your computer

You need [Node.js](https://nodejs.org) 22.13 or newer (free).

```bash
npm install
npm run dev        # open http://localhost:3000
npm test           # 49 tests: pay rules, tips, punches, offline queue, automation
```

Data is stored in `data/rondo.db` (a single SQLite file). Delete that file to
start over with fresh demo data. The demo has four past weeks and this week
published, and next week empty so you can try **Auto-build** (Maria has next
Friday off, so watch Rondo give her shift to Noah).

### Optional settings (all free)

| Setting | What it does |
| --- | --- |
| `RESEND_API_KEY`, `RONDO_EMAIL_FROM` | Sends email copies of notifications through Resend's free tier (about 3,000 emails a month). Without them, messages stay in the app only. |
| `RONDO_CRON_SECRET` | Protects `POST /api/automation/tick`, which a free scheduled ping (for example a Cloudflare cron trigger every 5 minutes) can call so offers move on when nobody has the app open. Without a ping, offers move whenever someone opens the schedule or My hours. |

## How it's built (and why)

- **Next.js + React + TypeScript.** One project for screens and server, free to host on Vercel's hobby tier.
- **SQLite** through Node's built-in driver: no account, no cost, no extra package. The SQL is plain so it can move to Postgres (Supabase free tier) when pilot bars go live.
- **Pay rules live in one file** (`src/lib/rules.ts`). Changing the minimum wage or adding Quebec is a config change.
- **No punch is ever thrown away.** Odd sequences (forgot to clock out, clock-out with no clock-in) are kept and flagged for the manager rather than dropped. This targets 7shifts' "my punch disappeared" complaints.
- **Money is stored in cents** so rounding never loses a penny.

## Code map

```
src/lib/rules.ts         Nova Scotia labour rules (min wage, overtime, breaks, 3-hour call-in)
src/lib/hours.ts         Punches -> work sessions, break checks, flags
src/lib/pay.ts           Weekly pay estimate: regular, overtime, call-in top-up, warnings
src/lib/tips.ts          Tip pool split by hours, exact to the cent
src/lib/receipt.ts       Punch receipt codes (same result on device and server)
src/lib/offlineQueue.ts  Device-side punch queue for Wi-Fi drops
src/lib/db.ts            Database tables and demo staff
src/lib/demo.ts          Sample shifts, punches and tips for the demo bar
src/lib/repo.ts          Everything the screens read and write
src/lib/compliance.ts    Schedule rule check (NS overtime, breaks, call-in, weekly rest, availability)
src/lib/autoschedule.ts  Builds a draft week from past weeks, availability and a labour budget
src/lib/automation.ts    Availability, publish, open shifts, call-outs and shift offers
src/lib/notify.ts        In-app notifications and optional free email copies
src/app/                 Screens and API routes
tests/                   Automated tests
```

## Not built yet

Manager and staff accounts (right now one demo venue, no sign-in), shift
swaps, shift reminders, a service worker so the clock page itself loads with
no connection, payroll export, French. Days off are approved instantly for now.
See the automation roadmap PDF for the order.

## Important

Pay figures are estimates for scheduling and payroll prep, not payroll. Have
a Nova Scotia employment lawyer review the overtime, call-in and tip-pool logic
before a paying customer relies on it.
