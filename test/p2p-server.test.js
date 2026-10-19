import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { Lobby, Room } from '../server/lobby.js';
import { PeerRelay, parseIceServers, P2P_FRAME_BYTES } from '../server/peerRelay.js';
import { validateC2S } from '../shared/protocol.js';
import { ERR } from '../shared/constants.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stateOnly = ({ deliveryEpoch: _epoch, deliverySeq: _seq, ...state }) => state;
function socket() {
  return { readyState: 1, bufferedAmount: 0, frames: [], send(frame) { this.frames.push(JSON.parse(frame)); }, terminate() { this.readyState = 3; } };
}

function setup(t, count = 3, options = {}) {
  let clock = 1000;
  const members = new Map();
  const lobby = new Lobby({ registry: { byId: (id) => members.get(id) }, getData: () => ({}), now: () => clock });
  lobby.peerRelay.dispose();
  lobby.peerRelay = new PeerRelay({ enabled: true, iceServers: [], now: () => clock, ...options });
  const room = new Room('ABCD', 'coop', 'NORMAL', clock);
  lobby.rooms.set(room.code, room);
  const clients = Array.from({ length: count }, (_, i) => {
    const session = { playerId: `player-${i}`, name: `Player ${i}`, connected: true, roomCode: room.code, ws: socket() };
    members.set(session.playerId, session);
    room.seats[i] = lobby.humanSeat(i, session);
    return session;
  });
  room.hostId = clients[0].playerId;
  t.after(() => lobby.shutdown());
  const clear = () => { for (const client of clients) client.ws.frames.length = 0; };
  const enable = (client, enabled = true) => lobby.onMessage(client, { t: 'p2p.enable', enabled });
  const plan = () => lobby.peerRelay.rooms.get(room);
  const ready = (client, seq = 0, enabled = true) => lobby.onMessage(client, { t: 'p2p.ready', epoch: plan().epoch, ready: enabled, seq });
  const start = () => { clients.forEach((c) => enable(c)); clients.forEach((c) => ready(c)); clear(); };
  return { lobby, room, clients, members, clear, enable, plan, ready, start, advance: (ms) => { clock += ms; } };
}

