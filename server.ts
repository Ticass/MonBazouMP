import * as net from "net";
import {
  PacketType, frame, peekType,
  readHandshake, readPing,
  writeAssignId, writePlayerJoin, writePlayerLeave, writePong,
} from "./protocol";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "7777", 10);

// ─── Logger ───────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
}

const log = {
  info:  (msg: string) => console.log(`\x1b[90m[${ts()}]\x1b[0m \x1b[32m[INFO]\x1b[0m  ${msg}`),
  warn:  (msg: string) => console.log(`\x1b[90m[${ts()}]\x1b[0m \x1b[33m[WARN]\x1b[0m  ${msg}`),
  error: (msg: string) => console.log(`\x1b[90m[${ts()}]\x1b[0m \x1b[31m[ERR]\x1b[0m   ${msg}`),
  net:   (sid: number, dir: "IN" | "OUT", type: string, extra = "") => {
    const arrow  = dir === "IN"  ? "\x1b[36m◄\x1b[0m" : "\x1b[35m►\x1b[0m";
    const dirStr = dir === "IN"  ? "\x1b[36mIN \x1b[0m" : "\x1b[35mOUT\x1b[0m";
    console.log(`\x1b[90m[${ts()}]\x1b[0m ${arrow} ${dirStr} \x1b[33m[#${sid}]\x1b[0m \x1b[97m${type.padEnd(12)}\x1b[0m ${extra}`);
  },
};

// ─── Stats ────────────────────────────────────────────────────────────────────

const stats = { totalPacketsIn: 0, totalPacketsOut: 0, totalBytesIn: 0, totalBytesOut: 0 };

setInterval(() => {
  const count = sessions.size;
  if (count === 0) return;
  log.info(`📊 ${count} client(s) | ↓${stats.totalPacketsIn} pkts in | ↑${stats.totalPacketsOut} pkts out`);
}, 10_000);

// ─── Session ──────────────────────────────────────────────────────────────────

let nextId = 1;
const sessions = new Map<number, Session>();

class Session {
  readonly id: number;
  name: string = "Unknown";
  private recvBuf: Buffer = Buffer.alloc(0);
  packetsIn = 0;
  packetsOut = 0;

  constructor(readonly socket: net.Socket) {
    this.id = nextId++;
  }

  send(payload: Buffer, packetType?: string): void {
    try {
      const framed = frame(payload);
      this.socket.write(framed);
      this.packetsOut++;
      stats.totalPacketsOut++;
      stats.totalBytesOut += framed.length;
      if (packetType) log.net(this.id, "OUT", packetType);
    } catch {
      // socket already gone
    }
  }

  onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);

    while (this.recvBuf.length >= 4) {
      const len = this.recvBuf.readInt32LE(0);

      if (len <= 0 || len > 65536) {
        log.warn(`Session #${this.id}: invalid packet length ${len}, dropping connection`);
        this.socket.destroy();
        return;
      }

      if (this.recvBuf.length < 4 + len) break;

      const payload = this.recvBuf.subarray(4, 4 + len);
      this.recvBuf  = this.recvBuf.subarray(4 + len);

      this.packetsIn++;
      stats.totalPacketsIn++;
      stats.totalBytesIn += 4 + len;

      this.handlePacket(payload);
    }
  }

  private handlePacket(data: Buffer): void {
    const type = peekType(data);

    switch (type) {
      case PacketType.Handshake: {
        const { name } = readHandshake(data);
        this.name = name;
        log.net(this.id, "IN", "Handshake", `name="${name}"`);

        // Notify all others this player joined
        broadcast(writePlayerJoin(this.id, this.name), "PlayerJoin", this.id);
        break;
      }

      case PacketType.PlayerMove: {
        // Relay raw — no need to decode positions on the server
        log.net(this.id, "IN", "PlayerMove", `→ relay to ${sessions.size - 1} client(s)`);
        broadcast(data, "PlayerMove", this.id);
        break;
      }

      case PacketType.Ping: {
        const timestamp = readPing(data);
        log.net(this.id, "IN", "Ping");
        this.send(writePong(timestamp), "Pong");
        break;
      }

      default:
        log.warn(`Session #${this.id}: unknown packet type 0x${type.toString(16).padStart(2,"0")}`);
    }
  }
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcast(payload: Buffer, packetType: string, exceptId = -1): void {
  for (const [id, session] of sessions) {
    if (id === exceptId) continue;
    session.send(payload, packetType);
  }
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  const session = new Session(socket);
  sessions.set(session.id, session);

  log.info(`\x1b[32m+\x1b[0m Client connected → assigned ID #${session.id} (${socket.remoteAddress})`);

  // Tell new client their ID
  session.send(writeAssignId(session.id), "AssignId");

  // Tell them about already-connected players
  for (const [id, other] of sessions) {
    if (id === session.id) continue;
    session.send(writePlayerJoin(id, other.name), "PlayerJoin");
  }

  socket.on("data", (chunk) => session.onData(chunk));

  socket.on("close", () => {
    sessions.delete(session.id);
    log.info(`\x1b[31m-\x1b[0m Session #${session.id} ("${session.name}") disconnected | in:${session.packetsIn} out:${session.packetsOut}`);
    broadcast(writePlayerLeave(session.id), "PlayerLeave");
  });

  socket.on("error", (err) => {
    log.error(`Session #${session.id} socket error: ${err.message}`);
  });
});

server.listen(PORT, () => {
  console.log(`\x1b[36m╔══════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m   Mon Bazou Multiplayer Server       \x1b[36m║\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m   Port: \x1b[97m${String(PORT).padEnd(29)}\x1b[0m\x1b[36m║\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m   F8 = connect  |  F9 = debug overlay\x1b[36m║\x1b[0m`);
  console.log(`\x1b[36m╚══════════════════════════════════════╝\x1b[0m`);
  log.info("Server ready, waiting for clients...");
});

server.on("error", (err) => {
  log.error(`Server error: ${err.message}`);
  process.exit(1);
});

process.on("SIGINT", () => {
  log.info("Shutting down...");
  server.close(() => process.exit(0));
});