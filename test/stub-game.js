// A stand-in game server for the router's tests: speaks the router's stdin/stdout protocol and
// nothing else.
//
// It listens on a free TCP port and reports it ({"event":"port"}). A test connects to that port
// to drive it: every line the test writes is printed to stdout as if the game had said it, and
// every command the router writes to stdin is sent back to the test, after a first line with
// the ROUTER_* environment the router gave it. A close command ends it, unless
// STUB_IGNORE_CLOSE=1. STUB_CRASH=1 exits before reporting a port.

const net = require('net');
const readline = require('readline');

if (process.env.STUB_CRASH === '1') {
  console.error('stub: crashing on purpose');
  process.exit(3);
}

const clients = new Set();
const commands = [];
const server = net.createServer((socket) => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => {});
  const env = {};
  for (const k of Object.keys(process.env)) if (k.startsWith('ROUTER_')) env[k] = process.env[k];
  const keys = Object.keys(process.env).filter((k) => k.startsWith('ACCESS_KEY'));
  socket.write(JSON.stringify({ env, keys }) + '\n');
  for (const c of commands) socket.write(c + '\n');
  readline.createInterface({ input: socket }).on('line', (line) => process.stdout.write(line + '\n')).on('error', () => {});
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ event: 'port', data: /** @type {net.AddressInfo} */ (server.address()).port }) + '\n');
});

const commandsIn = readline.createInterface({ input: process.stdin });
// The router is gone (a killed parent does not take its children with it on Windows).
commandsIn.on('close', () => process.exit(0));
commandsIn.on('line', (line) => {
  commands.push(line);
  for (const socket of clients) socket.write(line + '\n');
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.cmd === 'close' && process.env.STUB_IGNORE_CLOSE !== '1') setTimeout(() => process.exit(0), 50);
});
