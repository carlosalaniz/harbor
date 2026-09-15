import { crc32, inflateRawSync } from 'node:zlib';
import { HarborError } from '../errors.js';

// A small, strict ZIP reader for uploaded app packages. Only what a package needs: stored or deflated
// entries, central directory driven, CRC-checked, no zip64, no encryption, no symlinks, no path tricks.
export interface ZipLimits {
  maxEntries: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}
export const PACKAGE_ZIP_LIMITS: ZipLimits = { maxEntries: 256, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 48 * 1024 * 1024 };

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export function readZip(bytes: Buffer, limits: ZipLimits = PACKAGE_ZIP_LIMITS): Map<string, Buffer> {
  const bad = (msg: string) => new HarborError('INVALID_PACKAGE', `zip: ${msg}`);
  if (bytes.length < 22) throw bad('file too small to be a zip archive');
  // End of central directory: last 22 bytes plus up to 64 KiB of comment
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (bytes.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad('no end-of-central-directory record (is this really a .zip file?)');
  const entries = bytes.readUInt16LE(eocd + 10);
  const cdSize = bytes.readUInt32LE(eocd + 12);
  const cdOffset = bytes.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw bad('zip64 archives are not supported; keep the package under 4 GB and 65535 files');
  if (entries > limits.maxEntries) throw bad(`too many files (${entries}; at most ${limits.maxEntries})`);
  if (cdOffset + cdSize > bytes.length) throw bad('central directory lies outside the file');
  const out = new Map<string, Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > bytes.length || bytes.readUInt32LE(p) !== SIG_CENTRAL) throw bad(`corrupt central directory at entry ${n}`);
    const flags = bytes.readUInt16LE(p + 8);
    const method = bytes.readUInt16LE(p + 10);
    const crc = bytes.readUInt32LE(p + 16);
    const compSize = bytes.readUInt32LE(p + 20);
    const uncompSize = bytes.readUInt32LE(p + 24);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extraLen = bytes.readUInt16LE(p + 30);
    const commentLen = bytes.readUInt16LE(p + 32);
    const externalAttrs = bytes.readUInt32LE(p + 38);
    const localOffset = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) throw bad(`${name} is encrypted`);
    if (name.endsWith('/')) continue; // directory entry
    const mode = externalAttrs >>> 16;
    if ((mode & 0xf000) === 0xa000) throw bad(`${name} is a symbolic link; packages may contain only regular files`);
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some((seg) => seg === '..' || seg === '' || seg === '.')) throw bad(`unsafe path ${JSON.stringify(name)}`);
    if (uncompSize > limits.maxFileBytes) throw bad(`${name} is larger than ${limits.maxFileBytes} bytes`);
    total += uncompSize;
    if (total > limits.maxTotalBytes) throw bad(`archive expands past ${limits.maxTotalBytes} bytes`);
    if (localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== SIG_LOCAL) throw bad(`corrupt local header for ${name}`);
    const lNameLen = bytes.readUInt16LE(localOffset + 26);
    const lExtraLen = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > bytes.length) throw bad(`${name} data lies outside the file`);
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: limits.maxFileBytes });
      } catch (e) {
        throw bad(`${name} could not be decompressed (${(e as Error).message})`);
      }
    } else throw bad(`${name} uses unsupported compression method ${method} (use store or deflate)`);
    if (data.length !== uncompSize) throw bad(`${name}: size mismatch (${data.length} vs declared ${uncompSize})`);
    if (crc32(data) !== crc) throw bad(`${name}: CRC mismatch (corrupt archive)`);
    if (out.has(name)) throw bad(`${name} appears twice`);
    out.set(name, data);
  }
  return stripCommonFolder(out);
}

// `zip -r app.zip my-app/` puts everything under `my-app/`; treat that folder as the package root.
function stripCommonFolder(files: Map<string, Buffer>): Map<string, Buffer> {
  const names = [...files.keys()];
  if (names.length === 0) return files;
  const first = names[0]!.split('/')[0]!;
  if (!names.every((n) => n.startsWith(`${first}/`))) return files;
  const out = new Map<string, Buffer>();
  for (const [n, b] of files) out.set(n.slice(first.length + 1), b);
  return out;
}

// Test/CLI helper: build a stored (uncompressed) zip from a file map.
export function writeZip(files: Record<string, Buffer | string>, opts: { folder?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [rawName, content] of Object.entries(files)) {
    const name = Buffer.from(opts.folder ? `${opts.folder}/${rawName}` : rawName, 'utf8');
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(0x031e, 4); // made by unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
