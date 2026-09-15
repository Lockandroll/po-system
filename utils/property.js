// Shared logic for the Receipt of Property.
//
// Everything here is pure: no database, no network, no Express. It lives out of
// routes/property.js so the rules that decide which outcome/disposition pairs
// make sense, what blocks a receipt from being posted, and what posting will
// actually do to inventory can be read and tested on their own. Same split as
// utils/separation.js and utils/release.js.
//
// The one idea worth understanding before reading the rest: a line carries TWO
// answers, not one. OUTCOME is what happened to the item (did it come back).
// DISPOSITION is where it went afterwards (shelf, person, repair bench, bin).
// They are separate because they are separate facts - "he handed it back" does
// not say where it is now, and a receipt that only records the first is how a
// $2,200 programmer ends up in somebody's trunk with the paperwork all ticked.
//
// House style: string concatenation only, no template literals/backticks.

// What happened to it.
var OUTCOMES = ['returned', 'not_returned', 'lost', 'stolen', 'kept'];
// Outcomes where the item is physically in the company's hands again.
var RETURNED_OUTCOMES = ['returned'];
// Outcomes where it is gone and nothing goes back on the shelf.
var GONE_OUTCOMES = ['not_returned', 'lost', 'stolen', 'kept'];

// Where it went afterwards.
//   stock    - back into a location's inventory (needs dest_city_code)
//   person   - straight to another person, never touching the shelf (needs dest_user_id)
//   repair   - in hand but not fit to reissue
//   retire   - in hand but off the books for good
//   writeoff - not in hand; recorded as a loss
//   none     - nothing to do (untracked things, or an item handled elsewhere)
var DISPOSITIONS = ['stock', 'person', 'repair', 'retire', 'writeoff', 'none'];

var CONDITIONS = ['new', 'good', 'fair', 'poor'];

var OUTCOME_LABEL = {
  returned: 'Returned', not_returned: 'Not returned', lost: 'Lost',
  stolen: 'Stolen', kept: 'Kept by agreement'
};
var DISPOSITION_LABEL = {
  stock: 'Back to stock', person: 'Assigned on', repair: 'Needs repair',
  retire: 'Retired', writeoff: 'Written off', none: 'No action'
};

function usd(n) {
  var v = Number(n);
  if (!isFinite(v)) v = 0;
  return '$' + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function isReturned(outcome) { return RETURNED_OUTCOMES.indexOf(outcome) !== -1; }
function isGone(outcome) { return GONE_OUTCOMES.indexOf(outcome) !== -1; }

// Which dispositions make sense for an outcome. An item that never came back
// cannot go back on a shelf, and an item sitting on the counter is not a
// write-off - refusing the impossible pairs here is cheaper than explaining a
// stock count that grew when nothing was handed in.
//
// The tracked flag narrows it further: a fuel card or a shop key has no inventory
// behind it, so "back to stock" and "needs repair" mean nothing for one.
function allowedDispositions(outcome, tracked) {
  if (isGone(outcome)) return ['writeoff'];
  if (!tracked) return ['person', 'retire', 'none'];
  return ['stock', 'person', 'repair', 'retire'];
}

// Validate one line. Returns an array of plain-language problems, empty when the
// line is fine. The line is whatever the browser sent, so nothing is assumed.
function checkLine(line) {
  line = line || {};
  var out = [];
  var name = line.label || 'This item';
  if (OUTCOMES.indexOf(line.outcome) === -1) {
    out.push(name + ': pick what happened to it.');
    return out;
  }
  if (DISPOSITIONS.indexOf(line.disposition) === -1) {
    out.push(name + ': pick where it goes.');
    return out;
  }
  var allowed = allowedDispositions(line.outcome, line.tracked !== false);
  if (allowed.indexOf(line.disposition) === -1) {
    out.push(name + ': ' + (OUTCOME_LABEL[line.outcome] || line.outcome).toLowerCase() +
      ' cannot go to ' + (DISPOSITION_LABEL[line.disposition] || line.disposition).toLowerCase() + '.');
  }
  if (line.disposition === 'stock' && !line.dest_city_code) out.push(name + ': which location does it go back to?');
  if (line.disposition === 'person' && !line.dest_user_id) out.push(name + ': who is taking it?');
  if (line.condition_in && CONDITIONS.indexOf(line.condition_in) === -1) out.push(name + ': that is not a condition.');
  var qty = Number(line.qty);
  if (!isFinite(qty) || qty < 1) out.push(name + ': quantity has to be at least 1.');
  return out;
}

// What stops the whole receipt being posted. Every problem at once, never just
// the first, so a manager fixes the page in one pass rather than five.
function missingForPost(lines) {
  lines = lines || [];
  if (!lines.length) return ['There is nothing on this receipt. Add a line, or mark the offboarding as having no property to return.'];
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var problems = checkLine(lines[i]);
    for (var j = 0; j < problems.length; j++) out.push(problems[j]);
  }
  return out;
}

