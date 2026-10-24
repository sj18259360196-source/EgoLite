import test from "node:test";
import assert from "node:assert/strict";
import { encodeWire, decodeWire } from "./cos-wire.cjs";

const roundTrip = value => decodeWire(JSON.parse(JSON.stringify(encodeWire(value))));
test("CoS JSON wire preserves binary data and ordinary nested values", () => {
  const value = {
    files: [{ name: "fixture.bin", bytes: new Uint8Array([0, 127, 128, 255]) }],
    buffer: Buffer.from([0, 1, 255]), arrayBuffer: new Uint8Array([2, 254]).buffer,
    absent: undefined, empty: null, flag: false, count: 42,
  };
  assert.deepEqual(roundTrip(value), value);
});
test("CoS wire tags cannot collide with user arrays or object keys", () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"value":["bytes","AAAA"],"constructor":"text"}');
  const decoded = roundTrip(value);
  assert.deepEqual(decoded, value);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal({}.polluted, undefined);
});
test("CoS wire rejects unsupported and circular values explicitly", () => {
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => encodeWire(cycle), /Circular/);
  for (const value of [new Map(), new Date(), new Uint16Array([1]), 1n, NaN]) {
    assert.throws(() => encodeWire(value), /Unsupported/);
  }
  assert.throws(() => decodeWire({ unencoded: true }), /Invalid/);
});
