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

The demo bar comes with sample staff and two weeks of shifts and punches. **Every demo PIN is `1234`.**

## Run it on your computer

You need [Node.js](https://nodejs.org) 22.13 or newer (free).

```bash
npm install
npm run dev        # open http://localhost:3000
npm test           # 28 tests: pay rules, tips, punches, offline queue
```

Data is stored in `data/rondo.db` (a single SQLite file). Delete that file to
start over with fresh demo data.

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
src/app/                 Screens and API routes
tests/                   Automated tests
```

## Not built yet

Manager and staff accounts (right now one demo venue, no sign-in), shift
swaps and availability, notifications, a service worker so the clock page
itself loads with no connection, payroll export, French. See the technical
spec PDF for the order.

## Important

Pay figures are estimates for scheduling and payroll prep, not payroll. Have
a Nova Scotia employment lawyer review the overtime, call-in and tip-pool logic
before a paying customer relies on it.
