// Temporary, receive-only n8n intake. No Central client or sending path.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual} from 'node:crypto';

export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const RECORD_VERSION = 1;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const HASH_RE = /^[a-f0-9]{64}$/;

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function fail(message) { throw new Error(message); }

function privateFile(file, maxBytes, allowLinkedTemp = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== FILE_MODE || st.size > maxBytes ||
        (st.nlink !== 1 && !(allowLinkedTemp && st.nlink === 2))) fail('private_file_invalid');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function storageDir(dir) {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, {mode: DIR_MODE});
  const st = fs.lstatSync(resolved);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== DIR_MODE) fail('storage_dir_invalid');
  return fs.realpathSync(resolved);
}

function validateConfig(config) {
  const {dir, token, key, instance, workflowId} = config;
  const source = config.source ?? 'n8n';
  if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) fail('token_invalid');
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key_invalid');
  if (typeof instance !== 'string' || !instance || /[\r\n]/.test(instance)) fail('instance_invalid');
  if (source !== 'n8n' && source !== 'evolution') fail('source_invalid');
  if (source === 'n8n' && (typeof workflowId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(workflowId))) fail('workflow_invalid');
  if (source === 'evolution' && workflowId !== undefined) fail('workflow_not_applicable');
  return {...config, source, dir: storageDir(dir)};
}

export function loadConfig({dir, tokenFile, keyFile, instanceFile, workflowId, source = 'n8n', minFreeBytes = 0}) {
  const token = privateFile(tokenFile, 4096).toString('utf8').trimEnd();
  const key = privateFile(keyFile, 32);
  const instance = privateFile(instanceFile, 4096).toString('utf8').trimEnd();
  return validateConfig({dir, token, key, instance, workflowId, source, minFreeBytes});
}

