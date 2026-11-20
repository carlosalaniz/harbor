// A minimal reader for MaxMind DB files (the format DB-IP Lite ships in; spec:
// https://maxmind.github.io/MaxMind-DB/). PURE over a Buffer: no I/O, no dependency. Harbor only needs one lookup per
// click, so it decodes on demand and keeps nothing but the file.
import { isIP } from 'node:net';

const METADATA_MARKER = Buffer.from([0xab, 0xcd, 0xef, ...Buffer.from('MaxMind.com')]);

export type MmdbValue = string | number | boolean | bigint | Buffer | MmdbValue[] | { [k: string]: MmdbValue } | null;

export interface MmdbMetadata {
  nodeCount: number;
  recordSize: 24 | 28 | 32;
  ipVersion: 4 | 6;
  databaseType: string;
  buildEpoch: number;
}

export class MmdbError extends Error {}

class Decoder {
  constructor(
    private readonly buf: Buffer,
    // where pointers are counted from
    private readonly base: number,
  ) {}

  // Decode the value at absolute `offset`; returns it and the absolute offset after it.
  decode(offset: number, depth = 0): [MmdbValue, number] {
    if (depth > 32) throw new MmdbError('mmdb: nesting too deep');
    if (offset >= this.buf.length) throw new MmdbError('mmdb: offset outside the file');
    const ctrl = this.buf[offset++]!;
    let type = ctrl >> 5;
    if (type === 1) {
      // pointer: its target is decoded in place of it
      const ss = (ctrl >> 3) & 3;
      const v = ctrl & 7;
      let p: number;
      if (ss === 0) p = (v << 8) | this.buf[offset]!;
      else if (ss === 1) p = ((v << 16) | this.buf.readUInt16BE(offset)) + 2048;
      else if (ss === 2) p = ((v << 24) | this.buf.readUIntBE(offset, 3)) + 526336;
      else p = this.buf.readUInt32BE(offset);
      const [value] = this.decode(this.base + p, depth + 1);
      return [value, offset + ss + 1];
    }
    if (type === 0) type = 7 + this.buf[offset++]!;
    let size = ctrl & 0x1f;
    if (size === 29) size = 29 + this.buf[offset++]!;
    else if (size === 30) {
      size = 285 + this.buf.readUInt16BE(offset);
      offset += 2;
    } else if (size === 31) {
      size = 65821 + this.buf.readUIntBE(offset, 3);
      offset += 3;
    }
    const end = offset + size;
    switch (type) {
      case 2:
        return [this.buf.toString('utf8', offset, end), end];
      case 3:
        return [this.buf.readDoubleBE(offset), offset + 8];
      case 4:
        return [this.buf.subarray(offset, end), end];
      case 5:
      case 6:
        return [size ? this.buf.readUIntBE(offset, size) : 0, end];
      case 8:
        return [size ? this.buf.readIntBE(offset, size) : 0, end];
      case 9:
      case 10: {
        let n = 0n;
        for (let i = offset; i < end; i++) n = (n << 8n) | BigInt(this.buf[i]!);
        return [n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n, end];
      }
      case 7: {
        const map: { [k: string]: MmdbValue } = {};
        let at = offset;
        for (let i = 0; i < size; i++) {
          const [k, a1] = this.decode(at, depth + 1);
          const [v, a2] = this.decode(a1, depth + 1);
          if (typeof k !== 'string') throw new MmdbError('mmdb: a map key is not a string');
          map[k] = v;
          at = a2;
        }
        return [map, at];
      }
      case 11: {
        const arr: MmdbValue[] = [];
        let at = offset;
        for (let i = 0; i < size; i++) {
          const [v, a] = this.decode(at, depth + 1);
          arr.push(v);
          at = a;
        }
        return [arr, at];
      }
      case 14:
        return [size !== 0, offset];
      case 15:
        return [this.buf.readFloatBE(offset), offset + 4];
      default:
        throw new MmdbError(`mmdb: unknown data type ${type}`);
    }
  }
}

