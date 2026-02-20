import * as net from "net";
import * as os  from "os";
import {
  PacketType, frame, peekType,
  readHandshake, readPing, readSleepRequest, readCarUpdate,
  writeAssignId, writePlayerJoin, writePlayerLeave,
  writePong, writeSetTime, writeTimeSync,
} from "./protocol";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT             = parseInt(process.env.PORT ?? "7777", 10);
const TIME_SYNC_MS     = 30_000;
const GAME_TICK_MS     = 1_000;
const MINUTES_PER_TICK = 1;
const WAKE_HOUR        = 8.0;

// ─── Logger ───────────────────────────────────────────────────────────────────

const ts  = () => new Date().toISOString().substring(11, 23);
const log = {
  info:  (m: string) => console.log(`\x1b[90m[${ts()}]\x1b[0m \x1b[32m[INFO]\x1b[0m  ${m}`),
  warn:  (m: string) => console.log(`\x1b[90m[${ts()}]\x1b[0m \x1b[33m[WARN]\x1b[0m  ${m}`),
  error: (m: string) => console.log(`\x1b[90m[${ts()}]\x1b[0m \x1b[31m[ERR]\x1b[0m   ${m}`),
  net:   (sid: number, dir: "IN"|"OUT", type: string, extra = "") => {
    const a = dir === "IN" ? "\x1b[36m◄\x1b[0m \x1b[36mIN \x1b[0m" : "\x1b[35m►\x1b[0m \x1b[35mOUT\x1b[0m";
    console.log(`\x1b[90m[${ts()}]\x1b[0m ${a} \x1b[33m[#${sid}]\x1b[0m \x1b[97m${type.padEnd(14)}\x1b[0m ${extra}`);
  },
};

// ─── World State ──────────────────────────────────────────────────────────────

const world = {
  hour: 8.0,
  clockRunning: false,   // only tick when at least one player is connected
  carOwners: new Map<number, number>(),
};

// Game clock — only advances while players are connected
const gameTick = setInterval(() => {
  if (!world.clockRunning) return;
  world.hour += MINUTES_PER_TICK / 60;
  if (world.hour >= 24) world.hour -= 24;
}, GAME_TICK_MS);

// Periodic time sync broadcast
const timeSyncInterval = setInterval(() => {
  if (sessions.size === 0) return;
  log.info(`⏰ TimeSync broadcast → ${world.hour.toFixed(2)}h`);
  broadcast(writeTimeSync(world.hour), "TimeSync");
}, TIME_SYNC_MS);

// ─── Sessions ─────────────────────────────────────────────────────────────────

let nextId = 1;
const sessions = new Map<number, Session>();

class Session {
  readonly id: number;
  name           = "Unknown";
  handshakeDone  = false;   // true once we've received their Handshake packet
  packetsIn      = 0;
  packetsOut     = 0;
  private recvBuf: Buffer = Buffer.alloc(0);

  constructor(readonly socket: net.Socket) { this.id = nextId++; }

  send(payload: Buffer, label?: string): void {
    try {
      const framed = frame(payload);
      this.socket.write(framed);
      this.packetsOut++;
      if (label) log.net(this.id, "OUT", label);
    } catch { /* already closed */ }
  }

  onData(chunk: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
    while (this.recvBuf.length >= 4) {
      const len = this.recvBuf.readInt32LE(0);
      if (len <= 0 || len > 65536) {
        log.warn(`#${this.id}: bad packet length ${len}`);
        this.socket.destroy();
        return;
      }
      if (this.recvBuf.length < 4 + len) break;
      const payload = this.recvBuf.subarray(4, 4 + len);
      this.recvBuf  = this.recvBuf.subarray(4 + len);
      this.packetsIn++;
      this.handle(payload);
    }
  }

