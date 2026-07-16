/**
 * Find Chromecasts on the LAN with multicast DNS, by hand.
 *
 * mDNS is a small enough slice of DNS to parse directly, which keeps this free
 * of dependencies on a toolchain where adding one is the risky part.
 *
 * NOTE: no `?.`/`??` — webpack 4 cannot parse them.
 */

import dgram from 'dgram';

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
    // Records for one device arrive across packets and in any order, so collect
    // everything and only decide what is a Chromecast at the end. Attaching
    // details as they arrive drops any SRV that lands before its PTR.
    const castInstances = new Set<string>();
    const srvByInstance = new Map<string, { host: string, port: number }>();
    const nameByInstance = new Map<string, string>();
    const ipByHost = new Map<string, string>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { socket.close(); } catch (e) { /* already closed */ }
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

    socket.on('error', finish);
    socket.on('message', (msg: Buffer) => {
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
        } else if (record.type === TYPE_SRV && record.target && record.port) {
          srvByInstance.set(record.name, { host: record.target, port: record.port });
        } else if (record.type === TYPE_TXT && record.txt) {
          const friendly = record.txt.find(t => t.indexOf('fn=') === 0);
          if (friendly) nameByInstance.set(record.name, friendly.slice(3));
        } else if (record.type === TYPE_A && record.ip) {
          ipByHost.set(record.name, record.ip);
        }
      });
    });

    socket.bind(MDNS_PORT, () => {
      try {
        socket.addMembership(MDNS_ADDRESS);
      } catch (e) {
        // no multicast route (e.g. no network): report nothing rather than throw
        finish();
        return;
      }
      const query = buildQuery(SERVICE, TYPE_PTR);
      const ask = () => {
        if (done) return;
        try {
          socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS);
        } catch (e) { /* interface went away mid-scan */ }
      };
      // Ask more than once: a device that already answered recently may suppress
      // its reply, and a single UDP query can simply be lost.
      ask();
      [400, 1200, 2500].filter(t => t < timeout).forEach(t => setTimeout(ask, t));
    });

    setTimeout(finish, timeout);
  });
}
