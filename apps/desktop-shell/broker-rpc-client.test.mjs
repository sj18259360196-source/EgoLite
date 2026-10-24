import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PipeRpcClient } from './broker-rpc-client.mjs';

test('rejects new calls on a disconnected real pipe and times out unresponsive calls', async () => {
  const sockets=new Set();
  const pipe='\\\\.\\pipe\\ego-rpc-test-'+randomUUID();
  const server=createServer(s=>{sockets.add(s);s.resume();});
  await new Promise(r=>server.listen(pipe,r));
  const client=await PipeRpcClient.connect(pipe,{timeoutMs:100});
  try {
    await assert.rejects(client.request('no-response'),/timed out/);
    assert.equal(client.pending.size,0);
    const disconnected=new Promise(r=>client.onDisconnect(r));
    for(const s of sockets)s.destroy();
    await disconnected;
    await assert.rejects(client.request('after-close'),/closed/);
    assert.equal(client.pending.size,0);
  } finally { await client.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r)); }
});
