// Microsoft Graph helper - app-only (client credentials) access.
// Reads a mailbox's messages with an Azure AD app registration that has the
// Mail.Read APPLICATION permission (admin-consented). No user sign-in needed.
//
// Required env vars:
//   MS_TENANT_ID      - directory (tenant) ID of the popalockar.com tenant
//   MS_CLIENT_ID      - application (client) ID of the registered app
//   MS_CLIENT_SECRET  - a client secret value for that app

async function getAppToken() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !clientSecret) {
    throw new Error('Microsoft Graph env vars missing (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET)');
  }

  const url = 'https://login.microsoftonline.com/' + encodeURIComponent(tenant) + '/oauth2/v2.0/token';
  const form = new URLSearchParams();
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);
  form.set('grant_type', 'client_credentials');
  form.set('scope', 'https://graph.microsoft.com/.default');

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const data = await resp.json().catch(function () { return {}; });
  if (!resp.ok || !data.access_token) {
    throw new Error('Graph token request failed (' + resp.status + '): ' + JSON.stringify(data));
  }
  return data.access_token;
}

// Fetch messages from a mailbox sent by a given sender within a UTC time window.
// Body is returned as plain text (via the Prefer header) so field parsing is
// reliable. Returns an array of { subject, receivedDateTime, bodyText }.
// startIso / endIso are ISO 8601 UTC strings; the window is [start, end).
async function getSurveyMessages(mailbox, senderAddress, startIso, endIso) {
  const token = await getAppToken();

  const filter =
    "from/emailAddress/address eq '" + senderAddress + "'" +
    ' and receivedDateTime ge ' + startIso +
    ' and receivedDateTime lt ' + endIso;

  const params = new URLSearchParams();
  params.set('$filter', filter);
  params.set('$select', 'subject,receivedDateTime,internetMessageId,body');
  params.set('$top', '100');

  let url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(mailbox) +
    '/messages?' + params.toString();

  const out = [];
  let guard = 0;
  while (url && guard < 50) {
    guard++;
    const resp = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Prefer: 'outlook.body-content-type="text"'
      }
    });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      throw new Error('Graph messages request failed (' + resp.status + '): ' + JSON.stringify(data));
    }
    const items = Array.isArray(data.value) ? data.value : [];
    items.forEach(function (m) {
      out.push({
        subject: m.subject || '',
        receivedDateTime: m.receivedDateTime || '',
        internetMessageId: m.internetMessageId || '',
        bodyText: (m.body && m.body.content) ? m.body.content : ''
      });
    });
    url = data['@odata.nextLink'] || null;
  }
  return out;
}

// Fetch recent messages from a mailbox (received on/after sinceIso), with file
// attachments inlined as base64. Used by the Work Orders email intake job.
// Returns [{ id, subject, receivedDateTime, internetMessageId, fromAddress,
//            fromName, hasAttachments, bodyText, attachments:[{filename,mime,size,contentBytes}] }]
async function getInboxMessages(mailbox, sinceIso, opts) {
  opts = opts || {};
  const token = await getAppToken();

  const params = new URLSearchParams();
  if (sinceIso) params.set('$filter', 'receivedDateTime ge ' + sinceIso);
  params.set('$select', 'id,subject,receivedDateTime,internetMessageId,from,hasAttachments,body');
  params.set('$orderby', 'receivedDateTime desc');
  params.set('$top', String(opts.top || 25));
  if (opts.expandAttachments) params.set('$expand', 'attachments');

  let url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(mailbox) +
    '/messages?' + params.toString();

  const out = [];
  let guard = 0;
  while (url && guard < 20) {
    guard++;
    const resp = await fetch(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        Prefer: 'outlook.body-content-type="text"'
      }
    });
    const data = await resp.json().catch(function () { return {}; });
    if (!resp.ok) {
      throw new Error('Graph inbox request failed (' + resp.status + '): ' + JSON.stringify(data));
    }
    const items = Array.isArray(data.value) ? data.value : [];
    items.forEach(function (m) {
      const fromAddr = (m.from && m.from.emailAddress) ? m.from.emailAddress : {};
      const atts = [];
      if (Array.isArray(m.attachments)) {
        m.attachments.forEach(function (a) {
          if (a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes) {
            atts.push({
              filename: a.name || 'attachment',
              mime: a.contentType || '',
              size: a.size || 0,
              contentBytes: a.contentBytes,
              isInline: !!a.isInline
            });
          }
        });
      }
      out.push({
        id: m.id,
        subject: m.subject || '',
        receivedDateTime: m.receivedDateTime || '',
        internetMessageId: m.internetMessageId || '',
        fromAddress: fromAddr.address || '',
        fromName: fromAddr.name || '',
        hasAttachments: !!m.hasAttachments,
        bodyText: (m.body && m.body.content) ? m.body.content : '',
        attachments: atts
      });
    });
    url = (opts.paginate ? data['@odata.nextLink'] : null) || null;
  }
  return out;
}

