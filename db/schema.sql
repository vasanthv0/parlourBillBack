-- Parlour billing SaaS — PostgreSQL schema (idempotent; safe to re-run)
-- Every business table carries parlour_id: that is the tenant boundary.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS parlours (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  phone          text,
  address        text,
  gst_number     text,
  currency       text NOT NULL DEFAULT 'INR',
  timezone       text NOT NULL DEFAULT 'Asia/Kolkata',
  tax_percent    numeric(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100),
  invoice_prefix text NOT NULL DEFAULT 'INV',
  invoice_seq    integer NOT NULL DEFAULT 0,
  referral_seq   integer NOT NULL DEFAULT 0,  -- counter behind REF-0001, REF-0002 …
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  features       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- switches set by the platform admin; a missing key means "on"
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id          uuid REFERENCES parlours(id) ON DELETE CASCADE,  -- NULL only for the platform super admin
  name                text NOT NULL,
  email               text NOT NULL,
  mobile              text,                    -- collected when a team member is added
  password_hash       text NOT NULL,
  role                text NOT NULL,
  is_active           boolean NOT NULL DEFAULT true,
  failed_login_count  integer NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'admin', 'staff')),
  -- A super admin belongs to no parlour; everyone else must belong to one.
  CONSTRAINT users_scope_check CHECK ((role = 'super_admin') = (parlour_id IS NULL))
);
-- One account per email across the platform (login is by email alone).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_parlour_idx ON users (parlour_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);

CREATE TABLE IF NOT EXISTS customers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id  uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text NOT NULL,
  email       text,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parlour_id, phone)
);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers (parlour_id, lower(name));

CREATE TABLE IF NOT EXISTS services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id    uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text NOT NULL DEFAULT 'General',
  price         numeric(10,2) NOT NULL CHECK (price >= 0),
  duration_min  integer NOT NULL DEFAULT 30 CHECK (duration_min > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parlour_id, name)
);

-- A combo sells several services together at one fixed price.
CREATE TABLE IF NOT EXISTS combos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id  uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  name        text NOT NULL,
  price       numeric(10,2) NOT NULL CHECK (price >= 0),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parlour_id, name)
);
CREATE TABLE IF NOT EXISTS combo_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  combo_id    uuid NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  quantity    integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  UNIQUE (combo_id, service_id)
);

-- People who send customers. A bill that names one gets their percentage off.
CREATE TABLE IF NOT EXISTS referrers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id  uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  code        text NOT NULL,                       -- REF-0001
  name        text NOT NULL,
  contact     text NOT NULL,
  percent     numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parlour_id, code)
);
-- One person once, however the phone number is typed: "98400 12345", "9840012345" and "+91 98400-12345"
-- all end in the same 10 digits.
DROP INDEX IF EXISTS referrers_contact_key;  -- the first version compared every digit, so "+91" slipped through
CREATE UNIQUE INDEX IF NOT EXISTS referrers_contact_last10_key
  ON referrers (parlour_id, right(regexp_replace(contact, '\D', '', 'g'), 10));

