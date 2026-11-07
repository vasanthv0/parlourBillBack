# Parlour billing API

Express 5 + PostgreSQL. Node 20 or newer.

## Setup

```bash
cp .env.example .env     # then edit
npm install
npm run db:init          # applies db/schema.sql (safe to re-run)
npm run db:seed          # optional demo data
npm run dev
```

Required in `.env`: database settings and `ACCESS_TOKEN_SECRET` (32+ characters). The app refuses to start without a valid configuration and says what is wrong.

## Structure

```
server.js                 starts the server, shuts down cleanly, starts the daily clean-up
src/app.js                middleware order and route mounting
src/config/               env validation, database pool + transactions
src/middleware/           request id + request log, authenticate, authorize(role), validate(zod), rate limits, error handler
src/modules/<feature>/    routes → service → SQL, with zod schemas beside each (performers, commissions: see below)
src/jobs/                 background housekeeping (the daily refresh-token clean-up)
src/utils/                money in paise, logger + redaction, phone helper, errors
db/schema.sql  seed.js    tables and demo data
db/report-customer-phone-collisions.js   read-only report, see "Customer phone numbers"
tests/                    smoke.test.js (end-to-end) plus unit, attendance and database suites, see "Tests"
```

## Authentication

- **Passwords:** bcrypt (cost 12), 8–72 characters with a letter and a number.
- **Access token:** a 15-minute JWT, held in memory by the browser and sent as `Authorization: Bearer`.
- **Refresh token:** a random opaque string in an `httpOnly` cookie scoped to `/api/v1/auth`. Only its SHA-256 hash is stored.
- **Rotation and theft detection:** every refresh issues a new token and retires the old one. Replaying a retired token revokes that whole session. A 10-second grace window covers two browser tabs refreshing at once.
- **Lockout:** 5 wrong passwords lock an account for 15 minutes. Unknown emails and unknown mobile numbers take the same time as wrong passwords, and all return the same message.
- **Sign in with email or mobile number:** `POST /auth/login` takes `{ identifier, password }`. Anything with an `@` must be an email; anything else must be a mobile number with at least 10 digits (matched by its last 10). The old `{ email, password }` body still works, so a web app that has not been updated keeps signing in. If both are sent, `identifier` wins. See [Mobile numbers and sign-in](#mobile-numbers-and-sign-in).
- **No public sign-up.** There is no register endpoint; parlours are created only by the platform admin.
- **Per-IP limits** on sign-in (`AUTH_RATE_LIMIT`, default 20 per 15 minutes) and on the API overall (`API_RATE_LIMIT`, default 600 per 15 minutes).
- **CSRF:** cookie endpoints (`/refresh`, `/logout`) require an `X-Requested-With` header, which forces a CORS preflight, and CORS only allows `CLIENT_URL`.
- **Revocation:** deactivating a user, changing a role, resetting or changing a password, or suspending a parlour signs the affected people out everywhere. An already-issued access token still works until it expires (at most 15 minutes).

## Tenancy

Every business table has `parlour_id`. The parlour and role come from the signed token, never from the URL or body, so one parlour cannot read or change another's data (covered by a test).

## Platform admin (`super_admin`)

The platform admin is a user with **no parlour** (`parlour_id` is null; a database constraint enforces that only this role may be). Every parlour-level route refuses them, and `/platform/*` refuses everyone else. They cannot be created through the API:

```bash
npm run superadmin:create -- you@example.com "Your Name"          # password from a hidden prompt, or SUPERADMIN_PASSWORD
npm run superadmin:create -- you@example.com --reset-password     # forgot it? same command, new password
```

A parlour's *owner* is its earliest admin, the account created together with it. Suspending a parlour blocks sign-in and revokes every session; deleting one removes it and everything in it, and requires typing its name.

## The switchboard

`src/config/features.js` lists what can be switched off per parlour; `parlours.features` stores only the things switched **off** (a missing key means on, so new features default to on for everyone). `requireFeature('page.team')` guards a route and reads the switch from the database on every call, so a change applies immediately. The sign-in and `/auth/me` responses include the parlour's effective switches for the web app to draw its sidebar.

On the Team page, **Edit** (name, mobile, role), **Reset password** and **Deactivate / Reactivate** are three separate switches (`action.team.edit`, `action.team.reset`, `action.team.deactivate`). A single request that edits details *and* changes active status needs both switches on.

Reading is separate from changing. Switching Services off still lets the billing counter read the menu, and switching Settings off still lets bills read the parlour's address.

## Billing

The server prices every bill from the database. Client-supplied prices and totals are ignored. Money is computed in integer paise, bills are numbered per parlour (`DP-00042`), and item names and prices are snapshotted so later menu edits do not change old bills.

Each line is one service or one combo. A combo line is billed at the combo's price and records what was inside it that day. The order of the maths is: subtotal, then the **referral discount** (the referrer's percentage of the subtotal), then any extra manual discount, then GST on what remains. Referral plus manual discount cannot exceed the subtotal.

