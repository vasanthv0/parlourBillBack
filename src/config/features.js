/**
 * The switchboard. Each entry is something the platform admin can turn on or off for ONE parlour.
 * This single list drives three things: the checks on the API, the sidebar in the web app,
 * and the toggles on the superadmin screen. To make something switchable, add a line here
 * and guard its route with requireFeature(key).
 *
 *   group 'page'   : a sidebar page
 *   group 'action' : a button on a page; `requires` names the page it lives on
 *   `requires` on a page means that page only works while another page is on (Commissions needs Performers)
 *
 * New billing and the bills list are not switchable: they are the product.
 */
const FEATURES = [
  { key: 'page.dashboard', group: 'page', label: 'Dashboard', description: 'Takings, trends and reports on the admin home screen.' },
  { key: 'page.customers', group: 'page', label: 'Customers', description: 'The customer list and customer search while billing. When off, bills are walk-in only.' },
  { key: 'page.services', group: 'page', label: 'Services', description: 'The page where prices, SAC codes and the menu are managed. The menu still works at the billing counter.' },
  { key: 'page.team', group: 'page', label: 'Team', description: 'The page for managing staff accounts.' },
  { key: 'page.settings', group: 'page', label: 'Settings', description: 'GST and GSTIN, whether prices include GST, bill number prefix, address and phone.' },
  { key: 'page.combos', group: 'page', label: 'Combos', description: 'Packages of services sold at one price, on their own page and on the billing screen.' },
  { key: 'page.attendance', group: 'page', label: 'Attendance', description: 'GPS check-in and check-out for staff, plus the salon location and the team’s attendance records for admins.' },
  { key: 'page.attendance_by_staff', group: 'page', label: 'Attendance by Staff', description: 'Lets staff record check-in and check-out for performers (who do not sign in), and gives the admin a history of it. A separate workflow: it does not change staff attendance (Attendance).' },
  { key: 'page.referrals', group: 'page', label: 'Referrals', description: 'The Referrals page, and the referral box on the billing screen.' },
  { key: 'page.performers', group: 'page', label: 'Performers', description: 'The people who perform services (names only, they do not sign in), the “Performed by” choice on each line of the billing screen, and sales by person on the dashboard.' },
  { key: 'page.commissions', group: 'page', requires: 'page.performers', label: 'Commissions', description: 'Commission rules per person or per service, what each person has earned in a date range, and marking it as paid. Needs the Performers page.' },
  { key: 'page.appointments', group: 'page', label: 'Appointments', description: 'The day calendar for each person, bookings, and the walk-in queue. Turn a visit into a bill in one tap.' },
  { key: 'action.services.add', group: 'action', requires: 'page.services', label: 'Add service button', description: 'Lets the parlour create new services. Existing services can still be edited.' },
  { key: 'action.team.add', group: 'action', requires: 'page.team', label: 'Add team member button', description: 'Lets the parlour create new staff accounts. Existing staff can still be managed.' },
  { key: 'action.team.edit', group: 'action', requires: 'page.team', label: 'Edit team member button', description: 'Lets the parlour change a team member’s name, mobile number and role.' },
  { key: 'action.team.reset', group: 'action', requires: 'page.team', label: 'Reset password button', description: 'Lets the parlour set a new password for a team member.' },
  { key: 'action.team.deactivate', group: 'action', requires: 'page.team', label: 'Deactivate / Reactivate button', description: 'Lets the parlour deactivate a team member, or bring them back.' },
  { key: 'action.combos.add', group: 'action', requires: 'page.combos', label: 'Add combo button', description: 'Lets the parlour create new combos. Existing combos can still be edited and deleted.' },
  { key: 'action.referrals.add', group: 'action', requires: 'page.referrals', label: 'Add referrer button', description: 'Lets the parlour register new referrers. Existing referrers can still be managed.' },
  { key: 'action.referrals.pay', group: 'action', requires: 'page.referrals', label: 'Mark referral as paid button', description: 'Lets the parlour record that what a referrer is owed has been paid to them.' },
  { key: 'action.performers.add', group: 'action', requires: 'page.performers', label: 'Add performer button', description: 'Lets the parlour add new people to the Performers list. Existing people can still be renamed and deactivated.' },
  { key: 'action.commissions.pay', group: 'action', requires: 'page.commissions', label: 'Mark commission as paid button', description: 'Lets the parlour record that a person has been paid the commission they earned.' },
  { key: 'action.whatsapp.send', group: 'action', label: 'Send on WhatsApp button', description: 'The button on a saved bill that opens WhatsApp with the bill ready to send.' },
  { key: 'action.payments.split', group: 'action', label: 'Split payment button', description: 'Lets the billing screen split one bill across cash, UPI and card. Paying a whole bill with one method always works.' },
  { key: 'action.payments.tip', group: 'action', label: 'Tip box', description: 'Lets the billing screen record a tip. A tip is kept apart from the bill total and is not taxed.' },
  { key: 'action.appointments.remind', group: 'action', requires: 'page.appointments', label: 'Appointment reminder button', description: 'Opens WhatsApp with a reminder written for the customer. A person presses Send; nothing is sent automatically.' },
  { key: 'action.appointments.bill', group: 'action', requires: 'page.appointments', label: 'Bill this visit button', description: 'Lets staff turn an appointment into a bill in one tap. Bills can still be made from the billing screen without it.' },
];

const KEYS = FEATURES.map((f) => f.key);

/** What the platform admin has set: every known key, on unless explicitly switched off. */
function storedFeatures(stored) {
  const out = {};
  for (const f of FEATURES) out[f.key] = !(stored && stored[f.key] === false);
  return out;
}

/**
 * What the parlour can actually use: a page or button is only available if the page it needs is. That chains:
 * "Mark commission as paid" needs Commissions, which needs Performers, so switching Performers off takes all three away.
 */
function effectiveFeatures(stored) {
  const set = storedFeatures(stored);
  const byKey = new Map(FEATURES.map((f) => [f.key, f]));
  const out = {};
  const resolve = (key) => {
    if (key in out) return out[key];
    const f = byKey.get(key);
    out[key] = set[key] && (!f.requires || resolve(f.requires));
    return out[key];
  };
  for (const f of FEATURES) resolve(f.key);
  return out;
}

module.exports = { FEATURES, KEYS, storedFeatures, effectiveFeatures };
