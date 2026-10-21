/**
 * Find Chromecasts on the LAN with multicast DNS, by hand.
 *
 * mDNS is a small enough slice of DNS to parse directly, which keeps this free
 * of dependencies on a toolchain where adding one is the risky part.
 *
 * NOTE: no `?.`/`??` — webpack 4 cannot parse them.
 */

import dgram from 'dgram';
import net from 'net';
import os from 'os';

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_googlecast._tcp.local';

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;

export interface CastDeviceInfo {
  /** mDNS instance name; stable id for the device. */
  id: string;
  /** Friendly name from the TXT record, e.g. "LivingroomTV". */
  name: string;
  host: string;
  ip?: string;
  port: number;
}

function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.');
  const parts = labels.map((label) => {
    const bytes = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat(parts.concat([Buffer.from([0])]));
}

function buildQuery(name: string, type: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // id
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(1, 4); // one question
  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(name), question]);
}

/** Names may be compressed as pointers into the packet, so decode against it. */
function readName(buf: Buffer, offset: number): [string, number] {
  const labels: string[] = [];
  let i = offset;
  let jumped = false;
  let end = offset;
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 128 || i >= buf.length) break; // malformed: refuse to loop
    const length = buf[i];
    if (length === 0) {
      i += 1;
      if (!jumped) end = i;
      break;
    }
    // eslint-disable-next-line no-bitwise
    if ((length & 0xc0) === 0xc0) {
      // eslint-disable-next-line no-bitwise
      const pointer = ((length & 0x3f) << 8) | buf[i + 1];
      if (!jumped) end = i + 2;
      i = pointer;
      jumped = true;
    } else {
      labels.push(buf.slice(i + 1, i + 1 + length).toString('utf8'));
      i += 1 + length;
    }
  }
  return [labels.join('.'), end];
}

interface Record {
  name: string;
  type: number;
  ptr?: string;
  target?: string;
  port?: number;
  ip?: string;
  txt?: string[];
}

function parseRecords(buf: Buffer): Record[] {
  const questions = buf.readUInt16BE(4);
  const answers = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let i = 12;
  for (let q = 0; q < questions; q += 1) {
    [, i] = readName(buf, i);
    i += 4;
  }
  const records: Record[] = [];
  for (let r = 0; r < answers && i < buf.length; r += 1) {
    let name = '';
    [name, i] = readName(buf, i);
    const type = buf.readUInt16BE(i);
    i += 2 + 2 + 4; // class + ttl
    const rdLength = buf.readUInt16BE(i);
    i += 2;
    const record: Record = { name, type };
    if (type === TYPE_PTR) [record.ptr] = readName(buf, i);
    else if (type === TYPE_SRV) {
      record.port = buf.readUInt16BE(i + 4);
      [record.target] = readName(buf, i + 6);
    } else if (type === TYPE_A) {
      record.ip = Array.from(buf.slice(i, i + rdLength)).join('.');
    } else if (type === TYPE_TXT) {
      const txt: string[] = [];
      let p = i;
      while (p < i + rdLength) {
        const length = buf[p];
        txt.push(buf.slice(p + 1, p + 1 + length).toString('utf8'));
        p += 1 + length;
      }
      record.txt = txt;
    }
    records.push(record);
    i += rdLength;
  }
  return records;
}

/**
 * Browse for Chromecasts for `timeout` ms.
 *
 * The socket sees every mDNS response on the network, not just answers to our
 * question, so only instances announced under _googlecast._tcp are tracked —
 * otherwise AirPlay and friends show up as "Chromecasts".
 */