### GST

All of the GST arithmetic is one small file with no database in it, `src/modules/invoices/gst.js`, so it can be tested on its own (`tests/gst.unit.test.js`). The browser has a line-for-line copy, `billfront/src/app/core/gst.ts`, for the live total on the billing screen; the server always works the bill out again itself.

**Prices with or without GST inside** is a setting on the parlour (`gstPriceMode`, changed with `PATCH /parlour`, on the Settings page). Every parlour starts, and every existing parlour stays, on `exclusive`.

| | `exclusive` (GST added on top) | `inclusive` (the price already contains GST) |
|---|---|---|
| tax | payable × rate ÷ 100 | payable × rate ÷ (100 + rate) |
| total | payable + tax | payable |
| taxable value | payable | payable − tax |

`payable` is the subtotal less the referral discount and any manual discount. Either way, taxable value + tax = total.

**Rounding.** Every division rounds to the nearest paisa, and exactly half a paisa rounds **up**. It is done with whole numbers, never floating point. (The earlier formula `Math.round(paise × percent ÷ 100)` was a paisa out for some unusual percentages, for example 1.15% of ₹30.00 gave 34 paise instead of 35. For ordinary rates it never differed, which a test checks across more than 500,000 amounts. The referral discount now uses the same exact maths.)

**CGST and SGST** are half the tax each. If the tax is an odd number of paise the extra paisa goes to **CGST**, so CGST + SGST always equals the tax. The database enforces this too (`invoices_gst_split_check`).

Worked example, 5% GST on a ₹1,000 service with a 10% referral and ₹50 off (payable ₹850):

| | on top | inside the price |
|---|---|---|
| tax | ₹42.50 | ₹40.48 |
| CGST + SGST | ₹21.25 + ₹21.25 | ₹20.24 + ₹20.24 |
| taxable value | ₹850.00 | ₹809.52 |
| customer pays | ₹892.50 | ₹850.00 |

**What a bill remembers.** Each bill stores its own `price_mode`, `cgst`, `sgst` and the parlour's `gstin` on the day, and each line stores the service's `sac_code`. Changing the setting, the rate, the GSTIN, a SAC or a price afterwards never changes a bill that already exists.

**Bills made before the split existed** keep `cgst` and `sgst` empty (`null`) and are not touched by `db:init`. The API sends them with `cgst: null`, so the app and the WhatsApp message show one `GST 5%` line, as before. They show the parlour's current GSTIN, as they always did, because none was saved on them.

**SAC code** is optional, 6 digits, per service (`sacCode` on `POST /services` and `PATCH /services/:id`; `null` or a blank value clears it). It is copied onto each bill line. A combo has no SAC of its own, because it can span services with different codes.

**GSTIN** is the parlour's existing `gstNumber`. It is not checked against the official format: it is free text, so a number entered before this change can still be saved with the rest of the Settings form.

Invoice responses now also carry `priceMode`, `cgst`, `sgst`, `taxable` and `gstin`, and each item carries `sacCode`.

### Safe retries: the `Idempotency-Key` header

`POST /invoices` accepts an optional `Idempotency-Key` header: any unique id of 8 to 128 letters, digits and `- _ . :`, made once per bill attempt (the web app sends a UUID). If the same request arrives again, for example a double tap, or a retry after the connection dropped before the answer came back, the API returns **the bill the first request made** instead of a second one:

| Request | Answer |
|---|---|
| New key | `201`, the new bill |
| Same key, same request | `200` with header `Idempotent-Replay: true`, the original bill. Nothing is created and no invoice number is used up |
| Same key, a different request | `409 IDEMPOTENCY_KEY_REUSED`, nothing is created |
| Malformed key | `400 VALIDATION_ERROR` on the field `idempotency-key` |
| No key | exactly as before |

"Same request" means the same customer, referrer, discount, payment method (or the same split payments, in any order, and the same tip), notes and the same services and combos in the same quantities (line order does not matter). Prices are not part of the comparison, so a retry gets the original bill even if the menu changed in between. A key belongs to **one person in one parlour**: someone else using the same key gets their own bill, never yours. Two copies arriving at the same moment are safe too; only one can win, and the other gets the winner's bill. The key and a fingerprint of the request are stored on the invoice, in the same transaction that creates it.

## Payments: split across cash, UPI and card, and tips

A bill can be paid with one method or with several, and can carry a tip. `POST /invoices` takes **one** of:

```jsonc
{ "items": [...], "paymentMethod": "upi" }                                   // the whole bill by one method (what every client sent before)
{ "items": [...], "payments": [{ "method": "cash", "amount": 500 }, { "method": "upi", "amount": 445 }] }
{ "items": [...], "paymentMethod": "cash", "tip": 50 }                        // a tip goes beside either
```

