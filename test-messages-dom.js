// Memos & Messaging, client side (public/js/memos.js), in jsdom against the
// REAL app.js (menu, permission gate) and the real memos.js screens.
//
//   node test-messages-dom.js
//
// Proves: the menu row is renamed and shows for manage_memos OR send_messages
// (and for nobody else); the list carries New Message, the Memos / Messages
// filter, kind badges and the Unmatched texts card; a scoped manager gets no
// New Memo, no filter and no "Sign it"; the New Message compose picks people,
// counts characters, warns about texting personal details and refuses to send
// without a subject, text or recipient; the reader shows "Got it", "Marked as
// read" or the signature pad depending on what was asked; the one-person
// tracker shows the steps and the conversation, and says a reply goes back as
// a text when they wrote by text.
//
// House style: string concatenation only, no template literals.
const fs = require('fs');
const { JSDOM } = require('jsdom');

var pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) pass++; else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); } }
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ', expected ' + JSON.stringify(b)); }
function tick(ms) { return new Promise(function (r) { setTimeout(r, ms || 0); }); }

var NOW = new Date().toISOString();
var PEOPLE = [
  { id: 11, name: 'Jordan Price', role: 'locksmith', role_label: 'Locksmith', city: 'ORL', has_phone: true },
  { id: 12, name: 'Chris Delgado', role: 'roadside_technician', role_label: 'Roadside Technician', city: 'TPA', has_phone: true },
  { id: 13, name: 'Ray Ortiz', role: 'roadside_technician', role_label: 'Roadside Technician', city: 'CLW', has_phone: false }
];
function msg(over) {
  return Object.assign({ id: 5, kind: 'message', memo_no: 'MSG-2026-001', type: 'Message', title: 'Background check', note: null,
    body: 'Hi Jordan, please finish your background check by Friday.', require_signature: false, require_response: true, file_to_record: true,
    lock_until_done: false, audience: { mode: 'people', cities: [], roles: [], user_ids: [11] }, audience_label: '1 picked',
    notify_push: true, notify_sms: true, notify_email: false, remind_every_days: 0, allow_feedback: true, status: 'sent',
    sent_at: NOW, sent_by_name: 'Tony McKeon', updated_at: NOW, ack_text: 'I confirm that I received and read this message.', has_file: false }, over || {});
}

