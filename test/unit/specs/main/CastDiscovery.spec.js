import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import dgram from 'dgram';
import net from 'net';
import os from 'os';
import { discoverCastDevices, discoverWithKnown } from '../../../../src/main/helpers/cast/CastDiscovery';

const SERVICE = '_googlecast._tcp.local';
const INSTANCE = `tv.${SERVICE}`;
const HOST = 'tv.local';

function name(value) {
  return Buffer.concat([...value.split('.').map(label => Buffer.concat([
    Buffer.from([Buffer.byteLength(label)]), Buffer.from(label),
  ])), Buffer.from([0])]);
}

function record(owner, type, payload) {
  const header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(120, 4);
  header.writeUInt16BE(payload.length, 8);
  return Buffer.concat([name(owner), header, payload]);
}

function packet(...records) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x8400, 2);
  header.writeUInt16BE(records.length, 6);
  return Buffer.concat([header, ...records]);
}

const ptr = () => record(SERVICE, 12, name(INSTANCE));
const srv = () => {
  const data = Buffer.alloc(6);
  data.writeUInt16BE(8009, 4);
  return record(INSTANCE, 33, Buffer.concat([data, name(HOST)]));
};
const txt = () => record(INSTANCE, 16, Buffer.concat([Buffer.from([10]), Buffer.from('fn=Test TV')]));
const address = () => record(HOST, 1, Buffer.from([10, 0, 0, 62]));

describe('Chromecast multicast discovery', () => {
  let sockets;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '10.0.0.254' }],
      bridge100: [{ family: 'IPv4', internal: false, address: '10.211.55.2' }],
      lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    });
    vi.spyOn(dgram, 'createSocket').mockImplementation(() => {
      const socket = new EventEmitter();
      socket.bind = vi.fn((port, callback) => { socket.start = callback; });
      socket.addMembership = vi.fn();
      socket.setMulticastInterface = vi.fn();
      socket.send = vi.fn();
      socket.close = vi.fn();
      sockets.push(socket);
      return socket;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('searches each LAN interface and survives a broken virtual adapter', async () => {
    const discovery = discoverCastDevices();
    expect(sockets).toHaveLength(2);
    sockets[0].start();
    expect(sockets[0].addMembership).toHaveBeenCalledWith('224.0.0.251', '10.0.0.254');
    expect(sockets[0].setMulticastInterface).toHaveBeenCalledWith('10.0.0.254');
    sockets[1].emit('error', new Error('No multicast route'));
    sockets[0].emit('message', packet(ptr(), srv(), txt(), address()));
    await vi.advanceTimersByTimeAsync(4000);

    expect(await discovery).toEqual([{
      id: INSTANCE, name: 'Test TV', host: HOST, ip: '10.0.0.62', port: 8009,
    }]);
    expect(sockets.every(socket => socket.close.mock.calls.length)).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries missing service details and accepts address records arriving before the PTR', async () => {
    const discovery = discoverCastDevices();
    sockets.forEach(socket => socket.start());
    expect(sockets[1].setMulticastInterface).toHaveBeenCalledWith('10.211.55.2');
    sockets[0].emit('message', packet(address(), ptr()));
    const srvQueries = () => sockets[0].send.mock.calls.filter(([data]) => (
      data.readUInt16BE(data.length - 4) === 33
    ));
    expect(srvQueries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1200);
    expect(srvQueries().length).toBeGreaterThan(1);
    sockets[0].emit('message', packet(srv(), txt()));
    await vi.advanceTimersByTimeAsync(2800);

    expect(await discovery).toEqual([{
      id: INSTANCE, name: 'Test TV', host: HOST, ip: '10.0.0.62', port: 8009,
    }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the search immediately when every interface fails', async () => {
    const discovery = discoverCastDevices();
    sockets.forEach(socket => socket.emit('error', new Error('Disconnected')));
    expect(await discovery).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create sockets when there is no LAN interface', async () => {
    os.networkInterfaces.mockReturnValue({});
    expect(await discoverCastDevices()).toEqual([]);
    expect(dgram.createSocket).not.toHaveBeenCalled();
  });

  it.each([true, false])('only retains a quiet remembered TV if its Cast port is reachable: %s', async (reachable) => {
    const connection = new EventEmitter();
    connection.setTimeout = vi.fn();
    connection.destroy = vi.fn();
    connection.connect = vi.fn(() => connection.emit(reachable ? 'connect' : 'timeout'));
    vi.spyOn(net, 'Socket').mockImplementation(function SocketMock() { return connection; });
    const device = { id: INSTANCE, name: 'Test TV', host: HOST, ip: '10.0.0.62', port: 8009 };
    const onRemembered = vi.fn();
    const discovery = discoverWithKnown([device], 100, onRemembered);
    await vi.advanceTimersByTimeAsync(0);
    expect(onRemembered).toHaveBeenCalledWith(reachable ? [device] : []);
    expect(connection.connect).toHaveBeenCalledWith(8009, '10.0.0.62');
    sockets.forEach(socket => socket.start());
    await vi.advanceTimersByTimeAsync(100);

    expect(await discovery).toEqual(reachable ? [device] : []);
    expect(connection.connect).toHaveBeenCalledWith(8009, '10.0.0.62');
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
