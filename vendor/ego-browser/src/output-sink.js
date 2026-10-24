let buffer = [];
let hardStopMessage = null;
let noticeTrailer = null;
let flushed = false;
let lifecycleHooked = false;
function bufferOutput(chunk) {
  buffer.push(chunk);
}
function setNoticeTrailer(line) {
  noticeTrailer = line;
}
function markHardStop(message) {
  if (hardStopMessage === null) {
    hardStopMessage = message;
  }
}
function flushSink(stream, thrown) {
  if (flushed) return;
  flushed = true;
  if (hardStopMessage !== null) {
    if (!thrown) {
      stream.write(
        hardStopMessage.endsWith("\n") ? hardStopMessage : `${hardStopMessage}
`
      );
    }
  } else {
    for (const chunk of buffer) stream.write(chunk);
  }
  if (noticeTrailer !== null) {
    stream.write(
      noticeTrailer.endsWith("\n") ? noticeTrailer : `${noticeTrailer}
`
    );
  }
  buffer = [];
}
function resetSink() {
  buffer = [];
  hardStopMessage = null;
  noticeTrailer = null;
  flushed = false;
}
function installLifecycleFlush(stream) {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  process.on("beforeExit", () => flushSink(stream, false));
  process.on("exit", () => flushSink(stream, true));
}
export {
  bufferOutput,
  flushSink,
  installLifecycleFlush,
  markHardStop,
  resetSink,
  setNoticeTrailer
};