  private handle(data: Buffer): void {
    const type = peekType(data);
    switch (type) {

      case PacketType.Handshake: {
        const { name } = readHandshake(data);
        this.name         = name;
        this.handshakeDone = true;
        log.net(this.id, "IN", "Handshake", `name="${name}"`);

        // Tell all existing players about the newcomer
        broadcast(writePlayerJoin(this.id, name), "PlayerJoin", this.id);

        // Tell the newcomer about every already-connected player who has
        // completed their own handshake (so names are never "Unknown")
        for (const [id, other] of sessions) {
          if (id === this.id || !other.handshakeDone) continue;
          this.send(writePlayerJoin(id, other.name), "PlayerJoin(existing)");
        }

        // Sync world time immediately so the newcomer matches everyone else
        this.send(writeSetTime(world.hour), "SetTime(welcome)");
        break;
      }

      case PacketType.PlayerMove:
        // High-frequency — relay raw buffer silently, no re-allocation
        broadcast(data, "", this.id);
        break;

      case PacketType.CarUpdate: {
        const { carId } = readCarUpdate(data);
        if (!world.carOwners.has(carId)) {
          world.carOwners.set(carId, this.id);
          log.net(this.id, "IN", "CarUpdate", `ownership claimed carId=${carId}`);
        }
        broadcast(data, "", this.id);
        break;
      }

      case PacketType.SleepRequest: {
        const targetHour = readSleepRequest(data);
        log.net(this.id, "IN", "SleepRequest", `wake at ${targetHour.toFixed(1)}h`);
        world.hour = targetHour;
        // Broadcast to ALL clients (including the sleeper)
        broadcast(writeSetTime(world.hour), "SetTime(sleep)", -1);
        log.info(`⏰ Sleep skip → ${world.hour.toFixed(2)}h broadcast to all`);
        break;
      }

      case PacketType.Ping: {
        const timestamp = readPing(data);
        this.send(writePong(timestamp), "Pong");
        break;
      }

      default:
        log.warn(`#${this.id}: unknown packet 0x${type.toString(16).padStart(2, "0")}`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcast(payload: Buffer, label: string, exceptId = -1): void {
  for (const [id, s] of sessions) {
    if (id === exceptId) continue;
    s.send(payload, label || undefined);
  }
}

// ─── TCP Server ───────────────────────────────────────────────────────────────

const server = net.createServer((socket) => {
  const s = new Session(socket);
  sessions.set(s.id, s);
  world.clockRunning = true;
  log.info(`\x1b[32m+\x1b[0m #${s.id} connected (${socket.remoteAddress})`);

  // Send the new client their ID immediately — before handshake
  s.send(writeAssignId(s.id), "AssignId");

  socket.on("data",  chunk => s.onData(chunk));

  socket.on("close", () => {
    sessions.delete(s.id);
    log.info(`\x1b[31m-\x1b[0m #${s.id} ("${s.name}") left | in:${s.packetsIn} out:${s.packetsOut}`);

    // Release cars owned by this player
    for (const [carId, owner] of world.carOwners) {
      if (owner === s.id) {
        world.carOwners.delete(carId);
        log.info(`  Released car ${carId}`);
      }
    }

    broadcast(writePlayerLeave(s.id), "PlayerLeave");

    // Stop clock when server is empty — resumes on next connect
    if (sessions.size === 0) {
      world.clockRunning = false;
      log.info("No players connected — clock paused");
    }
  });

  socket.on("error", err => log.error(`#${s.id}: ${err.message}`));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\x1b[36m╔══════════════════════════════════════╗\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m   Mon Bazou Multiplayer Server       \x1b[36m║\x1b[0m`);
  console.log(`\x1b[36m║\x1b[0m   Port \x1b[97m${String(PORT).padEnd(28)}\x1b[0m\x1b[36m║\x1b[0m`);
  console.log(`\x1b[36m╚══════════════════════════════════════╝\x1b[0m`);
  console.log("");
  log.info("📡 Reachable on:");
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const tag = a.internal ? "\x1b[90m(loopback)\x1b[0m" : "\x1b[33m← use for LAN\x1b[0m";
      console.log(`   \x1b[97m${name.padEnd(14)}\x1b[0m \x1b[32m${a.address.padEnd(16)}\x1b[0m ${tag}`);
    }
  }
  console.log("");
  log.info(`Starting time: ${world.hour.toFixed(2)}h | tick: ${MINUTES_PER_TICK} game-min/real-sec`);
  log.info("Waiting for clients...");
});

server.on("error", err => { log.error(err.message); process.exit(1); });
process.on("SIGINT", () => {
  log.info("Shutting down...");
  clearInterval(gameTick);
  clearInterval(timeSyncInterval);
  server.close(() => process.exit(0));
});