export function discoverCastDevices(timeout = 4000): Promise<CastDeviceInfo[]> {
  return new Promise((resolve) => {
    const addresses = Array.from(new Set(Object.values(os.networkInterfaces())
      .flatMap(entries => (entries || [])
        .filter(entry => entry.family === 'IPv4' && !entry.internal)
        .map(entry => entry.address))));
    if (!addresses.length) {
      resolve([]);
      return;
    }
    // Records for one device arrive across packets and in any order, so collect
    // everything and only decide what is a Chromecast at the end. Attaching
    // details as they arrive drops any SRV that lands before its PTR.
    const castInstances = new Set<string>();
    const srvByInstance = new Map<string, { host: string, port: number }>();
    const nameByInstance = new Map<string, string>();
    const ipByHost = new Map<string, string>();
    // Each socket keeps its own outgoing interface, including when a VPN or VM
    // changes the default route while the Wi-Fi LAN is still reachable.
    const sockets = addresses.map(() => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    const open = new Set(sockets);
    const ready = new Set<dgram.Socket>();
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const asked = new Map<string, Buffer>();

    const send = (socket: dgram.Socket, packet: Buffer) => {
      if (done) return;
      try {
        socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDRESS, () => {});
      } catch (e) { /* interface went away mid-scan */ }
    };

    /**
     * Browsing only yields PTRs. Some devices volunteer SRV/TXT alongside them,
     * but others do not, so anything we learn about has to be resolved
     * explicitly or it is invisible for want of a host and port.
     */
    const askFor = (name: string, type: number) => {
      const key = `${type}:${name}`;
      if (done || asked.has(key)) return;
      const packet = buildQuery(name, type);
      asked.set(key, packet);
      ready.forEach(socket => send(socket, packet));
    };

    const finish = () => {
      if (done) return;
      done = true;
      timers.forEach(timer => clearTimeout(timer));
      sockets.forEach((socket) => {
        try { socket.close(); } catch (e) { /* already closed */ }
      });
      const devices: CastDeviceInfo[] = [];
      castInstances.forEach((id) => {
        const srv = srvByInstance.get(id);
        if (!srv) return; // announced but never told us where it lives
        const friendly = nameByInstance.get(id);
        devices.push({
          id,
          name: friendly || id.split('.')[0],
          host: srv.host,
          ip: ipByHost.get(srv.host),
          port: srv.port,
        });
      });
      resolve(devices);
    };

    const onMessage = (msg: Buffer) => {
      let records: Record[];
      try {
        records = parseRecords(msg);
      } catch (e) {
        return; // not a packet we can read; ignore rather than throw
      }
      records.forEach((record) => {
        // A PTR under our service is what marks an instance as a Chromecast;
        // everything else is just indexed for later.
        if (record.type === TYPE_PTR && record.name === SERVICE && record.ptr) {
          castInstances.add(record.ptr);
          // Ask for the details rather than waiting to be told.
          askFor(record.ptr, TYPE_SRV);
          askFor(record.ptr, TYPE_TXT);
        } else if (record.type === TYPE_SRV && record.target && record.port) {
          srvByInstance.set(record.name, { host: record.target, port: record.port });
          if (!ipByHost.has(record.target)) askFor(record.target, TYPE_A);
        } else if (record.type === TYPE_TXT && record.txt) {
          const friendly = record.txt.find(t => t.indexOf('fn=') === 0);
          if (friendly) nameByInstance.set(record.name, friendly.slice(3));
        } else if (record.type === TYPE_A && record.ip) {
          ipByHost.set(record.name, record.ip);
        }
      });
    };
    const query = buildQuery(SERVICE, TYPE_PTR);
    const ask = (socket: dgram.Socket) => {
      send(socket, query);
      // Retry lost SRV/TXT/address replies as well as the initial PTR query.
      asked.forEach(packet => send(socket, packet));
    };
    sockets.forEach((socket, index) => {
      const failed = () => {
        ready.delete(socket);
        open.delete(socket);
        try { socket.close(); } catch (e) { /* already closed */ }
        if (!open.size) finish();
      };
      socket.on('error', failed);
      socket.on('message', onMessage);
      socket.bind(MDNS_PORT, () => {
        if (done || !open.has(socket)) return;
        try {
          socket.addMembership(MDNS_ADDRESS, addresses[index]);
          socket.setMulticastInterface(addresses[index]);
          ready.add(socket);
          ask(socket);
        } catch (e) {
          failed();
        }
      });
    });
    [400, 1200, 2500].filter(t => t < timeout).forEach((t) => {
      timers.push(setTimeout(() => ready.forEach(ask), t));
    });
    timers.push(setTimeout(finish, timeout));
  });
}

/**
 * Is a device actually castable right now?
 *
 * A TV with Chromecast built-in stops answering mDNS once it goes idle, but
 * keeps :8009 open so it can be woken by casting. Such a device is invisible to
 * a cold browse yet perfectly usable, which is why Chrome still lists it: it
 * remembers. A TCP connect is the honest test.
 */
export function isCastReachable(host: string, port = 8009, timeout = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * Devices seen now, plus any remembered device that still
 * answers on :8009.
 *
 * This deliberately stays within the Electron process. Invoking macOS's
 * long-running `dns-sd` tool and killing it after a short timeout can leave
 * Electron's libuv signal watcher spinning on newer macOS releases.
 */
export async function discoverWithKnown(
  known: CastDeviceInfo[] = [],
  timeout?: number,
  onRemembered?: (devices: CastDeviceInfo[]) => void,
): Promise<CastDeviceInfo[]> {
  // Recheck saved TVs while browsing, so the picker need not wait for mDNS.
  const remembered = Promise.all(known.map(async device => (
    await isCastReachable(device.ip || device.host, device.port) ? device : undefined
  ))).then((results) => {
    const devices = results.filter((device): device is CastDeviceInfo => !!device);
    if (onRemembered) onRemembered(devices);
    return devices;
  });
  const [live, reachable] = await Promise.all([discoverCastDevices(timeout), remembered]);
  const byId = new Map<string, CastDeviceInfo>();
  live.forEach(device => byId.set(device.id, device));
  reachable.forEach((device) => {
    if (!byId.has(device.id)) byId.set(device.id, device);
  });
  return Array.from(byId.values());
}