**The rule: payments must add up to the bill total to the paisa.** The server works the total out itself (menu prices, referral and manual discount, GST), turns every amount into whole paise and compares the two as integers. One paisa short or over is `400 PAYMENTS_MISMATCH` (the message says by how much, and it is also on the field `payments`), and nothing is saved: the transaction is rolled back whole, so no invoice number is used up. Floating point never takes part: ₹10.10 + ₹20.20 is exactly ₹30.30. `paymentMethod` is shorthand for "the whole total by this method", so it can never be refused for its amount.

Other rules, all checked with zod before anything else: send `paymentMethod` or `payments`, never both and never neither; `payments` has 1 to 3 entries; each method at most once; each amount above 0 with at most 2 decimals (leave a method out instead of sending 0); `tip` is 0 or more with at most 2 decimals. A bill whose total is ₹0 (everything discounted) is paid by `paymentMethod` alone, stored as one row of ₹0.00.

**A tip is extra money for the staff.** It is stored in `invoices.tip`. It is **not** part of `total`, is not taxed, is not counted as revenue and takes no part in the payments adding up (pay ₹1,050 for a ₹1,050 bill with a ₹50 tip, not ₹1,100). The app does not record which method a tip was paid with.

**What is stored.**

| Where | What |
|---|---|
| `invoice_payments` | One row per method used: `invoice_id`, `method` (cash/upi/card), `amount`. `UNIQUE (invoice_id, method)`, `amount >= 0`, deleted with its bill |
| `invoices.payment_method` | The one method used, or `'split'` when two or more were used |
| `invoices.tip` | The tip, `>= 0`, default 0 |

A bill read back from `GET /invoices/:id` (or returned by `POST`) carries `payments: [{ method, amount }]` in the fixed order cash, UPI, card, and `tip`. The list endpoint carries `paymentMethod` (possibly `"split"`) and `tip` only.

**Bills made before this change** have no `invoice_payments` rows, and `db:init` does not create any: nothing is copied or rewritten. They were paid in full by the single method in `payment_method`, so that is what the API shows (`payments` is that one method for the whole total, `tip` is 0) and what reports count.

**Reports.** `GET /reports/summary` now builds `byPayment` from `invoice_payments`. A bill with no rows (an old one) is counted under its `payment_method` for its whole total. A bill is in exactly one of those two groups, so nothing is counted twice or missed: **the methods add up to `totals.revenue`**. A split bill counts once under each method it used, so the `invoices` counts per method can add up to more than the number of bills. Void bills are left out as before. `totals.tips` is new: tips are not in `revenue` or `byPayment`.

**Switches.** One method is the product and is never switchable. Splitting a bill needs `action.payments.split` (the *Split payment button*) and a tip needs `action.payments.tip` (the *Tip box*). Both default to on, are enforced on the API (`403 FEATURE_DISABLED`), and are independent of each other. A `payments` list with a single method counts as one method and needs no switch.

**Safe retries.** Split payments and the tip are part of "the same request" for the `Idempotency-Key` check; the order the payments were listed in is not. A request in the old shape has exactly the fingerprint it always had, so a retry made just after an upgrade still finds its bill.

**WhatsApp.** A split bill reads `Paid by cash ₹500 + UPI ₹445`, a tip adds `Tip: ₹50 (not included in the total)`, and a single-method bill reads exactly as before.

**Not enforced by the database.** `payments add up to the total` is checked by the API inside the transaction that saves the bill, not by a database constraint (a constraint across two tables needs a deferred trigger, which this version does not have). Nothing in the app writes `invoice_payments` any other way.

## Referrals

`referrers` holds name, contact, percentage and a per-parlour ID (`REF-0001`, counted in `parlours.referral_seq`). A phone number can only be registered once per parlour, however it is written (`98400 12345` and `+91 98400-12345` are the same). Bills store the percentage and amount they used (`referral_percent`, `referral_discount`), and a referrer's totals are *calculated from paid bills*, so they are right after every bill, void and percentage change with nothing to keep in step. Staff can look referrers up by name or ID (`/referrers/lookup`, which returns no phone numbers or earnings); everything else on referrers is admin only.

## Performers and commission

**Performers** (`performers`) are names a parlour admin keeps: not users, no login. A name is unique per parlour whatever its capitalisation. Someone who is on any bill line is deactivated, never deleted (`PERFORMER_IN_USE`). `GET /performers` is read by the billing counter (admin or staff): active names only. Only an admin gets `?includeInactive=true` and the per-person `lines` / `canDelete`.

**On a bill.** `POST /invoices` items take an optional `performedBy` (a performer id). Lines for the *same* service by *different* people stay separate lines; by the same person they merge, as before. The person must be active and belong to the caller's parlour, or the bill is refused (`PERFORMER_UNAVAILABLE`) and nothing is saved. Their rows are held `FOR SHARE` until the bill is saved, so they cannot be deleted half-way. A request that names nobody makes no extra queries and has exactly the idempotency fingerprint it always had. Naming a person needs `page.performers`.

