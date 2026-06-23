// Cloudflare R2 storage helper for the Documents vault.
// R2 speaks the S3 API, so we use the AWS S3 SDK pointed at the R2 endpoint.
// Files are uploaded and downloaded directly between the browser and R2 using
// short-lived presigned URLs - bytes never pass through this server, so there
// is no practical file-size limit and no load on Railway.
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET = process.env.R2_BUCKET;

// True only when every required env var is set. Routes check this and return a
// clear error instead of crashing if R2 has not been configured yet.
function configured() {
  return !!(ACCOUNT_ID && ACCESS_KEY && SECRET_KEY && BUCKET);
}

let _client = null;
function client() {
  if (_client) return _client;
  _client = new S3Client({
    region: 'auto',
    endpoint: 'https://' + ACCOUNT_ID + '.r2.cloudflarestorage.com',
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }
  });
  return _client;
}

// Presigned URL the browser PUTs the file bytes to. Valid for 10 minutes.
async function presignUpload(key, contentType) {
  const cmd = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || 'application/octet-stream'
  });
  return getSignedUrl(client(), cmd, { expiresIn: 600 });
}

// Presigned URL the browser GETs to download/preview the file. Valid 5 minutes.
// filename drives the Save-As name; inline=true lets PDFs/images preview in-tab.
async function presignDownload(key, filename, inline) {
  const disp = (inline ? 'inline' : 'attachment') +
    (filename ? '; filename="' + filename.replace(/"/g, '') + '"' : '');
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ResponseContentDisposition: disp
  });
  return getSignedUrl(client(), cmd, { expiresIn: 300 });
}

async function deleteObject(key) {
  if (!key) return;
  await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { configured, presignUpload, presignDownload, deleteObject };