function addressBits(address: string): { bits: number[]; family: 4 | 6 } | null {
  const family = isIP(address);
  if (family === 4) {
    const bytes = address.split('.').map(Number);
    return { family: 4, bits: bytes.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >> i) & 1)) };
  }
  if (family !== 6) return null;
  // expand :: (an embedded IPv4 tail is written out as two groups first)
  let s = address.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const b = tail[1]!.split('.').map(Number);
    s = s.slice(0, -tail[1]!.length) + `${((b[0]! << 8) | b[1]!).toString(16)}:${((b[2]! << 8) | b[3]!).toString(16)}`;
  }
  const [head, rest] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const r = rest ? rest.split(':') : [];
  const groups = rest === undefined ? h : [...h, ...Array<string>(8 - h.length - r.length).fill('0'), ...r];
  return { family: 6, bits: groups.flatMap((g) => Array.from({ length: 16 }, (_, i) => (parseInt(g, 16) >> (15 - i)) & 1)) };
}

export class MmdbReader {
  readonly metadata: MmdbMetadata;
  private readonly treeSize: number;
  private readonly dataStart: number;
  private ipv4Start: number | null = null;

  constructor(private readonly buf: Buffer) {
    const at = buf.lastIndexOf(METADATA_MARKER);
    if (at < 0) throw new MmdbError('mmdb: not a MaxMind DB file (no metadata)');
    const metaStart = at + METADATA_MARKER.length;
    const [meta] = new Decoder(buf, metaStart).decode(metaStart);
    const m = meta as Record<string, MmdbValue> | null;
    const nodeCount = Number(m?.['node_count']);
    const recordSize = Number(m?.['record_size']);
    const ipVersion = Number(m?.['ip_version']);
    if (!Number.isInteger(nodeCount) || nodeCount <= 0 || ![24, 28, 32].includes(recordSize) || ![4, 6].includes(ipVersion)) throw new MmdbError('mmdb: unreadable metadata');
    this.metadata = { nodeCount, recordSize: recordSize as 24 | 28 | 32, ipVersion: ipVersion as 4 | 6, databaseType: String(m?.['database_type'] ?? ''), buildEpoch: Number(m?.['build_epoch'] ?? 0) };
    this.treeSize = (recordSize / 4) * nodeCount;
    this.dataStart = this.treeSize + 16;
    if (this.dataStart > at) throw new MmdbError('mmdb: the search tree is larger than the file');
  }

  private record(node: number, bit: number): number {
    const { recordSize } = this.metadata;
    const off = node * (recordSize / 4);
    if (recordSize === 24) return this.buf.readUIntBE(off + bit * 3, 3);
    if (recordSize === 32) return this.buf.readUInt32BE(off + bit * 4);
    // 28 bits: the middle byte holds the high nibble of both records
    const middle = this.buf[off + 3]!;
    return bit === 0 ? ((middle & 0xf0) << 20) | this.buf.readUIntBE(off, 3) : ((middle & 0x0f) << 24) | this.buf.readUIntBE(off + 4, 3);
  }

  private walk(bits: number[], start: number): number {
    const n = this.metadata.nodeCount;
    let node = start;
    for (const b of bits) {
      if (node >= n) break;
      node = this.record(node, b);
    }
    return node;
  }

  // The data for `address`, null when the file has none.
  get(address: string): MmdbValue {
    const a = addressBits(address);
    if (!a) throw new MmdbError(`mmdb: not an address: ${address}`);
    if (a.family === 6 && this.metadata.ipVersion === 4) return null;
    let start = 0;
    if (a.family === 4 && this.metadata.ipVersion === 6) {
      // IPv4 lives under ::/96 in an IPv6 tree
      this.ipv4Start ??= this.walk(Array<number>(96).fill(0), 0);
      start = this.ipv4Start;
    }
    const n = this.metadata.nodeCount;
    const node = this.walk(a.bits, start);
    if (node === n || node < n) return null;
    const offset = this.dataStart + (node - n - 16);
    if (offset >= this.buf.length) throw new MmdbError('mmdb: a record points outside the file');
    return new Decoder(this.buf, this.dataStart).decode(offset)[0];
  }
}