**Written on every bill line** (`invoice_items`), all snapshots, never changed afterwards except `commission_payout_id`:

| Column | Meaning |
|---|---|
| `net_amount` | the line's share of the bill's **taxable value** (after the referral and manual discounts, before GST). Shares add up to the taxable value to the paisa (`allocate`, largest remainder, BigInt). `NULL` on bills made before Phase 4. Written for every new bill, with or without a performer |
| `performed_by`, `performer_name` | who did it, and their name that day |
| `commission_kind`, `commission_rate`, `commission` | the rule it was made under (`percent` or `flat`, and its value) and the commission in rupees. No rule: both `NULL` and `0` |
| `commission_payout_id` | set once, when the commission is marked as paid |

The invoice a customer or staff member can read shows `performedBy` / `performerName` per line and **never** the commission.

**The rules** (`commission_rules`): one per person or per service (a database check says exactly one of the two; a partial unique index says one rule each). A percentage is 0.01 to 100; a flat amount is rupees for each unit, up to 100,000; both at most 2 decimals. `PUT /commissions/rules` adds or replaces; a rule for another parlour's person or service is `404`. Which applies: the person's rule, else the service's; a combo only the person's. All of this is in `src/modules/commissions/commission.js`, pure functions in whole paise.

**Reports.** `GET /commissions?from&to` (default last 30 days, at most a year, parlour-local days) lists each person: `sales`, `earned`, `paid`, `due`, `voidedAfterPaid`. `GET /commissions/performers/:id/lines` is the bill lines behind one person's numbers (newest 500). `GET /reports/summary` adds `byPerformer: { people, unassigned }` when `page.performers` is on (people + unassigned = the taxable value of every bill that stands; the old `byStaff`, by who *made* the bill, is unchanged), and `byPerformer: null` when it is off.

**Mark as paid.** `POST /commissions/pay` `{ performerId, from, to, expectedAmount }` and `POST /referrers/:id/pay` `{ expectedAmount }` each run in one transaction: lock the person (or referrer), lock the unpaid lines (or bills) that stand together with their bills, refuse with `AMOUNT_CHANGED` (409) unless the total is **exactly** `expectedAmount` in paise, write one payout row (`commission_payouts` / `referral_payouts`: who, when, how much, which dates, the name and referral ID as they were) and point every line (or bill) at it. A second press finds nothing left: `NOTHING_TO_PAY` (409). Voided bills are never included; a bill voided *after* being paid is reported (`voidedAfterPaid`) and not altered.

**Switches.** `page.performers`, `page.commissions` (needs `page.performers`), `action.performers.add`, `action.commissions.pay` (needs `page.commissions`), `action.referrals.pay` (needs `page.referrals`). `requires` now chains: `effectiveFeatures` resolves a switch through every page it needs. Commissions is admin only and never reachable by staff.

**Not enforced by the database.** That `performed_by` belongs to the same parlour as the bill is checked by the API when the bill is saved (the line has no parlour column to check against).

## Attendance by Staff

A signed-in admin or staff member records check-in and check-out for **performers**, who have no login. Module: `src/modules/performerAttendance/` (`performerAttendance.routes.js`, `.service.js`, `.schemas.js`), mounted at `/performer-attendance`. Every route needs the **`page.attendance_by_staff`** switch (`requireFeature`), read from the database on each call, so the platform admin's change is immediate; it is limited per person by its own rate limiter (`performerAttendanceLimiter`, 300 per 15 minutes, separate from a person's own attendance).

It is a separate workflow from [GPS attendance](../ATTENDANCE.md). `attendance_records.user_id` is a person who signs in and is attending; here the person attending is a performer and the person recording is a user, so the two are different tables:

```
performer_attendance_records
  id, parlour_id, performer_id, work_date, check_in_at, check_out_at,
  marked_by_user_id              who recorded the check-in
  check_out_marked_by_user_id    who recorded the check-out (null until then)
  created_at, updated_at
```

- **Same-parlour keys:** `(performer_id, parlour_id)` references `performers(id, parlour_id)` and both recorder columns reference `users(id, parlour_id)`, so the database refuses a performer or user from another parlour even if the API were bypassed. They are `DEFERRABLE INITIALLY DEFERRED` so deleting a whole parlour still cascades cleanly. `schema.sql` adds a unique index on `(id, parlour_id)` to `performers` and to `users` for this (each `id` is already unique, so it cannot fail on existing data).
- **One per day:** `UNIQUE (parlour_id, performer_id, work_date)` (`performer_attendance_one_per_day`). `work_date` is `(now() AT TIME ZONE parlours.timezone)::date`; times are `now()`; neither comes from the request.
- **Checks:** a check-out and its recorder are both there or both absent, and a check-out is never before the check-in. Indexes: `(parlour_id, work_date DESC)`, `(performer_id, work_date DESC)`, `(marked_by_user_id)`.
- **Safe to re-run:** everything is `IF NOT EXISTS`; `npm run db:init` any number of times changes no row. No existing table gains a column.
- **No delete under it:** `performers.remove` refuses with `409 PERFORMER_HAS_ATTENDANCE` when a performer has attendance (deactivate instead); the foreign key says the same if someone tries it in SQL.