export function recordId(instance, raw) {
  const name = Buffer.from(instance, 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(name.length);
  return sha256(Buffer.concat([length, name, raw]));
}

function aad(meta) { return Buffer.from(JSON.stringify(meta), 'utf8'); }

export function readRecord(file, key, expectedInstance, {allowLinkedTemp = false} = {}) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key_invalid');
  const filename = path.basename(file);
  if (!HASH_RE.test(filename.replace(/\.json$/, '')) || !filename.endsWith('.json')) fail('record_name_invalid');
  const encoded = privateFile(file, MAX_BODY_BYTES * 2, allowLinkedTemp);
  const record = JSON.parse(encoded.toString('utf8'));
  const {version, meta, iv, ciphertext, tag} = record;
  const source = meta?.source === undefined ? 'n8n' : meta.source;
  const validProvenance = source === 'n8n'
    ? typeof meta?.workflowId === 'string' && /^[A-Za-z0-9_-]+$/.test(meta.workflowId) && /^[0-9]+$/.test(meta.executionId)
    : source === 'evolution' && meta?.workflowId === null && meta.executionId === null;
  if (version !== RECORD_VERSION || !meta || meta.version !== RECORD_VERSION || !validProvenance ||
      typeof meta.instance !== 'string' || typeof meta.receivedAt !== 'string' ||
      !HASH_RE.test(meta.rawSha256) ||
      typeof iv !== 'string' || typeof ciphertext !== 'string' || typeof tag !== 'string') fail('record_invalid');
  if (expectedInstance !== undefined && meta.instance !== expectedInstance) fail('record_instance_mismatch');
  const ivBytes = Buffer.from(iv, 'base64');
  const tagBytes = Buffer.from(tag, 'base64');
  if (ivBytes.length !== 12 || tagBytes.length !== 16 || !/^[A-Za-z0-9+/]*={0,2}$/.test(ciphertext)) fail('record_encoding_invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, ivBytes);
  decipher.setAAD(aad(meta));
  decipher.setAuthTag(tagBytes);
  const raw = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  if (raw.length > MAX_BODY_BYTES || sha256(raw) !== meta.rawSha256 || filename !== `${recordId(meta.instance, raw)}.json`) fail('record_integrity_invalid');
  return {id: filename.slice(0, -5), meta: {...meta, source}, raw};
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function recoverLinkedTemp(dir, id, key, instance, raw, source) {
  const target = path.join(dir, `${id}.json`);
  const targetSt = fs.lstatSync(target);
  if (targetSt.nlink === 1) return readRecord(target, key, instance);
  if (targetSt.nlink !== 2) fail('record_links_invalid');
  const names = fs.readdirSync(dir).filter(name => new RegExp(`^\\.${id}\\.[a-f0-9]{24}\\.tmp$`).test(name));
  const matches = names.filter(name => {
    const st = fs.lstatSync(path.join(dir, name));
    return st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid() &&
      (st.mode & 0o777) === FILE_MODE && st.dev === targetSt.dev && st.ino === targetSt.ino;
  });
  if (matches.length !== 1) fail('record_temp_ambiguous');
  const existing = readRecord(target, key, instance, {allowLinkedTemp: true});
  if (!existing.raw.equals(raw) || existing.meta.source !== source) fail('record_collision');
  fs.unlinkSync(path.join(dir, matches[0]));
  fsyncDir(dir);
  return readRecord(target, key, instance);
}

function freeSpaceOK(config, bytes) {
  if (!config.minFreeBytes) return true;
  const stat = fs.statfsSync(config.dir);
  return BigInt(stat.bavail) * BigInt(stat.bsize) >= BigInt(config.minFreeBytes) + BigInt(bytes) * 2n;
}

export function persistRaw(configInput, raw, provenance, hooks = {}) {
  const config = validateConfig(configInput);
  if (!Buffer.isBuffer(raw) || raw.length > MAX_BODY_BYTES) fail('raw_invalid');
  if (config.source === 'n8n' && (provenance?.workflowId !== config.workflowId ||
      typeof provenance.executionId !== 'string' || !/^[0-9]+$/.test(provenance.executionId))) fail('provenance_invalid');
  if (config.source === 'evolution' && provenance != null) fail('provenance_not_applicable');
  if (!freeSpaceOK(config, raw.length)) fail('space_insufficient');
  const id = recordId(config.instance, raw);
  const target = path.join(config.dir, `${id}.json`);
  // A linked file from an interrupted attempt is recoverable only after full
  // authentication and another directory fsync.
  if (fs.existsSync(target)) {
    const existing = recoverLinkedTemp(config.dir, id, config.key, config.instance, raw, config.source);
    if (!existing.raw.equals(raw) || existing.meta.source !== config.source) fail('record_collision');
    fsyncDir(config.dir);
    return {id, duplicate: true};
  }
  const meta = {version: RECORD_VERSION, source: config.source, instance: config.instance, receivedAt: new Date().toISOString(),
    rawSha256: sha256(raw), workflowId: config.source === 'n8n' ? provenance.workflowId : null,
    executionId: config.source === 'n8n' ? provenance.executionId : null};
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(aad(meta));
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const record = Buffer.from(JSON.stringify({version: RECORD_VERSION, meta,
    iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64')}));
  const temp = path.join(config.dir, `.${id}.${randomBytes(12).toString('hex')}.tmp`);
  let owned = false;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, FILE_MODE);
    owned = true;
    try {
      let offset = 0;
      while (offset < record.length) offset += fs.writeSync(fd, record, offset, record.length - offset);
      fs.fsyncSync(fd);
      hooks.afterFileSync?.();
    } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = recoverLinkedTemp(config.dir, id, config.key, config.instance, raw, config.source);
      if (!existing.raw.equals(raw) || existing.meta.source !== config.source) fail('record_collision');
      fsyncDir(config.dir);
      return {id, duplicate: true};
    }
    hooks.afterLink?.();
    fs.unlinkSync(temp);
    owned = false;
    fsyncDir(config.dir);
    return {id, duplicate: false};
  } finally {
    if (owned) { try { fs.unlinkSync(temp); } catch { /* own temporary file only */ } }
  }
}

function safeEqualBearer(value, token) {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  const a = createHash('sha256').update(supplied).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b) && supplied.length === expected.length;
}

function header(req, name) { const value = req.headers[name]; return typeof value === 'string' ? value : undefined; }
function reply(res, status, body) { res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); res.end(JSON.stringify(body)); }