// The running totals the screen and the PDF both show. One implementation, so
// the number on the signed document is the number the manager was looking at.
function totals(lines) {
  lines = lines || [];
  var t = {
    lines: lines.length, items: 0, returned: 0, gone: 0,
    to_stock: 0, to_person: 0, to_repair: 0, retired: 0,
    value_in_hand: 0, value_not_returned: 0
  };
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i] || {};
    var qty = Number(l.qty) || 0;
    var cost = Number(l.unit_cost) || 0;
    t.items += qty;
    t.value_in_hand += qty * cost;
    if (isReturned(l.outcome)) t.returned += 1; else if (isGone(l.outcome)) {
      t.gone += 1;
      t.value_not_returned += qty * cost;
    }
    if (l.disposition === 'stock') t.to_stock += 1;
    else if (l.disposition === 'person') t.to_person += 1;
    else if (l.disposition === 'repair') t.to_repair += 1;
    else if (l.disposition === 'retire') t.retired += 1;
  }
  t.value_in_hand = Math.round(t.value_in_hand * 100) / 100;
  t.value_not_returned = Math.round(t.value_not_returned * 100) / 100;
  return t;
}

// A sentence saying what pressing Post will actually do, built from the same
// lines that will do it. Shown above the button, because this moves real
// inventory and "are you sure?" is not an explanation.
function postSummary(lines, nameForPerson) {
  var t = totals(lines);
  var tracked = (lines || []).filter(function (l) { return l && l.tracked !== false && l.holding_id; }).length;
  var bits = [];
  if (tracked) bits.push('closes ' + tracked + ' holding' + (tracked === 1 ? '' : 's'));
  if (t.to_stock) bits.push('puts ' + t.to_stock + ' item' + (t.to_stock === 1 ? '' : 's') + ' back into stock');
  if (t.to_person) bits.push('opens ' + t.to_person + ' new holding' + (t.to_person === 1 ? '' : 's') +
    (nameForPerson ? (' against ' + nameForPerson) : ''));
  if (t.to_repair) bits.push('flags ' + t.to_repair + ' for repair');
  if (t.retired) bits.push('retires ' + t.retired);
  if (t.gone) bits.push('records ' + t.gone + ' as not recovered (' + usd(t.value_not_returned) + ')');
  if (!bits.length) return 'Posting this receipt records the list. Nothing moves in inventory.';
  return 'Posting ' + bits.join(', ') + '.';
}

// Translate one line into the options closeHolding() in routes/assets.js takes.
// That function is the ONLY correct way to close a holding - it is what keeps
// assets.status, asset_stock and asset_stock_moves honest - so this maps onto
// it rather than writing a second version of the same rules.
//
// Two deliberate details:
//   * restock is false for every disposition except 'stock'. An item going
//     straight to another person never touches the shelf, so adding it to stock
//     and taking it out again would leave two phantom ledger rows.
//   * 'repair' forces condition_in to 'poor', because that is the value
//     closeHolding reads to land a serialized unit on needs_repair rather than
//     in_stock. Saying it here, once, beats discovering it in six months.
function closeOptionsFor(line) {
  var l = line || {};
  var gone = isGone(l.outcome);
  var reason = l.outcome === 'returned' ? 'returned' : l.outcome;
  return {
    reason: reason,
    status: (l.outcome === 'lost' || l.outcome === 'stolen') ? 'lost' : (gone ? 'not_returned' : 'returned'),
    condition_in: l.disposition === 'repair' ? 'poor' : (l.condition_in || null),
    physically_returned: !gone,
    restock: l.disposition === 'stock'
  };
}

// Where the stock (and a serialized unit's owning location) should end up. An
// item can be handed back in one city and shelved in another - that is the
// point of letting a manager pick - so the destination is read from the line
// and only falls back to where it was issued.
function restockCity(line, holding) {
  var l = line || {};
  if (l.disposition === 'stock' && l.dest_city_code) return String(l.dest_city_code).toUpperCase();
  return (holding && holding.city_code) || null;
}

module.exports = {
  OUTCOMES: OUTCOMES,
  RETURNED_OUTCOMES: RETURNED_OUTCOMES,
  GONE_OUTCOMES: GONE_OUTCOMES,
  DISPOSITIONS: DISPOSITIONS,
  CONDITIONS: CONDITIONS,
  OUTCOME_LABEL: OUTCOME_LABEL,
  DISPOSITION_LABEL: DISPOSITION_LABEL,
  usd: usd,
  esc: esc,
  isReturned: isReturned,
  isGone: isGone,
  allowedDispositions: allowedDispositions,
  checkLine: checkLine,
  missingForPost: missingForPost,
  totals: totals,
  postSummary: postSummary,
  closeOptionsFor: closeOptionsFor,
  restockCity: restockCity
};