**The rules** (all in `performerAttendance.service.js`; `ALREADY_CHECKED_IN` and friends are 409):

| Situation | Answer |
|---|---|
| Performer not in your parlour, or no such id | 404 `PERFORMER_NOT_FOUND` (the same answer for both: nothing leaks) |
| Check-in for an inactive performer | 409 `PERFORMER_INACTIVE` |
| Check-in when already checked in today | 409 `ALREADY_CHECKED_IN`; after a check-out, 409 `ATTENDANCE_COMPLETE` |
| Check-out with no check-in today | 409 `NOT_CHECKED_IN` |
| Second check-out | 409 `ALREADY_CHECKED_OUT` (the first one stands) |
| Account deactivated or parlour suspended | 401 `ACCOUNT_DISABLED` (checked in the database each time, not only in the token) |

Races: check-in is one `INSERT … ON CONFLICT DO NOTHING` inside a transaction holding a `FOR SHARE` lock on the performer; check-out takes `FOR UPDATE` on the row and its `UPDATE` only matches an open row. Simultaneous requests give exactly one winner.

**Endpoints** (`/api/v1/performer-attendance`, admin or staff unless noted; each also needs the switch):

| | |
|---|---|
| `GET /today` | the parlour's **active** performers with today's status (`not_checked_in`, `checked_in`, `checked_out`) and the record, if any |
| `POST /check-in` `{ performerId }` → 201 | records the check-in; the body takes **only** `performerId` (anything else, such as `userId`, `parlourId`, a date or a time, is a 400) |
| `POST /check-out` `{ performerId }` | records the check-out |
| `GET /history?from&to&performerId&status&page&limit` | records, newest first, default the last 7 days. `status`: `checked_in`, `checked_out` or `missed_checkout` (a past day never checked out). **Admin: all records. Staff: only those they recorded** (the scope comes from the token, not the query) |
| `GET /report?from&to&performerId` | **admin only.** Per person: days, completed, missed check-outs, minutes worked, and totals |

## WhatsApp

`GET /invoices/:id/whatsapp?phone=` returns a `https://wa.me/<number>?text=<bill>` link. The message is built on the server so every bill reads the same and the "Send on WhatsApp" switch is enforced. It uses the customer's saved number, or the `phone` you pass (for walk-ins). Ten-digit numbers get `WHATSAPP_DEFAULT_COUNTRY_CODE` (default `91`) put in front. A person still taps Send in WhatsApp. To send automatically with no tap, you would move to Meta's WhatsApp Business API: business verification, approved message templates and per-message fees. The link approach needs none of that.

## Logging

One line per request, written as a JSON object, plus one entry for every server error. Example:

```json
{"time":"2026-10-31T10:15:02.114Z","level":"info","msg":"request","reqId":"9d3c2a10-1111-4222-8333-944455556666","method":"POST","path":"/api/v1/invoices","route":"/api/v1/invoices","status":201,"durationMs":42.7,"userId":"…","parlourId":"…","role":"staff","ip":"203.0.113.9"}
```

- **Request id.** Every response carries an `X-Request-Id` header, and every error body repeats it as `error.requestId`. If a caller or proxy sends its own `X-Request-Id` it is kept, provided it is 8 to 64 safe characters; otherwise a new one is made. To investigate a problem, search the logs for that id: you find the request line and, for a server error, the error entry.
- **Levels.** 5xx is `error`, 4xx is `warn`, the rest `info`. Health checks and CORS pre-flights are `debug`. Expected client mistakes (wrong password, validation) are not logged as errors, only as a `warn` request line with their `errorCode`.
- **What is never logged.** Request bodies, query strings (they can hold names and phone numbers), headers, cookies and tokens are never written, because the logger is only ever given the fields shown above. As a second safety net everything that is logged passes through a redactor (`src/utils/redact.js`): values under keys like `password`, `token`, `cookie` and `authorization` are replaced, and secrets inside text (a JWT in an error message, a `Bearer …` value, a bcrypt hash, the row that PostgreSQL quotes in a "Failing row contains" error) are scrubbed. Errors are logged as their type, message, SQLSTATE code, constraint and stack, and nothing else a library may have attached.
- **Settings.** `LOG_LEVEL` (`debug|info|warn|error|silent`, default `info`) and `LOG_FORMAT` (`json|pretty`; unset means `json` in production and `pretty` otherwise). Errors go to stderr, everything else to stdout.
- A crash (`uncaughtException`, `unhandledRejection`) is logged the same way, then the server shuts down cleanly so the host restarts it.
- `morgan` is no longer used. You can remove it whenever convenient with `npm uninstall morgan`.