// Fetch file attachments for a single message as base64 (used for new
// messages only, so we never re-download attachments on every poll).
// Returns [{ filename, mime, size, contentBytes }].
async function getMessageAttachments(mailbox, messageId) {
  const token = await getAppToken();
  const url = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(mailbox) +
    '/messages/' + encodeURIComponent(messageId) + '/attachments';
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await resp.json().catch(function () { return {}; });
  if (!resp.ok) {
    throw new Error('Graph attachments request failed (' + resp.status + '): ' + JSON.stringify(data));
  }
  const items = Array.isArray(data.value) ? data.value : [];
  const out = [];
  items.forEach(function (a) {
    if (a['@odata.type'] === '#microsoft.graph.fileAttachment' && a.contentBytes) {
      out.push({ filename: a.name || 'attachment', mime: a.contentType || '', size: a.size || 0, contentBytes: a.contentBytes, isInline: !!a.isInline });
    }
  });
  return out;
}

// Fetch messages whose SUBJECT starts with a fixed prefix, received in a UTC
// window [startIso, endIso). Built for the Swoop (Agero) review emails, whose
// sender address we do not control and have not pinned down, but whose subject
// is always "New Review for ID #<job>". Same return shape as getSurveyMessages.
//
// Graph accepts startswith(subject,...) combined with a receivedDateTime range
// on most mailboxes, but some tenants answer 400 "InefficientFilter". On a 400
// this falls back to the date-only filter and matches the subject here, with a
// page cap so a busy mailbox cannot turn one poll into thousands of reads.
async function getMessagesBySubject(mailbox, subjectPrefix, startIso, endIso) {
  const token = await getAppToken();
  const prefix = String(subjectPrefix || '');
  const base = 'https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(mailbox) + '/messages?';
  const dateFilter = 'receivedDateTime ge ' + startIso + ' and receivedDateTime lt ' + endIso;

  function buildUrl(withSubject) {
    const params = new URLSearchParams();
    params.set('$filter', dateFilter + (withSubject ? " and startswith(subject,'" + prefix.replace(/'/g, "''") + "')" : ''));
    params.set('$select', 'subject,receivedDateTime,internetMessageId,body');
    params.set('$top', '100');
    return base + params.toString();
  }

  async function run(withSubject, maxPages) {
    const out = [];
    let url = buildUrl(withSubject);
    let guard = 0;
    while (url && guard < maxPages) {
      guard++;
      const resp = await fetch(url, {
        headers: { Authorization: 'Bearer ' + token, Prefer: 'outlook.body-content-type="text"' }
      });
      const data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        const err = new Error('Graph messages request failed (' + resp.status + '): ' + JSON.stringify(data));
        err.status = resp.status;
        throw err;
      }
      const items = Array.isArray(data.value) ? data.value : [];
      items.forEach(function (m) {
        const subj = m.subject || '';
        if (subj.toLowerCase().indexOf(prefix.toLowerCase()) !== 0) return;
        out.push({
          subject: subj,
          receivedDateTime: m.receivedDateTime || '',
          internetMessageId: m.internetMessageId || '',
          bodyText: (m.body && m.body.content) ? m.body.content : ''
        });
      });
      url = data['@odata.nextLink'] || null;
    }
    return out;
  }

  try {
    return await run(true, 50);
  } catch (e) {
    if (e.status !== 400) throw e;
    console.warn('[graph] subject filter refused (' + e.message.slice(0, 160) + ') - falling back to date-only scan');
    return run(false, 20);
  }
}

module.exports = { getAppToken, getSurveyMessages, getInboxMessages, getMessageAttachments, getMessagesBySubject };
