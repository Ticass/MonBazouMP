// ─── Packet protocol (must match C# Packets.cs exactly) ──────────────────────
// Wire format: [4-byte LE length prefix][payload]
//
// Payload layout:
//   Handshake  (0x00): [u8 type][BinaryWriter string name]
//   AssignId   (0x04): [u8 type][i32 id]
//   PlayerJoin (0x01): [u8 type][i32 id][BinaryWriter string name]
//   PlayerLeave(0x02): [u8 type][i32 id]
//   PlayerMove (0x03): [u8 type][i32 id][f32 x][f32 y][f32 z][f32 rx][f32 ry][f32 rz]
//   Ping       (0x05): [u8 type][i64 timestamp]
//   Pong       (0x06): [u8 type][i64 timestamp]

export const enum PacketType {
  Handshake   = 0x00,
  PlayerJoin  = 0x01,
  PlayerLeave = 0x02,
  PlayerMove  = 0x03,
  AssignId    = 0x04,
  Ping        = 0x05,
  Pong        = 0x06,
}

// ─── C# BinaryWriter string encoding (7-bit length prefix + UTF-8) ────────────

function write7BitInt(buf: number[], value: number): void {
  while (value > 0x7f) {
    buf.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  buf.push(value);
}

function writeBinaryString(buf: number[], str: string): void {
  const encoded = Buffer.from(str, "utf8");
  write7BitInt(buf, encoded.length);
  for (const b of encoded) buf.push(b);
}

function read7BitInt(buf: Buffer, offset: number): { value: number; bytesRead: number } {
  let value = 0, shift = 0, bytesRead = 0;
  while (true) {
    const b = buf[offset + bytesRead++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if ((b & 0x80) === 0) break;
  }
  return { value, bytesRead };
}

function readBinaryString(buf: Buffer, offset: number): { value: string; bytesRead: number } {
  const len = read7BitInt(buf, offset);
  const str = buf.subarray(offset + len.bytesRead, offset + len.bytesRead + len.value).toString("utf8");
  return { value: str, bytesRead: len.bytesRead + len.value };
}

// ─── Framing ──────────────────────────────────────────────────────────────────

export function frame(payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + payload.length);
  out.writeInt32LE(payload.length, 0);
  payload.copy(out, 4);
  return out;
}

// ─── Writers ─────────────────────────────────────────────────────────────────

export function writeAssignId(id: number): Buffer {
  const buf = Buffer.allocUnsafe(5);
  buf.writeUInt8(PacketType.AssignId, 0);
  buf.writeInt32LE(id, 1);
  return buf;
}

export function writePlayerJoin(id: number, name: string): Buffer {
  const parts: number[] = [PacketType.PlayerJoin];
  const idBuf = Buffer.allocUnsafe(4);
  idBuf.writeInt32LE(id, 0);
  for (const b of idBuf) parts.push(b);
  writeBinaryString(parts, name);
  return Buffer.from(parts);
}

export function writePlayerLeave(id: number): Buffer {
  const buf = Buffer.allocUnsafe(5);
  buf.writeUInt8(PacketType.PlayerLeave, 0);
  buf.writeInt32LE(id, 1);
  return buf;
}

export function writePong(timestamp: bigint): Buffer {
  const buf = Buffer.allocUnsafe(9);
  buf.writeUInt8(PacketType.Pong, 0);
  buf.writeBigInt64LE(timestamp, 1);
  return buf;
}

// ─── Readers ─────────────────────────────────────────────────────────────────

export function peekType(data: Buffer): PacketType {
  return data.readUInt8(0) as PacketType;
}

export function readHandshake(data: Buffer): { name: string } {
  return { name: readBinaryString(data, 1).value };
}

export function readPing(data: Buffer): bigint {
  return data.readBigInt64LE(1);
}