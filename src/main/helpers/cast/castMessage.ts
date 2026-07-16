/**
 * The castv2 wire format, by hand.
 *
 * Every frame is a 4-byte big-endian length followed by a protobuf CastMessage:
 *   1 protocol_version (varint, 0 = CASTV2_1_0)
 *   2 source_id        (string)
 *   3 destination_id   (string)
 *   4 namespace        (string)
 *   5 payload_type     (varint, 0 = STRING)
 *   6 payload_utf8     (string)
 *
 * That is small enough to encode directly, which is why this ships no protobuf
 * dependency: the toolchain here is Node 12 / webpack 4 and adding one is a
 * bigger risk than owning sixty lines.
 *
 * NOTE: no `?.`/`??` — webpack 4 cannot parse them (see services/subtitle/ai).
 */

export interface CastFrame {
  namespace: string;
  payload: string;
  source?: string;
  destination?: string;
}

function varint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    /* eslint-disable no-bitwise */
    let byte = v & 0x7f;
    v >>>= 7;
    if (v) byte |= 0x80;
    /* eslint-enable no-bitwise */
    out.push(byte);
  } while (v);
  return Buffer.from(out);
}

function stringField(field: number, value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  // eslint-disable-next-line no-bitwise
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes]);
}

function varintField(field: number, value: number): Buffer {
  // eslint-disable-next-line no-bitwise
  return Buffer.concat([varint((field << 3) | 0), varint(value)]);
}

export function encodeFrame(frame: Required<CastFrame>): Buffer {
  const message = Buffer.concat([
    varintField(1, 0),
    stringField(2, frame.source),
    stringField(3, frame.destination),
    stringField(4, frame.namespace),
    varintField(5, 0),
    stringField(6, frame.payload),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length, 0);
  return Buffer.concat([length, message]);
}

function readVarint(buf: Buffer, start: number): [number, number] {
  let result = 0;
  let shift = 0;
  let i = start;
  for (;;) {
    const byte = buf[i];
    i += 1;
    /* eslint-disable no-bitwise */
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    /* eslint-enable no-bitwise */
    shift += 7;
  }
  // eslint-disable-next-line no-bitwise
  return [result >>> 0, i];
}

export function decodeMessage(message: Buffer): CastFrame {
  const fields: { [key: number]: string | number } = {};
  let i = 0;
  while (i < message.length) {
    let tag = 0;
    [tag, i] = readVarint(message, i);
    /* eslint-disable no-bitwise */
    const field = tag >>> 3;
    const wire = tag & 7;
    /* eslint-enable no-bitwise */
    if (wire === 0) {
      let value = 0;
      [value, i] = readVarint(message, i);
      fields[field] = value;
    } else if (wire === 2) {
      let length = 0;
      [length, i] = readVarint(message, i);
      fields[field] = message.slice(i, i + length).toString('utf8');
      i += length;
    } else {
      // Nothing in CastMessage uses another wire type; a frame that does is not
      // one we understand, so stop rather than misread the rest.
      break;
    }
  }
  return {
    namespace: (fields[4] as string) || '',
    payload: (fields[6] as string) || '',
    source: fields[2] as string,
    destination: fields[3] as string,
  };
}

/**
 * Split a stream into frames. Returns the frames it could read and whatever
 * bytes are left over, since a frame can arrive across several packets.
 */
export function readFrames(buffer: Buffer): { frames: CastFrame[], rest: Buffer } {
  const frames: CastFrame[] = [];
  let rest = buffer;
  while (rest.length >= 4) {
    const length = rest.readUInt32BE(0);
    if (rest.length < 4 + length) break;
    frames.push(decodeMessage(rest.slice(4, 4 + length)));
    rest = rest.slice(4 + length);
  }
  return { frames, rest };
}