test('public fanout sends one verifiable envelope and preserves the original replay bytes', (t) => {
  const { lobby, room, clients: [a, b, c], start, plan } = setup(t);
  start();
  const payload = { t: 'm.public', serverNow: 1000, round: 1, padding: 'abc'.repeat(500) };
  const original = lobby.broadcastRoom(room, payload);
  assert.deepEqual(stateOnly(JSON.parse(original)), payload);
  assert.equal(a.ws.frames.length, 1);
  assert.equal(b.ws.frames.length + c.ws.frames.length, 0, 'receivers get their public snapshot through the relay');
  const frame = a.ws.frames[0];
  assert.equal(frame.t, 'p2p.frame');
  assert.equal(frame.payload, original);
  assert.equal(frame.epoch, plan().epoch);
  assert.equal(frame.seq, 1);
  const key = createPublicKey({ key: lobby.peerRelay.keys.publicKey.export({ format: 'jwk' }), format: 'jwk' });
  const signed = Buffer.from(JSON.stringify([frame.epoch, frame.seq, frame.payload]));
  assert(verify('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(frame.signature, 'base64')));
  assert(!verify('sha256', Buffer.from(JSON.stringify([frame.epoch, frame.seq, original + ' '])),
    { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(frame.signature, 'base64')), 'a relay cannot alter state');
  assert(Buffer.byteLength(JSON.stringify(frame)) < 2 * Buffer.byteLength(original), 'fanout reduces WS snapshot bytes');
});

test('private state, commands, and every event stay on WebSocket; unicast public resync is unchanged', (t) => {
  const { lobby, room, clients, start, clear } = setup(t);
  start();
  for (const type of ['m.ticker', 'm.emote', 'm.toast', 'm.result', 'b.pool', 'b.start', 'b.end', 'b.ev', 'b.snap']) {
    lobby.broadcastRoom(room, { t: type, event: 1 });
    for (const c of clients) assert.deepEqual(c.ws.frames.at(-1), { t: type, event: 1 });
  }
  clear();
  lobby.sendToPlayer(room, clients[1].playerId, { t: 'm.private', gold: 10 });
  lobby.sendToPlayer(room, clients[1].playerId, { t: 'm.public', serverNow: 123 });
  assert.deepEqual(clients[1].ws.frames.map(stateOnly), [{ t: 'm.private', gold: 10 }, { t: 'm.public', serverNow: 123 }]);
  assert.equal(clients[0].ws.frames.length + clients[2].ws.frames.length, 0);
  const calls = [];
  room.match = { handle(id, msg) { calls.push({ id, msg }); return { ok: true }; } };
  assert.deepEqual(lobby.onMessage(clients[1], { t: 'g.ready', ready: true }), { ok: true });
  assert.equal(calls[0].id, clients[1].playerId);
});

test('opt-in, opt-out, nonready members, unsupported clients, and solo games retain WS coverage', (t) => {
  const { lobby, room, clients: [a, b, c, d], enable, ready, clear, plan } = setup(t, 4);
  [a, b, c].forEach((x) => enable(x));
  const config = a.ws.frames.findLast((f) => f.t === 'p2p.config' && f.enabled);
  assert.deepEqual(config.peers, [a.playerId, b.playerId, c.playerId]);
  assert.equal(config.relayId, a.playerId);
  assert.equal(config.publicKey.d, undefined);
  assert.deepEqual(config.iceServers, []);
  ready(a); ready(b); clear();
  const raw = lobby.broadcastRoom(room, { t: 'm.public', turn: 1 });
  assert.equal(a.ws.frames[0].t, 'p2p.frame');
  assert.equal(b.ws.frames.length, 0);
  assert.equal(c.ws.frames[0].seq, a.ws.frames[0].seq, 'nonready capable member receives the same signed frame directly');
  assert.equal(c.ws.frames[0].payload, raw);
  assert.deepEqual(d.ws.frames[0], JSON.parse(raw));
  const oldEpoch = plan().epoch;
  enable(b, false);
  assert.notEqual(plan().epoch, oldEpoch);
  assert.equal(plan().peers.some((p) => p.session === b), false);
  clear();
  lobby.broadcastRoom(room, { t: 'm.public', turn: 2 });
  for (const x of [a, b, c, d]) assert.deepEqual(x.ws.frames.map(stateOnly), [{ t: 'm.public', turn: 2 }]);
  room.mode = 'solo';
  clear();
  lobby.broadcastRoom(room, { t: 'm.public', solo: true });
  assert.equal(lobby.peerRelay.rooms.size, 0);
  for (const x of [a, b, c, d]) assert.deepEqual(stateOnly(x.ws.frames.at(-1)), { t: 'm.public', solo: true });
});

test('signaling is bounded and restricted to the current room, epoch, and star links', (t) => {
  const { lobby, room, clients: [a, b, c], members, start, plan } = setup(t);
  start();
  const signal = { t: 'p2p.signal', epoch: plan().epoch, to: b.playerId, description: { type: 'offer', sdp: 'v=0' } };
  assert.deepEqual(lobby.onMessage(a, signal), { ok: true });
  assert.deepEqual(b.ws.frames[0], { t: 'p2p.signal', epoch: plan().epoch, from: a.playerId, description: signal.description });
  assert.equal(lobby.onMessage(b, { ...signal, to: c.playerId }).error, ERR.BAD_TARGET);
  assert.deepEqual(lobby.onMessage(a, { ...signal, epoch: 'stale' }), { ok: true }, 'late negotiation after topology change is harmless');
  assert.equal(b.ws.frames.length, 1, 'stale signal is never forwarded');
  assert.deepEqual(lobby.onMessage(c, { t: 'p2p.ready', epoch: 'stale', ready: true, seq: 999 }), { ok: true });
  const stranger = { playerId: 'outside', connected: true, roomCode: 'EFGH', ws: socket() };
  members.set(stranger.playerId, stranger);
  assert.equal(lobby.onMessage(a, { ...signal, to: stranger.playerId }).error, ERR.BAD_TARGET);
  assert.equal(stranger.ws.frames.length, 0);
  for (let i = 0; i < 23; i++) assert.equal(lobby.onMessage(a, signal).ok, true);
  assert.equal(lobby.onMessage(a, signal).error, ERR.RATE);
  assert.equal(lobby.onMessage(c, { t: 'p2p.ready', epoch: plan().epoch, ready: true, seq: 10 }).error, ERR.BAD_TARGET);
  assert.equal(room.code, 'ABCD');
});

test('protocol rejects injection, ambiguous signals, oversized SDP, and invalid acknowledgement sequences', () => {
  const signal = { t: 'p2p.signal', epoch: 'epoch', to: 'player', candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null } };
  assert.equal(validateC2S(signal), null);
  assert(validateC2S({ ...signal, description: { type: 'offer', sdp: 'x' } }));
  assert(validateC2S({ ...signal, candidate: undefined }));
  assert(validateC2S({ ...signal, candidate: undefined, description: { type: 'offer', sdp: 'x'.repeat(16385) } }));
  assert(validateC2S({ ...signal, candidate: { candidate: 'x', sdpMid: null, sdpMLineIndex: -1 } }));
  assert(validateC2S({ t: 'p2p.ready', epoch: 'epoch', ready: true, seq: -1 }));
  assert(validateC2S({ t: 'p2p.ready', epoch: 'epoch', ready: true, seq: Number.MAX_SAFE_INTEGER + 1 }));
  assert(validateC2S({ t: 'p2p.frame', epoch: 'epoch', seq: 1, payload: '{}' }), 'clients cannot inject server frames');
});

test('unacknowledged fanout resends latest state by the original deadline and blocks repeated ready pulses', async (t) => {
  const { lobby, room, clients: [a, b], start, ready, plan, clear } = setup(t, 2, { ackMs: 70 });
  start();
  lobby.broadcastRoom(room, { t: 'm.public', turn: 1 });
  const timer = plan().peers[1].timer;
  await pause(20);
  lobby.broadcastRoom(room, { t: 'm.public', turn: 2 });
  assert.equal(plan().peers[1].timer, timer, 'new frames cannot postpone an old unacknowledged delivery');
  assert.equal(b.ws.frames.length, 0);
  await pause(70);
  assert.equal(b.ws.frames.length, 1);
  assert.equal(b.ws.frames[0].t, 'p2p.frame');
  assert.equal(b.ws.frames[0].fallback, true);
  assert.equal(JSON.parse(b.ws.frames[0].payload).turn, 2);
  assert.equal(plan().peers[1].timer, null);
  assert.equal(plan().peers[1].ready, false);
  assert.equal(plan().peers[1].blocked, true);
  ready(b, 2); clear();
  lobby.broadcastRoom(room, { t: 'm.public', turn: 3 });
  assert.deepEqual(b.ws.frames.map(stateOnly), [{ t: 'm.public', turn: 3 }]);
  ready(b, 2, false); ready(b, 2); clear();
  lobby.broadcastRoom(room, { t: 'm.public', turn: 4 });
  assert.equal(a.ws.frames[0].t, 'p2p.frame');
  assert.equal(b.ws.frames.length, 0);
  ready(b, 3);
  assert.equal(plan().peers[1].timer, null, 'a verified newest acknowledgement releases fallback resources');
});

test('fresh readiness needs a lease; signing/ack timers are absent for raw-only and oversized state', (t) => {
  const { lobby, room, clients, start, plan, advance, clear } = setup(t, 2);
  start(); advance(3001);
  lobby.broadcastRoom(room, { t: 'm.public', expired: true });
  for (const c of clients) assert.deepEqual(c.ws.frames.map(stateOnly), [{ t: 'm.public', expired: true }]);
  for (const p of plan().peers) assert.equal(p.timer, null);
  start(); clear();
  const payload = { t: 'm.public', text: 'x'.repeat(P2P_FRAME_BYTES) };
  lobby.broadcastRoom(room, payload);
  for (const c of clients) assert.deepEqual(c.ws.frames.map(stateOnly), [payload]);
  assert.equal(plan().seq, 0);
  for (const p of plan().peers) assert.equal(p.timer, null);
});

test('steady delayed ACK progress stays healthy while stagnant ACK heartbeats still time out', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { lobby, room, clients: [a, b], start, ready, plan, advance } = setup(t, 2, { ackMs: 250 });
  start();
  lobby.broadcastRoom(room, { t: 'm.public', turn: 1 });
  for (let turn = 2; turn <= 12; turn++) {
    t.mock.timers.tick(100); advance(100);
    lobby.broadcastRoom(room, { t: 'm.public', turn });
    const previousTimer = plan().peers[1].timer;
    ready(a, turn - 1); ready(b, turn - 1);
    assert.notEqual(plan().peers[1].timer, previousTimer, 'an advancing ACK refreshes the oldest in-flight deadline');
    assert.equal(plan().peers[1].pending.seq, turn);
    assert.equal(plan().peers[1].pending.oldestSeq, turn);
    assert.equal(b.ws.frames.length, 0, 'receiver always lags the latest frame but keeps receiving through RTC');
  }
  const fixedDeadline = plan().peers[1].timer;
  for (let turn = 13; turn <= 14; turn++) {
    t.mock.timers.tick(100); advance(100);
    lobby.broadcastRoom(room, { t: 'm.public', turn });
    ready(a, turn - 1); ready(b, 11);
    assert.equal(plan().peers[1].timer, fixedDeadline, 'unchanged ACK heartbeats and new state do not hide a blackholed relay');
  }
  t.mock.timers.tick(49);
  assert.equal(b.ws.frames.length, 0);
  t.mock.timers.tick(1);
  assert.equal(b.ws.frames.length, 1);
  assert.equal(b.ws.frames[0].fallback, true);
  assert.equal(JSON.parse(b.ws.frames[0].payload).turn, 14, 'timeout still resends the latest available state');
  assert.equal(plan().peers[1].blocked, true);
});

test('public delivery stream orders raw, RTC, and direct snapshots across topology changes and room reuse', (t) => {
  const { lobby, room, clients: [a, b], start, ready, enable, clear } = setup(t, 2);
  const initial = { t: 'm.public', serverNow: 1000, turn: 1 };
  const first = JSON.parse(lobby.broadcastRoom(room, initial));
  assert.deepEqual(initial, { t: 'm.public', serverNow: 1000, turn: 1 }, 'transport metadata never mutates Match state');
  assert.match(first.deliveryEpoch, /^[a-f0-9]{32}$/);
  assert.equal(first.deliverySeq, 1);
  start();
  const second = JSON.parse(lobby.broadcastRoom(room, { t: 'm.public', serverNow: 1000, turn: 2 }));
  assert.equal(second.deliveryEpoch, first.deliveryEpoch);
  assert.equal(second.deliverySeq, 2);
  assert.deepEqual(JSON.parse(a.ws.frames.at(-1).payload), second);
  assert.equal(b.ws.frames.length, 0);
  ready(b, 1);
  enable(b, false); clear();
  lobby.sendToPlayer(room, b.playerId, { t: 'm.public', serverNow: 1000, turn: 3, deliverySeq: -10, deliveryEpoch: 'untrusted' });
  const direct = b.ws.frames[0];
  assert.equal(direct.deliveryEpoch, first.deliveryEpoch);
  assert.equal(direct.deliverySeq, 3, 'a direct snapshot shares the room-wide serial and overwrites supplied metadata');
  const fourth = JSON.parse(lobby.broadcastRoom(room, { t: 'm.public', serverNow: 1000, turn: 4 }));
  assert.equal(fourth.deliverySeq, 4);
  assert.equal(fourth.deliveryEpoch, first.deliveryEpoch);
  const replacementRoom = new Room(room.code, 'coop', 'NORMAL', 1000);
  const replacement = JSON.parse(lobby.broadcastRoom(replacementRoom, { t: 'm.public', serverNow: 1000, turn: 1 }));
  assert.notEqual(replacement.deliveryEpoch, first.deliveryEpoch, 'reusing the short join code cannot reuse the snapshot stream');
  assert.equal(replacement.deliverySeq, 1);
});

test('relay WS send failure immediately falls back for every receiver', (t) => {
  const { lobby, room, clients: [a, b, c], start, plan } = setup(t);
  start();
  a.ws.send = () => { throw new Error('socket failure'); };
  const payload = { t: 'm.public', turn: 1 };
  lobby.broadcastRoom(room, payload);
  assert.deepEqual(b.ws.frames.map(stateOnly), [payload]);
  assert.deepEqual(c.ws.frames.map(stateOnly), [payload]);
  assert.equal(plan().seq, 0);
  for (const peer of plan().peers) assert.equal(peer.timer, null);
});

test('raw fallback invalidates delayed peer bytes before a newer oversized snapshot', (t) => {
  const { lobby, room, clients: [a, b], start, plan } = setup(t, 2);
  start();
  lobby.broadcastRoom(room, { t: 'm.public', serverNow: 1000, turn: 1 });
  const previous = plan();
  const oversized = { t: 'm.public', serverNow: 1000, turn: 2, text: 'x'.repeat(P2P_FRAME_BYTES) };
  lobby.broadcastRoom(room, oversized);
  assert.notEqual(plan().epoch, previous.epoch);
  assert(previous.peers.every((p) => p.timer === null));
  assert.deepEqual(stateOnly(a.ws.frames.at(-1)), oversized);
  assert.deepEqual(stateOnly(b.ws.frames.at(-1)), oversized);
  assert(plan().peers.every((p) => !p.ready));
});

test('membership, replacement, match lifecycle, disconnect, and shutdown invalidate stale routing and clean timers', (t) => {
  const { lobby, room, clients: [a, b, c], start, plan, enable, ready, clear } = setup(t);
  start();
  let epoch = plan().epoch;
  lobby.sendState(room, a);
  assert.equal(plan().epoch, epoch, 'ordinary state resync preserves healthy topology');
  lobby.broadcastRoom(room, { t: 'm.public', turn: 1 });
  room.match = {};
  lobby.broadcastState(room);
  assert.notEqual(plan().epoch, epoch, 'new match invalidates in-flight snapshots');
  epoch = plan().epoch;
  b.ws = socket();
  lobby.sendState(room, b);
  assert.notEqual(plan().epoch, epoch);
  assert.equal(plan().peers.some((p) => p.session === b), false, 'replaced socket must opt in again');
  enable(b); [a, b, c].forEach((x) => ready(x));
  lobby.broadcastRoom(room, { t: 'm.public', turn: 2 });
  const previous = plan();
  c.connected = false; c.ws.readyState = 3;
  lobby.onDisconnect(c);
  assert.notEqual(plan().epoch, previous.epoch);
  assert(previous.peers.every((p) => p.timer === null));
  assert.equal(lobby.peerRelay.capable(c), false);
  clear(); [a, b].forEach((x) => ready(x));
  lobby.broadcastRoom(room, { t: 'm.public', turn: 3 });
  const ending = plan();
  lobby.shutdown();
  assert.equal(lobby.peerRelay.rooms.size, 0);
  assert(ending.peers.every((p) => p.timer === null));
});

test('ICE configuration accepts STUN/TURN and rejects malformed configuration without exposing secrets', () => {
  assert.deepEqual(parseIceServers('[{"urls":"stun:stun.example.org:3478"},{"urls":["turn:turn.example.org:3478?transport=udp"],"username":"u","credential":"secret"}]'),
    [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478?transport=udp'], username: 'u', credential: 'secret' }]);
  assert.throws(() => parseIceServers('{"credential":"secret"}'));
  assert.throws(() => parseIceServers('[{"urls":"https:example.org"}]'));
  const old = process.env.SP_P2P_ICE_SERVERS;
  const warnings = [];
  try {
    process.env.SP_P2P_ICE_SERVERS = '{"credential":"secret"}';
    const relay = new PeerRelay({ enabled: true, log: { warn: (msg) => warnings.push(msg) } });
    assert.equal(relay.enabled, false);
    assert.equal(warnings.length, 1);
    assert(!warnings[0].includes('secret'));
    relay.dispose();
  } finally {
    if (old === undefined) delete process.env.SP_P2P_ICE_SERVERS;
    else process.env.SP_P2P_ICE_SERVERS = old;
  }
});