CREATE TABLE IF NOT EXISTS invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id      uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  number          text NOT NULL,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name   text NOT NULL DEFAULT 'Walk-in',
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  subtotal        numeric(12,2) NOT NULL,
  discount        numeric(12,2) NOT NULL DEFAULT 0,
  tax_percent     numeric(5,2) NOT NULL DEFAULT 0,
  tax             numeric(12,2) NOT NULL DEFAULT 0,
  total           numeric(12,2) NOT NULL,
  payment_method  text NOT NULL CHECK (payment_method IN ('cash', 'upi', 'card')),
  notes           text,
  status          text NOT NULL DEFAULT 'paid' CHECK (status IN ('paid', 'void')),
  referrer_id        uuid REFERENCES referrers(id) ON DELETE SET NULL,
  referral_percent   numeric(5,2) NOT NULL DEFAULT 0,   -- snapshot: the percentage on the day
  referral_discount  numeric(12,2) NOT NULL DEFAULT 0,  -- what the customer saved; also what the referrer is credited
  void_reason     text,
  voided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  voided_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parlour_id, number)
);
CREATE INDEX IF NOT EXISTS invoices_parlour_created_idx ON invoices (parlour_id, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_created_by_idx ON invoices (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_customer_idx ON invoices (customer_id);

CREATE TABLE IF NOT EXISTS invoice_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id  uuid REFERENCES services(id) ON DELETE SET NULL,
  combo_id    uuid REFERENCES combos(id) ON DELETE SET NULL,   -- set when this line is a combo
  description text,                     -- for a combo: what was in it that day
  name        text NOT NULL,            -- snapshot: survives later renames
  unit_price  numeric(10,2) NOT NULL,   -- snapshot: survives later price changes
  quantity    integer NOT NULL CHECK (quantity > 0),
  line_total  numeric(12,2) NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON invoice_items (invoice_id);

-- ── Upgrades for databases created by an earlier version (safe to re-run) ──────────
ALTER TABLE parlours ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile text;
ALTER TABLE users ALTER COLUMN parlour_id DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin', 'admin', 'staff'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_scope_check;
ALTER TABLE users ADD CONSTRAINT users_scope_check CHECK ((role = 'super_admin') = (parlour_id IS NULL));
ALTER TABLE parlours ADD COLUMN IF NOT EXISTS referral_seq integer NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS referrer_id uuid REFERENCES referrers(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS referral_percent numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS referral_discount numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS combo_id uuid REFERENCES combos(id) ON DELETE SET NULL;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS description text;
-- Idempotency: the key the client sent with POST /invoices, and a fingerprint of the request it came with.
-- Both stay NULL for every existing bill and for bills made without a key.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS idempotency_fingerprint text;
-- GST that matches Indian invoices (Phase 2). Every change here is additive and keeps existing rows as they are.
-- Whether the prices on the menu already contain GST. Every parlour so far added GST on top, so that stays the default.
ALTER TABLE parlours ADD COLUMN IF NOT EXISTS gst_price_mode text NOT NULL DEFAULT 'exclusive'
  CHECK (gst_price_mode IN ('exclusive', 'inclusive'));
-- Optional SAC (services accounting code) per service: 6 digits.
ALTER TABLE services ADD COLUMN IF NOT EXISTS sac_code text CHECK (sac_code ~ '^[0-9]{6}$');
-- Snapshots on the bill, so later changes to the settings or the menu never change an old bill.
--   price_mode  whether the prices on this bill contained GST (old bills: 'exclusive', which is how they were made)
--   cgst, sgst  half of the tax each. NULL on bills made before this change: those keep showing one tax line.
--   gstin       the parlour's GSTIN on the day. NULL on old bills, which keep showing the parlour's current one.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS price_mode text NOT NULL DEFAULT 'exclusive'
  CHECK (price_mode IN ('exclusive', 'inclusive'));
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS cgst numeric(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sgst numeric(12,2);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS gstin text;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS sac_code text;
-- The split is all there or not there at all; cgst + sgst is exactly the tax; and when the tax is an odd number of paise
-- the extra paisa is on CGST (so CGST is never below SGST, and never more than one paisa above it).
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_gst_split_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_gst_split_check CHECK (
  (cgst IS NULL AND sgst IS NULL)
  OR (cgst IS NOT NULL AND sgst IS NOT NULL AND cgst >= 0 AND sgst >= 0 AND cgst + sgst = tax AND cgst - sgst IN (0.00, 0.01))
);
-- Indexes on the upgraded columns come last, once the columns are certain to exist.
CREATE INDEX IF NOT EXISTS invoices_referrer_idx ON invoices (referrer_id) WHERE referrer_id IS NOT NULL;
-- One key, one bill: per parlour and per person (staff only see their own bills, so keys are never shared).
-- Partial, so existing rows (key NULL) are not in it and creating it can never fail on existing data.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_idempotency_key
  ON invoices (parlour_id, created_by, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ── Payments (Phase 3): one bill can be paid with more than one method, and can carry a tip ──────────
-- invoice_payments has one row per method used on a bill. For bills made from now on the rows add up to invoices.total
-- exactly (the API checks this in whole paise before anything is saved). Bills made before this change have NO rows:
-- they were paid by the single method in invoices.payment_method, and reports and the bill screen read them that way.
-- Nothing is copied or rewritten for old bills.
CREATE TABLE IF NOT EXISTS invoice_payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  method      text NOT NULL CHECK (method IN ('cash', 'upi', 'card')),
  amount      numeric(12,2) NOT NULL CHECK (amount >= 0),   -- 0 only for a bill whose total is 0
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, method)                                -- one row per method; also the index for "payments of this bill"
);
-- A tip is extra money for the staff. It is NOT part of invoices.total, is not taxed, and is not counted as revenue.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tip numeric(12,2) NOT NULL DEFAULT 0 CHECK (tip >= 0);
-- invoices.payment_method stays: it is the one method used, or 'split' when a bill was paid with two or more.
-- (The old inline check allowed cash, upi and card only; it is replaced, and every existing row still satisfies the new one.)
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_payment_method_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_payment_method_check CHECK (payment_method IN ('cash', 'upi', 'card', 'split'));

-- ── Attendance: GPS check-in and check-out ───────────────────────────────────────────
-- A parlour is one location in this app (there is no separate branches table), so the geofence is one row per parlour.
-- If branches are added later, this is the table that gains a branch_id.
CREATE TABLE IF NOT EXISTS attendance_settings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id      uuid NOT NULL UNIQUE REFERENCES parlours(id) ON DELETE CASCADE,
  latitude        double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude       double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  radius_m        integer NOT NULL DEFAULT 100 CHECK (radius_m BETWEEN 20 AND 500),     -- the geofence
  max_accuracy_m  integer NOT NULL DEFAULT 50  CHECK (max_accuracy_m BETWEEN 10 AND 100), -- vaguer GPS fixes are refused
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per person per day. work_date is the date in the parlour's own time zone (parlours.timezone).
-- Times are always the database clock (now()), never a time sent by the browser.
CREATE TABLE IF NOT EXISTS attendance_records (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id             uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date              date NOT NULL,
  status                 text NOT NULL DEFAULT 'checked_in' CHECK (status IN ('checked_in', 'checked_out')),

  check_in_at            timestamptz NOT NULL DEFAULT now(),
  check_in_lat           double precision NOT NULL CHECK (check_in_lat BETWEEN -90 AND 90),
  check_in_lng           double precision NOT NULL CHECK (check_in_lng BETWEEN -180 AND 180),
  check_in_accuracy_m    double precision NOT NULL CHECK (check_in_accuracy_m > 0),
  check_in_distance_m    double precision NOT NULL CHECK (check_in_distance_m >= 0),   -- from the salon, by Haversine
  check_in_device_type   text NOT NULL CHECK (check_in_device_type IN ('personal', 'shared')),

  check_out_at           timestamptz,
  check_out_lat          double precision CHECK (check_out_lat BETWEEN -90 AND 90),
  check_out_lng          double precision CHECK (check_out_lng BETWEEN -180 AND 180),
  check_out_accuracy_m   double precision CHECK (check_out_accuracy_m > 0),
  check_out_distance_m   double precision CHECK (check_out_distance_m >= 0),
  check_out_device_type  text CHECK (check_out_device_type IN ('personal', 'shared')),

  created_at             timestamptz NOT NULL DEFAULT now(),

  -- No second record for the same person on the same day, however many requests race.
  CONSTRAINT attendance_one_per_day UNIQUE (parlour_id, user_id, work_date),
  -- Check-out is all there or not there at all, and the status always agrees with it.
  CONSTRAINT attendance_checkout_complete CHECK (
    (check_out_at IS NULL AND check_out_lat IS NULL AND check_out_lng IS NULL AND check_out_accuracy_m IS NULL
       AND check_out_distance_m IS NULL AND check_out_device_type IS NULL AND status = 'checked_in')
    OR
    (check_out_at IS NOT NULL AND check_out_lat IS NOT NULL AND check_out_lng IS NOT NULL AND check_out_accuracy_m IS NOT NULL
       AND check_out_distance_m IS NOT NULL AND check_out_device_type IS NOT NULL AND status = 'checked_out')
  ),
  CONSTRAINT attendance_checkout_after_checkin CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
CREATE INDEX IF NOT EXISTS attendance_parlour_date_idx ON attendance_records (parlour_id, work_date DESC);

-- ── Staff performance and commission (Phase 4) ───────────────────────────────────────
-- Every change here is additive: new tables, new nullable columns, constraints that every existing row already satisfies.
-- Bills made before this change keep exactly what they had: no performer, no commission, and no "share of the bill".

-- The people who perform services. They are just names the admin keeps, NOT login users (users is the login table).
-- A person who has been on a bill is deactivated, never deleted, so old bills keep their record.
CREATE TABLE IF NOT EXISTS performers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id  uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  name        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- One name once per parlour, however it is capitalised.
CREATE UNIQUE INDEX IF NOT EXISTS performers_name_key ON performers (parlour_id, lower(name));

-- A commission rule belongs to ONE person or ONE service (never both, never neither), and each person or service has at most one.
--   kind 'percent'  value is a percentage (0.01 to 100) of the line's share of the bill (see invoice_items.net_amount)
--   kind 'flat'     value is rupees for each unit performed, never more than the line's share of the bill
-- A rule changes the commission on FUTURE bills only: every bill line keeps the rule it was made under.
CREATE TABLE IF NOT EXISTS commission_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id    uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  performer_id  uuid REFERENCES performers(id) ON DELETE CASCADE,
  service_id    uuid REFERENCES services(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('percent', 'flat')),
  value         numeric(10,2) NOT NULL CHECK (value > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_rules_one_target CHECK ((performer_id IS NULL) <> (service_id IS NULL)),
  CONSTRAINT commission_rules_percent_max CHECK (kind <> 'percent' OR value <= 100)
);
CREATE UNIQUE INDEX IF NOT EXISTS commission_rules_performer_key ON commission_rules (parlour_id, performer_id) WHERE performer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS commission_rules_service_key   ON commission_rules (parlour_id, service_id)   WHERE service_id IS NOT NULL;

-- "Mark as paid": one row per payment to a person. Every bill line it covers points back to it (invoice_items.commission_payout_id).
-- The name is copied here so the record still reads right if the person is renamed or removed later.
CREATE TABLE IF NOT EXISTS commission_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id      uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  performer_id    uuid REFERENCES performers(id) ON DELETE SET NULL,
  performer_name  text NOT NULL,
  from_date       date NOT NULL,    -- the days (in the parlour's time zone) the admin was looking at when they marked it paid
  to_date         date NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  line_count      integer NOT NULL CHECK (line_count > 0),
  paid_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commission_payouts_range CHECK (from_date <= to_date)
);
CREATE INDEX IF NOT EXISTS commission_payouts_parlour_idx ON commission_payouts (parlour_id, paid_at DESC);

-- The same idea for what a referrer is owed. Their credit is invoices.referral_discount on every bill that is not void.
CREATE TABLE IF NOT EXISTS referral_payouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id     uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  referrer_id    uuid REFERENCES referrers(id) ON DELETE SET NULL,
  referrer_name  text NOT NULL,
  referrer_code  text NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  bill_count     integer NOT NULL CHECK (bill_count > 0),
  paid_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS referral_payouts_parlour_idx ON referral_payouts (parlour_id, paid_at DESC);

-- What each bill line records. All of it is a snapshot written when the bill is made and never changed afterwards,
-- except commission_payout_id, which is set once when the commission is marked as paid.
--   net_amount            this line's share of the bill's taxable value (after the referral and manual discounts, before GST).
--                         The shares of a bill add up to its taxable value to the paisa. NULL on bills made before Phase 4.
--   performed_by          who did it (a name from performers). NULL when nobody was chosen, and on bills made before Phase 4.
--   performer_name        their name that day
--   commission_kind/rate  the rule the commission was worked out with ('percent' or 'flat', and its value). NULL when no rule applied.
--   commission            what the person earned on this line, in rupees. 0 when no rule applied.
--   commission_payout_id  set when this commission has been paid out. NULL means not paid yet.
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS net_amount numeric(12,2) CHECK (net_amount >= 0);
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS performed_by uuid REFERENCES performers(id) ON DELETE SET NULL;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS performer_name text;
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS commission_kind text CHECK (commission_kind IN ('percent', 'flat'));
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS commission_rate numeric(10,2);
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS commission numeric(12,2) NOT NULL DEFAULT 0 CHECK (commission >= 0);
ALTER TABLE invoice_items ADD COLUMN IF NOT EXISTS commission_payout_id uuid REFERENCES commission_payouts(id) ON DELETE SET NULL;
-- A rule is all there or not there at all; with no rule there is no commission; only commission that exists can be paid out.
ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_commission_check;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_commission_check CHECK (
  ((commission_kind IS NULL AND commission_rate IS NULL AND commission = 0) OR (commission_kind IS NOT NULL AND commission_rate IS NOT NULL))
  AND (commission_payout_id IS NULL OR commission > 0)
);
-- Commission is never negative. (The column's own "commission >= 0" check shares the name dropped above, so it needs a name of its own.)
ALTER TABLE invoice_items DROP CONSTRAINT IF EXISTS invoice_items_commission_nonneg;
ALTER TABLE invoice_items ADD CONSTRAINT invoice_items_commission_nonneg CHECK (commission >= 0);
-- A referrer's credit on a bill, once paid out, points at the payout. NULL means not paid yet.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS referral_payout_id uuid REFERENCES referral_payouts(id) ON DELETE SET NULL;
-- Indexes on the new columns come last, once the columns are certain to exist.
CREATE INDEX IF NOT EXISTS invoice_items_performer_idx ON invoice_items (performed_by) WHERE performed_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_items_commission_payout_idx ON invoice_items (commission_payout_id) WHERE commission_payout_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_referral_payout_idx ON invoices (referral_payout_id) WHERE referral_payout_id IS NOT NULL;

-- ── Sign in with mobile or email (Phase 5) ────────────────────────────────────────────
-- Every change here is additive. No existing user row is edited, moved or deleted: every account made before this
-- change has an email, so it keeps signing in exactly as before.

-- A team member can now be made with a mobile number and no email.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

-- The comparable form of a mobile number: its last 10 digits, so "+91 98400-12345", "098400 12345" and "9840012345" are
-- one number (the same rule referrers use). It is worked out by the database from users.mobile, so it can never drift
-- from what was typed, and every existing row gets it without being edited. A number with fewer than 10 digits has
-- none (NULL): it stays on the account but cannot be used to sign in, and it is not part of the uniqueness rule.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_normalised text GENERATED ALWAYS AS (
  CASE WHEN length(regexp_replace(mobile, '\D', '', 'g')) >= 10
       THEN right(regexp_replace(mobile, '\D', '', 'g'), 10)
  END
) STORED;

-- Whoever has no email needs a mobile number to sign in with, and only staff may have no email at all (a parlour's
-- admin and the platform admin keep one). All existing rows have an email, so these cannot fail on existing data.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_identifier_check;
ALTER TABLE users ADD CONSTRAINT users_identifier_check CHECK (email IS NOT NULL OR mobile_normalised IS NOT NULL);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_role_check;
ALTER TABLE users ADD CONSTRAINT users_email_role_check CHECK (email IS NOT NULL OR role = 'staff');

-- One account per mobile number across the whole platform (login is by email OR mobile, so a number must name one person).
-- Existing data is never merged or fixed for you: if two accounts already share a number, the index is NOT created, a
-- warning is printed (db:init prints it again after the schema is applied), and `npm run report:user-mobiles` lists them.
-- Until the index exists the API still refuses a new or changed number that another account already has, and signing in
-- by a number that two accounts share is refused (those accounts can still sign in by email).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE mobile_normalised IS NOT NULL GROUP BY mobile_normalised HAVING count(*) > 1) THEN
    RAISE WARNING 'users_mobile_key was NOT created: some accounts share a mobile number. Run: npm run report:user-mobiles';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS users_mobile_key ON users (mobile_normalised) WHERE mobile_normalised IS NOT NULL;
  END IF;
END $$;

-- ── Appointments (Phase 6) ────────────────────────────────────────────────────────────
-- Every change here is additive: two new tables. No existing row is edited, moved or deleted.
--
-- One row is one visit: either a BOOKING (a customer chose a time) or a WALK-IN (they are here now and join the queue).
--   status  booked      a booking still to come                        (bookings only)
--           waiting     a walk-in in the queue, no slot yet            (walk-ins only)
--           in_service  the work has begun
--           completed   billed: set only when a bill is made from it, and it then points at that bill (invoice_id)
--           cancelled   will not happen (the visit stays on record)
--           no_show     a booking whose time passed and nobody came    (bookings only)
-- starts_at is the booked time, or the arrival time of a walk-in (the database clock), or the moment the work began.
-- Money is never stored here: the bill works the price out on the day, in integer paise, on the server.
CREATE TABLE IF NOT EXISTS appointments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id        uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('booked', 'walk_in')),
  status            text NOT NULL CHECK (status IN ('booked', 'waiting', 'in_service', 'completed', 'cancelled', 'no_show')),
  customer_id       uuid REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     text NOT NULL DEFAULT 'Walk-in',   -- written down, so it survives the customer being removed
  customer_phone    text,
  performer_id      uuid REFERENCES performers(id) ON DELETE SET NULL,
  starts_at         timestamptz NOT NULL,
  duration_min      integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 600),
  notes             text,
  cancel_reason     text,
  reminder_sent_at  timestamptz,                       -- when someone opened the WhatsApp reminder (not proof it was sent or read)
  invoice_id        uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- A walk-in is never "booked" or a "no-show"; a booking is never "waiting".
  CONSTRAINT appointments_kind_status_check CHECK (
    (kind = 'booked' AND status IN ('booked', 'in_service', 'completed', 'cancelled', 'no_show'))
    OR (kind = 'walk_in' AND status IN ('waiting', 'in_service', 'completed', 'cancelled'))
  ),
  -- Only a billed visit points at a bill.
  CONSTRAINT appointments_invoice_check CHECK (invoice_id IS NULL OR status = 'completed')
);
-- A bill closes at most one visit.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_invoice_key ON appointments (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_parlour_start_idx ON appointments (parlour_id, starts_at);
CREATE INDEX IF NOT EXISTS appointments_performer_idx ON appointments (performer_id, starts_at) WHERE performer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS appointments_open_idx ON appointments (parlour_id, status) WHERE status IN ('booked', 'waiting', 'in_service');

-- What the visit is for: the name and minutes are written down, so renaming or removing a service never changes the visit.
CREATE TABLE IF NOT EXISTS appointment_services (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  service_id      uuid REFERENCES services(id) ON DELETE SET NULL,
  name            text NOT NULL,
  duration_min    integer NOT NULL CHECK (duration_min > 0),
  quantity        integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 50),
  position        integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS appointment_services_appt_idx ON appointment_services (appointment_id, position);

-- ── Attendance by Staff: staff record attendance for performers ──────────────────────────
-- Performers have no login, so a signed-in staff member or admin records their check-in and check-out.
-- This is a SEPARATE table from attendance_records (a person's own GPS attendance, keyed by users.id):
-- a performer's id is never stored in user_id, and nothing in attendance_records is read or changed.
--
-- One row per performer per parlour per work date. work_date is the date on the parlour's own clock
-- (parlours.timezone); times are always the database clock (now()), never a time sent by the browser.
-- marked_by_user_id is who recorded the CHECK-IN; check_out_marked_by_user_id is who recorded the check-out
-- (the same person or a different one). Both come from the signed token, never from the request.

-- The two keys below let the table below point at (id, parlour_id) so the DATABASE refuses a performer or a
-- user from another parlour, whatever the API does. Each id is already unique, so these can never fail on existing data.
CREATE UNIQUE INDEX IF NOT EXISTS performers_id_parlour_key ON performers (id, parlour_id);
CREATE UNIQUE INDEX IF NOT EXISTS users_id_parlour_key ON users (id, parlour_id);

CREATE TABLE IF NOT EXISTS performer_attendance_records (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parlour_id                   uuid NOT NULL REFERENCES parlours(id) ON DELETE CASCADE,
  performer_id                 uuid NOT NULL,
  work_date                    date NOT NULL,
  check_in_at                  timestamptz NOT NULL DEFAULT now(),
  check_out_at                 timestamptz,
  marked_by_user_id            uuid NOT NULL,
  check_out_marked_by_user_id  uuid,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),

  -- Same-parlour foreign keys. No ON DELETE action: a performer or user with attendance on record cannot be
  -- deleted out from under it. They are checked at COMMIT (DEFERRABLE INITIALLY DEFERRED) so that deleting a whole
  -- parlour, which cascades to all three tables, works whatever order PostgreSQL removes them in.
  CONSTRAINT performer_attendance_performer_fk     FOREIGN KEY (performer_id, parlour_id)                  REFERENCES performers (id, parlour_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT performer_attendance_marked_by_fk     FOREIGN KEY (marked_by_user_id, parlour_id)             REFERENCES users (id, parlour_id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT performer_attendance_out_marked_by_fk FOREIGN KEY (check_out_marked_by_user_id, parlour_id)  REFERENCES users (id, parlour_id) DEFERRABLE INITIALLY DEFERRED,

  -- No second record for the same performer on the same day, however many requests race.
  CONSTRAINT performer_attendance_one_per_day UNIQUE (parlour_id, performer_id, work_date),
  -- A check-out is all there or not there at all (time and who), and never before the check-in.
  CONSTRAINT performer_attendance_checkout_complete CHECK ((check_out_at IS NULL) = (check_out_marked_by_user_id IS NULL)),
  CONSTRAINT performer_attendance_checkout_after_checkin CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
CREATE INDEX IF NOT EXISTS performer_attendance_parlour_date_idx ON performer_attendance_records (parlour_id, work_date DESC);
CREATE INDEX IF NOT EXISTS performer_attendance_performer_date_idx ON performer_attendance_records (performer_id, work_date DESC);
CREATE INDEX IF NOT EXISTS performer_attendance_marked_by_idx ON performer_attendance_records (marked_by_user_id);
