// Protocol must mirror C# Packets.cs exactly
// Wire: [4-byte LE length][payload]

export const enum PacketType {
  Handshake    = 0x00,
  PlayerJoin   = 0x01,
  PlayerLeave  = 0x02,
  PlayerMove   = 0x03,
  AssignId     = 0x04,
  Ping         = 0x05,
  Pong         = 0x06,
  CarUpdate    = 0x0A,  // 10
  CarOwnership = 0x0B,  // 11
  SetTime      = 0x14,  // 20
  SleepRequest = 0x15,  // 21
  TimeSync     = 0x16,  // 22
}

// ─── BinaryWriter string (7-bit length prefix + UTF-8) ────────────────────────

function write7BitInt(buf: number[], v: number): void {
  while (v > 0x7f) { buf.push((v & 0x7f) | 0x80); v >>>= 7; }
  buf.push(v);
}
function writeBinStr(buf: number[], str: string): void {
  const enc = Buffer.from(str, "utf8");
  write7BitInt(buf, enc.length);
  for (const b of enc) buf.push(b);
}
function read7BitInt(b: Buffer, off: number): { v: number; n: number } {
  let v = 0, s = 0, n = 0;
  while (true) { const byte = b[off + n++]; v |= (byte & 0x7f) << s; s += 7; if (!(byte & 0x80)) break; }
  return { v, n };
}
function readBinStr(b: Buffer, off: number): { s: string; n: number } {
  const len = read7BitInt(b, off);
  return { s: b.subarray(off + len.n, off + len.n + len.v).toString("utf8"), n: len.n + len.v };
}

// ─── Framing ─────────────────────────────────────────────────────────────────

export function frame(payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

export function peekType(data: Buffer): PacketType { return data.readUInt8(0) as PacketType; }

// ─── Readers ─────────────────────────────────────────────────────────────────

export function readHandshake(data: Buffer): { name: string } {
  return { name: readBinStr(data, 1).s };
}

export function readPing(data: Buffer): bigint {
  return data.readBigInt64LE(1);
}

export function readSleepRequest(data: Buffer): number {
  return data.readFloatLE(1);
}

export function readCarUpdate(data: Buffer): { playerId: number; carId: number } {
  return { playerId: data.readInt32LE(1), carId: data.readInt32LE(5) };
}

// ─── Writers ─────────────────────────────────────────────────────────────────

export function writeAssignId(id: number): Buffer {
  const b = Buffer.allocUnsafe(5);
  b.writeUInt8(PacketType.AssignId, 0);
  b.writeInt32LE(id, 1);
  return b;
}

export function writePlayerJoin(id: number, name: string): Buffer {
  const parts: number[] = [PacketType.PlayerJoin];
  const idBuf = Buffer.allocUnsafe(4);
  idBuf.writeInt32LE(id, 0);
  for (const b of idBuf) parts.push(b);
  writeBinStr(parts, name);
  return Buffer.from(parts);
}

export function writePlayerLeave(id: number): Buffer {
  const b = Buffer.allocUnsafe(5);
  b.writeUInt8(PacketType.PlayerLeave, 0);
  b.writeInt32LE(id, 1);
  return b;
}

export function writePong(timestamp: bigint): Buffer {
  const b = Buffer.allocUnsafe(9);
  b.writeUInt8(PacketType.Pong, 0);
  b.writeBigInt64LE(timestamp, 1);
  return b;
}

export function writeSetTime(hour: number): Buffer {
  const b = Buffer.allocUnsafe(5);
  b.writeUInt8(PacketType.SetTime, 0);
  b.writeFloatLE(hour, 1);
  return b;
}

export function writeTimeSync(hour: number): Buffer {
  const b = Buffer.allocUnsafe(5);
  b.writeUInt8(PacketType.TimeSync, 0);
  b.writeFloatLE(hour, 1);
  return b;
}