async function receiveRaw(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) { const error = new Error('body_too_large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

function instanceMatches(raw, expected) {
  const payload = JSON.parse(raw.toString('utf8'));
  const items = Array.isArray(payload) ? payload : [payload];
  return items.length > 0 && items.every(item => item && typeof item === 'object' && !Array.isArray(item) && item.instance === expected);
}

export function createHandler(configInput, hooks = {}) {
  const config = validateConfig(configInput);
  return async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      try {
        storageDir(config.dir);
        if (hooks.health) return reply(res, 200, {status: 'ready', ...hooks.health()});
        const count = fs.readdirSync(config.dir).filter(name => HASH_RE.test(name.slice(0, -5)) && name.endsWith('.json')).length;
        return reply(res, 200, {status: 'ready', records: count});
      } catch { return reply(res, 503, {status: 'unavailable'}); }
    }
    if (req.method !== 'POST' || req.url !== '/inbound') return reply(res, 404, {error: 'not_found'});
    const auth = header(req, 'authorization');
    const workflowId = header(req, 'x-jp-n8n-workflow-id');
    const executionId = header(req, 'x-jp-n8n-execution-id');
    if (!safeEqualBearer(auth, config.token) ||
        (config.source === 'n8n' && (workflowId !== config.workflowId || !/^[0-9]+$/.test(executionId ?? ''))) ||
        (config.source === 'evolution' && (workflowId !== undefined || executionId !== undefined)))
      return reply(res, 401, {error: 'unauthorized'});
    const statedLength = header(req, 'content-length');
    if (statedLength && Number(statedLength) > MAX_BODY_BYTES) return reply(res, 413, {error: 'body_too_large'});
    let raw;
    try { raw = await receiveRaw(req); }
    catch (error) { return reply(res, error.status === 413 ? 413 : 503, {error: error.status === 413 ? 'body_too_large' : 'intake_unavailable'}); }
    try {
      if (!instanceMatches(raw, config.instance)) return reply(res, 401, {error: 'instance_mismatch'});
    } catch { return reply(res, 400, {error: 'invalid_json'}); }
    try {
      if (hooks.reserve) hooks.reserve(recordId(config.instance, raw));
      const result = persistRaw(config, raw, config.source === 'n8n' ? {workflowId, executionId} : null, hooks);
      hooks.committed?.(result);
      return reply(res, 202, result);
    } catch { return reply(res, 503, {error: 'intake_unavailable'}); }
  };
}

export function createServer(config, hooks) { return http.createServer(createHandler(config, hooks)); }

function args(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith('--') || i + 1 >= argv.length || Object.hasOwn(values, key)) fail('arguments_invalid');
    values[key] = argv[i + 1];
  }
  const allowed = ['--dir', '--bind', '--port', '--token-file', '--key-file', '--instance-file', '--workflow-id', '--min-free-bytes', '--source'];
  if (Object.keys(values).some(key => !allowed.includes(key))) fail('arguments_invalid');
  for (const key of allowed.slice(0, 6)) if (!values[key]) fail('arguments_missing');
  const source = values['--source'] ?? 'n8n';
  if (source !== 'n8n' && source !== 'evolution') fail('arguments_invalid');
  if (source === 'n8n' && !values['--workflow-id']) fail('arguments_missing');
  const port = Number(values['--port']);
  const minFreeBytes = Number(values['--min-free-bytes'] ?? 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) fail('arguments_invalid');
  return {dir: values['--dir'], bind: values['--bind'], port, tokenFile: values['--token-file'],
    keyFile: values['--key-file'], instanceFile: values['--instance-file'], workflowId: values['--workflow-id'], source, minFreeBytes};
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    const options = args(process.argv.slice(2));
    const server = createServer(loadConfig(options));
    server.listen(options.port, options.bind);
    server.on('error', () => { process.stderr.write('ingress_unavailable\n'); process.exitCode = 1; });
  } catch { process.stderr.write('ingress_configuration_invalid\n'); process.exitCode = 1; }
}