## Housekeeping

The `refresh_tokens` table gains a row at every sign-in and every token rotation. `src/jobs/refreshTokenCleanup.js` deletes tokens that **expired, or were revoked, more than 30 days ago**, when the server starts and then every 24 hours. Recently revoked tokens are kept on purpose: they are what lets the API notice a stolen token being replayed. The delete runs in batches of 1,000 (at most 100 batches per run) with `FOR UPDATE SKIP LOCKED`, so it never holds a long lock and several servers can run it at once. A failure is logged and never stops the server. The job is started by `server.js`, not `app.js`, so tests that load the app start no timer.

## Customer phone numbers

A customer's phone is stored exactly as typed. It must be 7 to 20 characters of digits and `+ - ( )` with **at least 10 digits** (`-------` used to pass). The same-parlour duplicate rule referrers already follow (the last 10 digits, so `+91 98400-12345` equals `9840012345`) is **not yet enforced for customers**: customers can still be saved twice under different spellings. Before adding that rule, check which customers would collide. Nothing is ever merged or deleted for you.

```bash
npm run report:customer-phones               # full detail, read-only
npm run report:customer-phones -- --mask     # hides digits, surnames and email names: safe to paste into a chat
npm run report:customer-phones -- --json
```

It lists each group of customers in one parlour that share a number (with their bill counts, money and last visit, so you can tell which record matters), customers whose number has fewer than 10 digits or none, and flags numbers that differ only by country code. It runs inside a `READ ONLY` transaction that is rolled back.

## Mobile numbers and sign-in

People sign in with an **email or a mobile number**. Staff can be added with a mobile number and no email; a parlour's admin and the platform admin keep an email (the database enforces it).

- **Stored as typed, compared by the last 10 digits.** `users.mobile` keeps what was typed. `users.mobile_normalised` is a stored column the database works out itself (the last 10 digits, `NULL` under 10 digits), so `+91 98400-12345`, `098400 12345` and `9840012345` are one number, and no existing row has to be edited.
- **One account per number across the whole platform**, like email: a unique index on `mobile_normalised` (`users_mobile_key`). Deactivated accounts keep their number reserved. Adding or changing a number that another account has returns `409 MOBILE_TAKEN` with a message on the `mobile` field. It says nothing about who has it. Email conflicts keep their own `409 EMAIL_TAKEN`.
- **A new or changed number needs at least 10 digits.** An older member's shorter number is left alone and can still be saved back unchanged (editing a name never trips over it); it cannot be used to sign in.
- **Checks in the database** (`db/schema.sql`): every account has an email or a usable number, and only `staff` may have no email. Promoting a mobile-only member to admin returns `400 ADMIN_NEEDS_EMAIL`.
- **Same security for both:** one lookup and one password check (the dummy hash when nothing is found), the same failure message and timing, lockout counted on the account either way, and the deactivated/suspended reason shown only after the right password.
- **Existing data is never touched.** The Phase 5 part of `db/schema.sql` only adds a column, relaxes `email NOT NULL`, adds checks that every existing row already satisfies, and adds the unique index. If two accounts already share a number, the index is **not** created: `db:init` prints a warning, and until you fix the data the API still refuses new or changed duplicates, and signing in by a shared number is refused (both accounts can still sign in by email). Run `npm run db:init` again once fixed.

```bash
npm run report:user-mobiles               # full detail, read-only
npm run report:user-mobiles -- --mask     # hides digits, surnames and email names: safe to paste into a chat
npm run report:user-mobiles -- --json
```

Run it on a real database **before** `npm run db:init` (it works on the old table shape too). It lists numbers shared by two or more accounts (in the same or different parlours, with role, last sign-in and email) and numbers with fewer than 10 digits, and flags differing country codes. It runs in a `READ ONLY` transaction that is rolled back; nothing is merged, edited or deleted.

## Endpoints (`/api/v1`)

