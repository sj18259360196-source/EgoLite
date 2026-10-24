const guardedStreams = new WeakSet();

export function isBrokenPipeError(error) {
  return error?.code === "EPIPE";
}

export function installProcessIoGuards({ stdout = process.stdout, stderr = process.stderr } = {}) {
  for (const stream of [stdout, stderr]) {
    if (!stream?.on || guardedStreams.has(stream)) continue;
    stream.on("error", handleStreamError);
    guardedStreams.add(stream);
  }
}

function handleStreamError(error) {
  if (isBrokenPipeError(error)) return;
  throw error;
}
