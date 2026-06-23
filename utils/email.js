function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function sendEmail(to, subject, html, cc, attachments) {
  if (!process.env.RESEND_API_KEY) { console.warn('RESEND_API_KEY not set — skipping email'); return; }
  try {
    const body = {
      from: process.env.FROM_EMAIL || 'Lock and Roll <onboarding@resend.dev>',
      to: Array.isArray(to) ? to : [to],
      subject,
      html
    };
    if (cc && cc.length > 0) body.cc = Array.isArray(cc) ? cc : [cc];
    if (attachments && attachments.length) body.attachments = attachments;
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('Resend error ' + resp.status + ':', text);
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

function emailTemplate({ badge, badgeColor, title, body, details, buttonText, buttonUrl, footerNote }) {
  var badgeBg = badgeColor === 'green' ? '#dcfce7' : badgeColor === 'red' ? '#fee2e2' : '#fff3e8';
  var badgeFg = badgeColor === 'green' ? '#15803d' : badgeColor === 'red' ? '#b91c1c' : '#c2520a';

  var detailRows = (details || []).map(function(d) {
    return '<tr>' +
      '<td style="color:#777777;font-size:13px;padding:7px 0;border-bottom:1px solid #eeeeee;width:45%">' + esc(d.label) + '</td>' +
      '<td style="font-size:13px;font-weight:700;color:#111111;padding:7px 0;border-bottom:1px solid #eeeeee;text-align:right">' + esc(d.value) + '</td>' +
    '</tr>';
  }).join('');

  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style>@media(max-width:600px){.email-wrap{padding:16px 8px !important}.email-card{border-radius:0 !important}}</style></head>' +
  '<body style="margin:0;padding:0;background:#e5e5e5;font-family:-apple-system,Helvetica Neue,Arial,sans-serif">' +
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="email-wrap" style="padding:32px 16px">' +
  '<table role="presentation" class="email-card" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden">' +

  '<tr><td style="background:#111111;padding:20px 28px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="background:#f97316;width:36px;height:36px;border-radius:6px;text-align:center;vertical-align:middle;font-size:18px;line-height:36px">🔒</td>' +
      '<td style="padding-left:12px;color:#ffffff;font-size:16px;font-weight:700;vertical-align:middle">Lock and Roll LLC</td>' +
    '</tr></table>' +
  '</td></tr>' +

  '<tr><td style="padding:32px 28px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
      '<td style="background:' + badgeBg + ';color:' + badgeFg + ';font-size:11px;font-weight:700;padding:4px 10px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px">' + badge + '</td>' +
    '</tr></table>' +
    '<h1 style="font-size:20px;font-weight:700;color:#111111;margin:16px 0 12px">' + title + '</h1>' +
    '<p style="font-size:14px;color:#555555;line-height:1.6;margin:0 0 24px">' + body + '</p>' +

    (details && details.length ?
      '<table role="presentation" width="100%" style="background:#f7f7f7;border-radius:6px;margin-bottom:28px;border-collapse:collapse"><tr><td style="padding:4px 16px">' +
        '<table role="presentation" width="100%" style="border-collapse:collapse">' + detailRows + '</table>' +
      '</td></tr></table>'
    : '') +

    '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:28px"><tr>' +
      '<td style="background:#f97316;border-radius:6px">' +
        '<a href="' + buttonUrl + '" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:0.2px">' + buttonText + ' &rarr;</a>' +
      '</td>' +
    '</tr></table>' +

    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid #eeeeee;padding-top:20px">' +
      '<p style="font-size:12px;color:#aaaaaa;line-height:1.6;margin:0">' +
        (footerNote || 'You\'re receiving this because you\'re a member of the Lock and Roll PO system. Notification preferences can be updated in your account settings.') +
      '</p>' +
    '</td></tr></table>' +
  '</td></tr>' +

  '</table></td></tr></table>' +
  '</body></html>';
}

module.exports = { sendEmail, emailTemplate };