| Area | Endpoints | Who |
|---|---|---|
| Auth | `POST /auth/login` (`{ identifier, password }`: an email or a mobile number; the old `email` field still works) `refresh` `logout` `change-password`, `GET /auth/me` (now also returns `mobile`; `email` is `null` for mobile-only staff) | public / signed in |
| Platform | `GET /platform/features` `summary`, `GET` `POST /platform/parlours`, `GET` `PATCH` `DELETE /platform/parlours/:id`, `PATCH …/:id/owner`, `POST …/:id/owner/reset-password` | platform admin only |
| Parlour | `GET /parlour`, `PATCH /parlour` (including `gstPriceMode`: `exclusive` or `inclusive`) | all / admin |
| Services | `GET /services`, `POST`, `PATCH /:id` (both take an optional 6-digit `sacCode`) | all read / admin write |
| Customers | `GET`, `POST`, `GET /:id`, `PATCH /:id` | all |
| Combos | `GET`, `POST`, `PATCH /:id`, `DELETE /:id` | all read / admin write |
| Referrers | `GET /referrers/lookup?q=` | all |
| Referrers | `GET`, `POST`, `GET /:id`, `PATCH /:id`, `DELETE /:id` (the list and `/:id` also show `owed`, `paidOut`, `voidedAfterPaid`; `/:id` adds each bill's `paid` and the `payouts`) | admin |
| Referrers | `POST /referrers/:id/pay` `{ expectedAmount }`: mark what they are owed as paid | admin, needs `action.referrals.pay` |
| Performers | `GET /performers` (staff: active names only), `POST`, `PATCH /:id`, `DELETE /:id` | read: all / write: admin, needs `page.performers` (`POST`: `action.performers.add`) |
| Commissions | `GET /commissions?from&to`, `GET /commissions/performers/:id/lines`, `GET /commissions/payouts`, `GET /commissions/rules`, `PUT /commissions/rules`, `DELETE /commissions/rules/:id` | admin, needs `page.commissions` |
| Commissions | `POST /commissions/pay` `{ performerId, from, to, expectedAmount }` | admin, needs `action.commissions.pay` |
| Invoices | `POST` (`paymentMethod` or `payments`, optional `tip`, optional `Idempotency-Key` header), `GET` (admin: `?createdBy=` filter), `GET /:id`, `POST /:id/void`, `GET /makers`, `GET /:id/whatsapp` | all (staff: own only) / void and makers: admin |
| Reports | `GET /reports/summary` (adds `byPerformer`), `GET /reports/my-day` | admin / all |
| Appointments | `GET /appointments?date=` (one day, on the parlour's own clock), `GET /appointments/queue`, `POST` (`kind: booked` with `date` and `time`, or `walk_in`), `GET /:id`, `PATCH /:id`, `POST /:id/start`, `POST /:id/cancel`, `POST /:id/no-show`. There is no delete: a visit stays on record | all, needs `page.appointments` |
| Appointments | `GET /appointments/:id/reminder` (a `wa.me` link, records nothing), `POST /appointments/:id/reminded` (records that it was opened) | all, needs `action.appointments.remind` |
| Invoices | `POST /invoices` also takes `appointmentId`: the visit is locked, checked to be this parlour's and still open (`APPOINTMENT_NOT_FOUND` 400, `APPOINTMENT_ALREADY_BILLED` / `APPOINTMENT_CLOSED` 409), and completed in the same transaction as the bill | all, needs `action.appointments.bill` |
| Attendance by Staff | `GET /performer-attendance/today`, `POST /check-in`, `POST /check-out`, `GET /history` (staff: own records only), `GET /report` | admin and staff; report: admin; needs `page.attendance_by_staff` |
| Team | `GET`, `POST` (needs `mobile` with 10+ digits; `email` optional for staff, required for an admin; `409 MOBILE_TAKEN` / `EMAIL_TAKEN`), `PATCH /:id` (name, mobile, role, isActive), `POST /:id/reset-password` | admin |

Errors look like `{ "error": { "code", "message", "details", "requestId" } }`. Successes look like `{ "data": …, "meta": … }`.

## Tests

There are four suites. Only the first needs no database.

```bash
# 1. No database, no running API (313 tests, now including the email-or-mobile sign-in rules, the login service with a fake database, and the user-mobile report, plus the commission arithmetic and what is written to each bill line): attendance maths, logging and redaction, request ids,
#    idempotency, the clean-up job, the phone rule, the collision report, GST (the arithmetic to the paisa,
#    what is saved on a bill, how old and new bills read back, the WhatsApp text), and payments (split sums to the
#    paisa with referral and manual discounts, tips, validation, what is refused and not saved, old and new bills read back)
npm run test:unit   # includes performer-attendance.service (39 tests: the switch, the rules, who is recorded, tenant checks and races with a fake database); now also appointments.unit and appointments.service (65 tests: the rules, the SQL each route sends, billing a visit, tenant checks with a fake database)

# 2. End to end (66 tests, 9 of them for sign-in by mobile and mobile uniqueness). Needs PostgreSQL and the API running
npm run db:init && npm run db:seed
AUTH_RATE_LIMIT=1000 API_RATE_LIMIT=5000 npm start   # the suite sends everything from one IP, so lift both per-IP limits
API_URL=http://localhost:3000 npm test # in a second terminal

# 3b. Attendance by Staff, end to end (needs the same setup as 3; restart the API first)
API_URL=http://localhost:3000 npm run test:performer-attendance

# 3. Attendance, end to end (20 tests). Restart the API first: the sign-in limiter is held in memory
API_URL=http://localhost:3000 npm run test:attendance

# 4. The real clean-up SQL, the GST columns and rules, the payments table, tip column and byPayment report SQL, and performers, commission rules, bill-line snapshots, payouts and the commission and referral reports against PostgreSQL (37 tests, now including the Phase 5 schema: the stored mobile column against the application's rule, the checks, the unique rule, and an old database with shared numbers upgrading without a single user row changing). Needs the database from .env, not the API.
#    Everything runs in a transaction that is rolled back, so nothing is left behind
npm run test:db     # runs its files one at a time (several run db:init); includes appointments.db and performer-attendance.db (the new table, its keys and checks, races and re-running the schema)
```

`npm test` covers performers and commission (who is credited, rule changes never altering old bills, "Mark as paid" once and exactly, voided bills, the dashboard adding up, tenant isolation, and every new switch), split payments and tips (sums to the paisa, refusals, switches, retries, reports, another parlour's data), team mobile numbers and the three Team-button switches, combos (create, edit, pause, delete, billing, archived services), referrals (IDs, duplicate numbers, the discount maths to the paisa, void reversal, percentage changes, self-referral), WhatsApp links, sign-in, token rotation and reuse detection, role separation, server-side pricing, staff visibility, the made-by filter, tenant isolation, admin safety rails, lockout, platform-admin access control, creating/editing/suspending/deleting parlours, every switch in the switchboard (off, enforced, back on, and unaffected for other parlours), request ids, the customer phone rule, idempotency (replay, reuse, five simultaneous copies, and keys being private to one person in one parlour), and GST (the split, GSTIN and SAC on a bill, old bills never changing when settings change, prices with and without GST inside, the odd paisa, both settings owner-only and per parlour, and the Settings and Services switches).

## Deploying on Vercel + Render

The web app (`billfront`) goes on **Vercel**, the API and its PostgreSQL database on **Render**. Read the cookie note first: it decides which web addresses you use.

### The cookie problem: put both on the same domain

Signing in sets a refresh cookie on the **API's** address. The browser sends it back to the API when the app asks to stay signed in (`/auth/refresh`, on every page reload). Browsers only send that cookie when the app and the API are on the same **site**, meaning the same registered domain:

| App | API | Cookie sent? |
|---|---|---|
| `app.example.com` | `api.example.com` | **Yes.** Same site, so `COOKIE_SAMESITE=lax` works |
| `yourapp.vercel.app` | `yourapi.onrender.com` | **No.** These addresses belong to the hosts, so browsers treat every project under them as a separate site. The refresh fails and people are signed out on every reload |

`COOKIE_SAMESITE=none` (with HTTPS) lets the cookie through, but Safari and some privacy-focused browsers block that kind of cookie, so those people would still be signed out on every reload. **The fix is a domain you own, with the app and the API on subdomains of it**, for example `app.example.com` on Vercel and `api.example.com` on Render. Keep `COOKIE_SAMESITE=lax`. (Calls between the two still need `CLIENT_URL`, below, because they are different origins; only the cookie rule cares about the site.)

### 1. The API and database on Render

1. Create a PostgreSQL database on Render.
2. Create a **Web Service** from the repository: Root Directory `billback`, Build Command `npm install`, Start Command `npm start`, Health Check Path `/api/v1/health`.
3. Environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the database's connection string (use its internal address for the service) |
| `DB_SSL` | `false` when the service uses the internal address, `true` if it connects over the public one |
| `ACCESS_TOKEN_SECRET` | a long random value: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CLIENT_URL` | the web app's exact origin, `https://app.example.com` (no trailing slash) |
| `COOKIE_SAMESITE` | `lax` |
| `LOG_LEVEL` | `info` |

4. Add the custom domain `api.example.com` to the service and create the DNS record Render shows you.
5. Set up the database **from your own computer**, using the database's external connection string in `DATABASE_URL` (and `DB_SSL=true` if it insists on SSL): `npm run db:init`, then `npm run superadmin:create`. Never run `db:seed` in production.
6. **When you upgrade, run `npm run db:init` before the new API version starts.** It only adds things and keeps all your data, but this version stores an idempotency key on each bill, GST columns, a tip, and a new `invoice_payments` table, so the new code needs them. Some hosts offer a "pre-deploy command" for exactly this.

The API trusts one proxy hop (`trust proxy`), correct for Render, Railway, Fly and similar.

### 2. The web app on Vercel

1. Import the repository. Set the **Root Directory** to `billfront`. `vercel.json` supplies the build command, the output folder (`dist/parlourbill/browser`) and the single-page-app rewrite, so deep links and reloads such as `/admin/invoices/123` work.
2. Before deploying, set `apiUrl` in `billfront/src/environments/environment.ts` to `https://api.example.com/api/v1` and commit it.
3. Add the custom domain `app.example.com` and the DNS record Vercel shows you. Both hosts serve HTTPS, which GPS attendance requires.
4. Check it: sign in, reload the page, and confirm you are still signed in. If you are signed out on reload, the app and API are not on the same site (see above).

