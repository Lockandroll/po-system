async function sendSms(to, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
    console.warn('Twilio not configured — skipping SMS');
    return;
  }
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
  const authHeader = 'Basic ' + Buffer.from(sid + ':' + auth).toString('base64');
  for (const phone of recipients) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ From: from, To: phone, Body: message }).toString()
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error('Twilio error ' + resp.status + ' to ' + phone + ':', text);
      }
    } catch (err) {
      console.error('SMS send failed to ' + phone + ':', err.message);
    }
  }
}

// Like sendSms, but for ONE recipient and it says what happened: { ok, sid, error }.
// Added for the customer Google review request (utils/invoiceReviewRequest.js),
// which has to show the tech whether the text actually went. sendSms is left
// exactly as it was for its existing callers, which ignore the result.
async function sendSmsDetailed(to, message) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
    return { ok: false, error: 'Text messaging is not configured (Twilio).' };
  }
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + sid + '/Messages.json';
  const authHeader = 'Basic ' + Buffer.from(sid + ':' + auth).toString('base64');
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: from, To: to, Body: message }).toString()
    });
    const text = await resp.text();
    let j = null; try { j = JSON.parse(text); } catch (e) {}
    if (!resp.ok) {
      console.error('Twilio error ' + resp.status + ' to ' + to + ':', text);
      return { ok: false, error: (j && j.message) ? j.message : ('Twilio ' + resp.status) };
    }
    return { ok: true, sid: (j && j.sid) || null };
  } catch (err) {
    console.error('SMS send failed to ' + to + ':', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendSms, sendSmsDetailed };
