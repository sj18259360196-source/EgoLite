import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr
} from "node:process";
import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import { bufferOutput, flushSink, resetSink } from "./output-sink.js";
const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  await page.waitForLoadState()
  console.log(await page.info())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.

Commands:
  ego-browser --doctor         inspect browser and connection state
  ego-browser --reload         reset the browser connection on next call
`;
const USAGE = `Usage:
  ego-browser <<'JS'
  console.log(await page.info())
  JS
`;
async function runMain(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;
  const env = options.env || process.env;
  const services = {
    resetConnection: async () => {
    },
    printUpdateBanner: () => {
    },
    runDoctor: async () => 0,
    ...options.services
  };
  if (argv[0] === "-h" || argv[0] === "--help") {
    write(stdout, HELP);
    return 0;
  }
  if (argv[0] === "--doctor") {
    return services.runDoctor(stdout);
  }
  if (argv[0] === "--reload") {
    await services.resetConnection();
    write(stdout, "browser connection reset on next call\n");
    return 0;
  }
  if (argv[0] === "--debug-clicks") {
    env.EGO_BROWSER_DEBUG_CLICKS = "1";
    argv.shift();
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }
  const code = options.stdinText !== void 0 ? options.stdinText : await readAll(options.stdin || processStdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }
  services.printUpdateBanner(stderr);
  await execute(code, stdout);
  return 0;
}
async function execute(code, stdout) {
  resetSink();
  const context = await executionContext();
  Object.assign(globalThis, context);
  const AsyncFunction = Object.getPrototypeOf(async function() {
  }).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  const fn = new AsyncFunction(...names, `"use strict";
${code}`);
  try {
    await fn(...values);
  } catch (error) {
    flushSink(stdout, true);
    throw error;
  }
  flushSink(stdout, false);
}
async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  const context = helpers.helperContext(agentHelpers);
  console.log = (...args) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}
`);
  };
  return context;
}
function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}
function write(stream, text) {
  stream.write(text);
}
export {
  HELP,
  USAGE,
  executionContext,
  runMain
};