async function main() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="app"></div><div id="content"></div></body></html>', { runScripts: 'outside-only', url: 'https://nova.test/' });
  const w = dom.window;
  w.fetch = async function () { return { ok: true, status: 200, headers: { get: function () { return null; } }, json: async function () { return {}; } }; };
  w.IntersectionObserver = function () { this.observe = function () {}; this.disconnect = function () {}; };
  var setter = '\nwindow.__set = function (code) { eval(code); };\nwindow.__get = function (code) { return eval(code); };\n';
  w.eval(['app.js', 'employeeRecords.js', 'memos.js'].map(function (f) { return fs.readFileSync('public/js/' + f, 'utf8'); }).join('\n;\n') + setter);

  var ROUTES = {};
  var calls = [];
  w._apiFetch = async function (method, path, body) {
    calls.push({ method: method, path: path, body: body });
    var k = method + ' ' + path.split('?')[0];
    var v = ROUTES[k];
    if (typeof v === 'function') v = v(body, path);
    if (v === undefined) return {};
    if (v && v.__error) { var e = new Error(v.__error); throw e; }
    return JSON.parse(JSON.stringify(v));
  };
  w.navigate = function (v, id) { w.__nav = [v, id]; };
  var host = w.document.getElementById('content');

  // ---------------------------------------------------------------- menu
  function menuHtml(user, perms) {
    w.__set("state.token = 't'; state.user = " + JSON.stringify(user) + "; state.permissions = " + JSON.stringify(perms) + "; state._permsLoaded = true; state.sidebarSection = 'people';");
    return w.buildNavHtml();
  }
  var ownerMenu = menuHtml({ id: 1, name: 'Tony McKeon', role: 'admin', isOwner: true }, {});
  ok('the owner sees "Memos & Messaging"', ownerMenu.indexOf('Memos &amp; Messaging') !== -1 || ownerMenu.indexOf('Memos & Messaging') !== -1);
  ok('the old "Memos" label is gone', !/>Memos</.test(ownerMenu));
  var samMenu = menuHtml({ id: 2, name: 'Sam', role: 'manager', extra_perms: ['send_messages'] }, { manager: ['view_schedule'] });
  ok('a manager with send_messages sees it', samMenu.indexOf('Memos &amp; Messaging') !== -1 || samMenu.indexOf('Memos & Messaging') !== -1);
  var monaMenu = menuHtml({ id: 3, name: 'Mona', role: 'manager' }, { manager: ['view_schedule'] });
  ok('a manager without it does not', monaMenu.indexOf('Memos &amp; Messaging') === -1 && monaMenu.indexOf('Memos & Messaging') === -1);
  var techMenu = menuHtml({ id: 11, name: 'Jordan', role: 'locksmith' }, { locksmith: [] });
  ok('a tech does not', techMenu.indexOf('Memos &amp; Messaging') === -1 && techMenu.indexOf('Memos & Messaging') === -1);

  // Owner from here on. (app.js normalizes an owner to role admin + isOwner.)
  w.__set("state.user = { id: 1, name: 'Tony McKeon', role: 'admin', isOwner: true }; state.currentView = 'memos';");

  // ---------------------------------------------------------------- list
  ROUTES['GET /memos'] = {
    stats: { open_memos: 1, messages_waiting: 1, feedback_unread: 1, locked_now: 0, overdue: 0 },
    scope: { full: true, cities: null },
    memos: [
      msg({ to_names: 'Jordan Price', counts: { total: 1, viewed: 1, completed: 1, excused: 0, by_text: 1, feedback: 1, feedback_unread: 1 }, last_completed_at: NOW }),
      Object.assign(msg({ id: 6, memo_no: 'MEMO-2026-001', kind: 'memo', type: 'Policy update', title: 'PTO Policy Change', require_signature: true, audience_label: 'Everyone' }),
        { counts: { total: 40, viewed: 30, completed: 20, excused: 0 } })
    ]
  };
  ROUTES['GET /memos/texts/unmatched'] = { texts: [
    { id: 1, from_number: '+14075550142', user_id: 11, user_name: 'Jordan Price', role_label: 'Locksmith', user_city: 'ORL', body: 'Can I swap Saturday?', media_count: 0, reason: 'Nothing that takes a reply was texted to Jordan Price in the last 7 days.', received_at: NOW, memos: [{ id: 5, memo_no: 'MSG-2026-001', title: 'Background check', kind: 'message' }] },
    { id: 2, from_number: '+19045550199', user_id: null, user_name: null, body: 'New number', media_count: 1, reason: 'Number not on any Nova account.', received_at: NOW, memos: [] }
  ] };
  await w.renderMemos(host);
  await tick(30);
  var t = host.innerHTML;
  ok('the page is called Memos & Messaging', t.indexOf('<h1 style="font-size:24px">Memos &amp; Messaging</h1>') !== -1);
  ok('New Message and New Memo buttons', t.indexOf('New Message') !== -1 && t.indexOf('New Memo') !== -1);
  ok('All / Memos / Messages filter with counts', /All <small>2<\/small>/.test(t) && /Memos <small>1<\/small>/.test(t) && /Messages <small>1<\/small>/.test(t));
  ok('kind badges on each row', t.indexOf('mx-kind msg') !== -1 && t.indexOf('mx-kind memo') !== -1);
  ok('a one-person message says what happened in words', t.indexOf('Got it ') !== -1 && t.indexOf('texted back') !== -1);
  ok('and who it went to', t.indexOf('Jordan Price') !== -1);
  ok('new replies are flagged as replies', t.indexOf('1 new reply') !== -1);
  ok('the Unmatched texts card is there', t.indexOf('Unmatched texts') !== -1);
  ok('a known person can be attached to a message', t.indexOf('mmAttachText(1,this.value)') !== -1 && t.indexOf('MSG-2026-001 Background check') !== -1);
  ok('an unknown number offers Update their phone number', t.indexOf('mmTextPhone(2)') !== -1);
  w.mmKindFilter('message');
  t = host.innerHTML;
  ok('filtering to Messages hides the memo', t.indexOf('PTO Policy Change') === -1 && t.indexOf('Background check') !== -1);
  w.mmKindFilter('all');

  // a scoped manager
  ROUTES['GET /memos'] = { stats: { messages_waiting: 0, feedback_unread: 0 }, scope: { full: false, cities: ['TPA', 'CLW'] }, memos: [] };
  calls = [];
  await w.renderMemos(host);
  await tick(30);
  t = host.innerHTML;
  ok('a scoped manager gets New Message', t.indexOf('New Message') !== -1);
  ok('but no New Memo', t.indexOf('mmNew()') === -1);
  ok('no Memos/Messages filter', t.indexOf('mmKindFilter') === -1);
  ok('and their cities are named', t.indexOf('TPA, CLW') !== -1);
  ok('and the Unmatched texts list is never asked for', !calls.some(function (c) { return c.path.indexOf('/texts/unmatched') !== -1; }));

  // ---------------------------------------------------------------- compose
  var draft = msg({ id: 9, status: 'draft', memo_no: null, title: '', body: '', audience: { mode: 'people', cities: [], roles: [], user_ids: [] }, sent_at: null });
  ROUTES['GET /memos/meta'] = { types: ['Announcement'], cities: [{ code: 'ORL', name: 'Orlando' }], roles: [], people: PEOPLE, r2_ready: true, max_file_mb: 25,
    scope: { full: true, cities: null }, message_sms_chars: 300, max_message_chars: 2000 };
  ROUTES['GET /memos/9'] = { memo: draft };
  ROUTES['PUT /memos/9'] = function (b) { return { memo: Object.assign({}, draft, b, { updated_at: NOW }) }; };
  ROUTES['POST /memos/audience-preview'] = function (b) {
    var ids = (b.audience && b.audience.user_ids) || [];
    return { count: ids.length, lock_count: ids.length, exempt: [], no_text: ids.indexOf(13) !== -1 ? ['Ray Ortiz'] : [], no_email: [], by_city: {}, people: [] };
  };
  w.__set("state.currentView = 'memo-edit';");
  await w.renderMemoEdit(host, 9);
  await tick(320);
  t = host.innerHTML;
  ok('the New Message screen opens', t.indexOf('<h1 style="font-size:24px">New Message</h1>') !== -1);
  ok('with a To box, Subject and Message', !!w.document.getElementById('mx-to-q') && !!w.document.getElementById('mm-title') && !!w.document.getElementById('mm-body'));
  ok('the three answers, Sign it included for the full sender', t.indexOf('Just read it') !== -1 && /Tap (&quot;|&#34;|&#x22;|")Got it/.test(t) && t.indexOf('Sign it') !== -1);
  ok('the texting privacy hint', t.indexOf('Texts are not private') !== -1);
  ok('More options is folded into one line', t.indexOf('More options') !== -1 && t.indexOf('File in Employee File: on') !== -1);
  var probs = w._mm.msgProblems();
  ok('it will not send without a subject, text and a person', probs.indexOf('Give it a subject.') !== -1 && probs.indexOf('Write the message.') !== -1 && probs.indexOf('Pick who it is for.') !== -1, JSON.stringify(probs));
  ok('the Send button is off', w.document.getElementById('mm-send-btn').disabled === true);
  w.mmToQ('chr');
  ok('typing a name suggests people', w.document.getElementById('mx-sugg').innerHTML.indexOf('Chris Delgado') !== -1);
  w.mmPickPerson(12);
  await tick(320);
  ok('picking puts them in the To box', host.innerHTML.indexOf('mx-pill') !== -1 && host.innerHTML.indexOf('Chris Delgado') !== -1);
  w.mmField('title', 'Inspection photos');
  w.mmMsgBody('Your van inspection is missing the tire photos.');
  await tick(20);
  eq('nothing left to fix', w._mm.msgProblems(), []);
  ok('the summary names the person and says Got it', w.document.getElementById('mm-summary').innerHTML.indexOf('Chris taps or texts <b>Got it</b>') !== -1, w.document.getElementById('mm-summary').innerHTML);
  ok('the character count moves', w.document.getElementById('mx-count').textContent.indexOf('47 / 2,000') === 0, w.document.getElementById('mx-count').textContent);
  w.mmSet('respond', 'read');
  ok('"Just read it" turns off Got it and the lock', w.__get('_mm.MM.form.require_response') === false && w.__get('_mm.MM.form.lock_until_done') === false);
  var pl = w._mm.payload();
  ok('the save carries require_response and file_to_record', pl.require_response === false && pl.file_to_record === true);
  w.mmMoreToggle();
  ok('More options opens', host.innerHTML.indexOf('File in their Employee File') !== -1 && host.innerHTML.indexOf('Allow replies') !== -1);
  ok('and no lock row for "Just read it"', host.innerHTML.indexOf('Lock Nova until done') === -1);
  w.mmUnpick(12);
  await tick(320);
  ok('removing the person brings the warning back', w._mm.msgProblems().indexOf('Pick who it is for.') !== -1);

  // scoped compose
  ROUTES['GET /memos/meta'] = Object.assign({}, ROUTES['GET /memos/meta'], { scope: { full: false, cities: ['TPA', 'CLW'] }, people: PEOPLE.slice(1) });
  await w.renderMemoEdit(host, 9);
  await tick(320);
  t = host.innerHTML;
  ok('a scoped manager has no Sign it', t.indexOf('Sign it') === -1);
  ok('and no "More recipients"', t.indexOf('More recipients') === -1);
  ok('and is told whose cities', t.indexOf('You can message people in your cities: TPA, CLW') !== -1);

  // ---------------------------------------------------------------- reader
  w.__set("state.currentView = 'my-memo'; state.user = { id: 11, name: 'Jordan Price', role: 'locksmith' };");
  ROUTES['POST /memos/me/5/view'] = { success: true, completed_at: null };
  var rhost = w.document.createElement('div'); w.document.body.appendChild(rhost);
  w._mm.drawReader(rhost, msg({ my: { open: true, can_feedback: true } }), {});
  ok('a Got it message shows a Got it button', rhost.innerHTML.indexOf('&#10003; Got it') !== -1 || rhost.innerHTML.indexOf('✓ Got it') !== -1);
  ok('no memo header grid for a message', rhost.innerHTML.indexOf('mm-from') === -1);
  ok('a plain Reply box, blank', rhost.innerHTML.indexOf('<b>Reply</b>') !== -1 && w.document.getElementById('mm-fb-text').getAttribute('placeholder') === null);
  ok('and the hint that they can just reply to the text', rhost.innerHTML.indexOf('just reply to the text') !== -1);
  w._mm.drawReader(rhost, msg({ require_response: false, my: { open: true, can_feedback: true } }), {});
  ok('a Just-read-it message says it is done', rhost.innerHTML.indexOf('Marked as read. Nothing else to do.') !== -1);
  w._mm.drawReader(rhost, msg({ require_signature: true, my: { open: true, can_feedback: true } }), {});
  ok('a Sign-it message shows the signature pad', !!w.document.getElementById('mm-pad'));
  w._mm.drawReader(rhost, msg({ my: { completed_at: NOW, completion: 'acknowledged', completed_via: 'sms' } }), {});
  ok('done by text says so', rhost.innerHTML.indexOf('You said Got it') !== -1 && rhost.innerHTML.indexOf('(by text)') !== -1);

  // ---------------------------------------------------------------- file card
  var card = w._mm.memoCardsHtml([msg({ my: { completed_at: NOW, completion: 'acknowledged', completed_via: 'sms', delivered_at: NOW } })], 11);
  ok('the Employee File card says Message', card.indexOf('Message: Background check') !== -1 && card.indexOf('mx-kind msg') !== -1);
  ok('and Got it (by text)', card.indexOf('Got it') !== -1 && card.indexOf('(by text)') !== -1);

  // ---------------------------------------------------------------- one-person tracker
  w.__set("state.currentView = 'memo'; state.user = { id: 1, name: 'Tony McKeon', role: 'admin', isOwner: true };");
  ROUTES['GET /memos/5'] = { memo: msg(), counts: { total: 1, viewed: 0, completed: 1, excused: 0, viewed_open: 0, not_opened: 0, locked: 0, overdue: 0, reached_end: 1, feedback: 1, feedback_unread: 1 },
    recipients: [{ user_id: 11, user_name: 'Jordan Price', status: 'acknowledged', completion: 'acknowledged', completed_at: NOW, completed_via: 'sms', first_viewed_at: null,
      delivered_at: NOW, delivered_via: 'Nova, push, text', feedback_count: 1, feedback_unread: true, last_feedback_at: NOW, last_feedback_via: 'sms', role_label: 'Locksmith' }],
    events: [{ action: 'acknowledged', user_id: 11, actor_name: 'Jordan Price', detail: { via: 'sms' }, created_at: NOW }], related: {} };
  ROUTES['GET /memos/5/recipients/11/feedback'] = { user_name: 'Jordan Price', thread: [{ id: 1, author_name: 'Jordan Price', from_staff: false, body: 'I do not see the Checkr email.', created_at: NOW, via: 'sms' }] };
  await w.renderMemoTracker(host, 5);
  await tick(20);
  t = host.innerHTML;
  ok('a message to one person opens the compact view', t.indexOf('mx-steps') !== -1 && t.indexOf('Conversation with Jordan Price') !== -1);
  ok('Seen says he answered without opening Nova', t.indexOf('answered without opening Nova') !== -1);
  ok('Got it says he texted back', t.indexOf('Jordan texted back') !== -1);
  ok('his text shows as by text', t.indexOf('by text') !== -1 && t.indexOf('I do not see the Checkr email.') !== -1);
  ok('and the reply box says it goes back as a text', t.indexOf('replied by text, so your reply goes to them as a text') !== -1);
  ok('the history reads like a message', t.indexOf('Jordan Price texted back Got it') !== -1);

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.error(e); process.exit(1); });
