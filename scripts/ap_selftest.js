// Self-test for the pure helpers in utils/ap.js. No DB, no network.
// Run: node scripts/ap_selftest.js   (needs pg installed only because utils/ap
// requires ../db at load; nothing here touches the pool).
const ap = require('../utils/ap');

var pass = 0, fail = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error('FAIL ' + name + '\n  got  ' + g + '\n  want ' + w); }
}

// --- nextMonthlyDue -------------------------------------------------------
eq('nextMonthly basic', ap.nextMonthlyDue('2026-01-15', null), '2026-02-15');
eq('nextMonthly year roll', ap.nextMonthlyDue('2026-12-15', null), '2027-01-15');
eq('nextMonthly clamp 31->28', ap.nextMonthlyDue('2026-01-31', null), '2026-02-28');
eq('nextMonthly explicit day', ap.nextMonthlyDue('2026-01-15', 3), '2026-02-03');
eq('nextMonthly explicit day clamp', ap.nextMonthlyDue('2026-01-15', 31), '2026-02-28');
eq('nextMonthly bad input', ap.nextMonthlyDue('nope', null), null);

// --- addDays / clampDom ---------------------------------------------------
eq('addDays simple', ap.addDays('2026-08-10', 3), '2026-08-13');
eq('addDays month roll', ap.addDays('2026-08-30', 3), '2026-09-02');
eq('addDays year roll', ap.addDays('2026-12-31', 1), '2027-01-01');
eq('clampDom low', ap.clampDom(0), 1);
eq('clampDom mid', ap.clampDom(15), 15);
eq('clampDom high', ap.clampDom(40), 28);
eq('clampDom bad', ap.clampDom('x'), null);

// --- money / ymd ----------------------------------------------------------
eq('money commas', ap.money('1,234.56'), 1234.56);
eq('money dollar', ap.money('$99'), 99);
eq('money empty', ap.money(''), null);
eq('money junk', ap.money('abc'), null);
eq('ymd good', ap.ymd('2026-08-10', 'fb'), '2026-08-10');
eq('ymd bad', ap.ymd('2026/08/10', 'fb'), 'fb');

// --- computeSummary -------------------------------------------------------
const bills = [
  { status: 'unpaid', amount: 100, due_date: '2026-08-05' }, // overdue
  { status: 'unpaid', amount: 50, due_date: '2026-08-12' },  // due within 7
  { status: 'unpaid', amount: 25, due_date: '2026-09-01' },  // not soon
  { status: 'paid', amount: 200, paid_amount: 200, due_date: '2026-07-01' },
  { status: 'review', amount: 0, due_date: null },
  { status: 'void', amount: 999, due_date: '2026-08-01' }
];
const sm = ap.computeSummary(bills, { today: '2026-08-10', dueSoonDays: 7 });
eq('summary unpaid_count', sm.unpaid_count, 3);
eq('summary unpaid_total', sm.unpaid_total, 175);
eq('summary overdue_count', sm.overdue_count, 1);
eq('summary overdue_total', sm.overdue_total, 100);
eq('summary due_soon_count', sm.due_soon_count, 1);
eq('summary due_soon_total', sm.due_soon_total, 50);
eq('summary paid_total', sm.paid_total, 200);
eq('summary review_count', sm.review_count, 1);

// --- amount parsing -------------------------------------------------------
eq('amount labeled', ap.parseAmountFromText('Amount Due: $1,234.56'), 1234.56);
eq('amount please pay', ap.parseAmountFromText('Please pay 300.00 by Friday'), 300);
eq('amount none', ap.parseAmountFromText('no money here'), null);
eq('amount max unlabeled', ap.parseAmountFromText('charges $1,000 and $2,000'), 2000);

// --- date parsing ---------------------------------------------------------
eq('date US slash', ap.parseDateFromText('Due date: 08/15/2026'), '2026-08-15');
eq('date iso', ap.parseDateFromText('due 2026-09-01 please'), '2026-09-01');
eq('date long', ap.parseDateFromText('Payment due September 5, 2026'), '2026-09-05');
eq('date none', ap.parseDateFromText('no date at all'), null);

// --- bill number ----------------------------------------------------------
eq('billno hash', ap.parseBillNumber('Invoice #INV-1002 attached'), 'INV-1002');
eq('billno skips word', ap.parseBillNumber('Invoice from Acme, see Invoice #A-77'), 'A-77');
eq('billno account', ap.parseBillNumber('your account 12345 is due'), '12345');
eq('billno none', ap.parseBillNumber('nothing relevant here'), null);

// --- parseBillEmail end-to-end -------------------------------------------
const pe = ap.parseBillEmail({
  subject: 'Fwd: Invoice from Acme Utilities',
  text: 'Amount Due: $150.00  Due date: 09/01/2026  Invoice #A-77'
});
eq('email payee', pe.payee, 'Acme Utilities');
eq('email amount', pe.amount, 150);
eq('email due', pe.due_date, '2026-09-01');
eq('email billno', pe.bill_number, 'A-77');

console.log('\nap self-test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
