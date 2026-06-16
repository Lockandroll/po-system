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

module.exports = { sendSms };
