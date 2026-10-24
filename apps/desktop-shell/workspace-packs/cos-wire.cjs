// JSON-safe IPC across the independently versioned Ego and CoS V8 runtimes.
function encodeWire(value, ancestors = new Set()) {
  if (value === undefined) return ["undefined"];
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Buffer.isBuffer(value)) return ["buffer", value.toString("base64")];
  if (value instanceof Uint8Array) return ["bytes", Buffer.from(value).toString("base64")];
  if (value instanceof ArrayBuffer) return ["array-buffer", Buffer.from(value).toString("base64")];
  if (typeof value !== "object" || ArrayBuffer.isView(value)) throw new Error("Unsupported CoS IPC value");
  if (ancestors.has(value)) throw new Error("Circular CoS IPC value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return ["array", value.map(item => encodeWire(item, ancestors))];
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("Unsupported CoS IPC object");
    }
    return ["object", Object.entries(value).map(([key, item]) => [key, encodeWire(item, ancestors)])];
  } finally { ancestors.delete(value); }
}

function decodeWire(value) {
  if (!Array.isArray(value)) {
    if (value === null || ["string", "boolean", "number"].includes(typeof value)) return value;
    throw new Error("Invalid CoS IPC value");
  }
  const [type, data] = value;
  if (type === "undefined") return undefined;
  if (["bytes", "buffer", "array-buffer"].includes(type) && typeof data === "string") {
    const bytes = Buffer.from(data, "base64");
    if (type === "buffer") return bytes;
    const array = new Uint8Array(bytes);
    return type === "array-buffer" ? array.buffer : array;
  }
  if (type === "array" && Array.isArray(data)) return data.map(decodeWire);
  if (type === "object" && Array.isArray(data)) {
    const object = {};
    for (const [key, item] of data) {
      if (typeof key !== "string") throw new Error("Invalid CoS IPC property");
      Object.defineProperty(object, key, { value: decodeWire(item), enumerable: true, writable: true, configurable: true });
    }
    return object;
  }
  throw new Error("Invalid CoS IPC encoding");
}

module.exports = { encodeWire, decodeWire };
