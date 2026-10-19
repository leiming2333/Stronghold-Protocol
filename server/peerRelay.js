// Co-op public snapshots only. The server remains authoritative; WebRTC peers forward signed bytes.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { ERR } from '../shared/constants.js';
import { encode, sendRaw, sendSession } from './net.js';

export const P2P_LEASE_MS = 3000;
export const P2P_ACK_MS = 2500;
export const P2P_FRAME_BYTES = 60 * 1024;

/** Validate operator-provided STUN/TURN configuration without ever logging credentials. */
export function parseIceServers(value) {
  if (!value) return [];
  const servers = JSON.parse(value);
  if (!Array.isArray(servers) || servers.length > 8) throw new Error('expected up to 8 ICE servers');
  return servers.map((server) => {
    if (!server || typeof server !== 'object' || Array.isArray(server)) throw new Error('invalid ICE server');
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || !urls.length || urls.length > 8
      || !urls.every((url) => typeof url === 'string' && url.length <= 2048 && /^(stun|stuns|turn|turns):[^\s]+$/i.test(url))) {
      throw new Error('invalid ICE urls');
    }
    const out = { urls: [...urls] };
    for (const key of ['username', 'credential']) {
      if (server[key] === undefined) continue;
      if (typeof server[key] !== 'string' || server[key].length > 2048) throw new Error('invalid ICE credentials');
      out[key] = server[key];
    }
    return out;
  });
}

/** One small star per room. Capability and readiness are tied to a particular WebSocket. */
export class PeerRelay {
  constructor({ now = Date.now, log = { warn() {} }, enabled = process.env.SP_P2P !== '0',
    iceServers, ackMs = P2P_ACK_MS } = {}) {
    this.now = now;
    this.enabled = enabled;
    this.ackMs = ackMs;
    this.capabilities = new WeakMap();
    this.rooms = new Map();
    this.keys = null;
    try { this.iceServers = iceServers ?? parseIceServers(process.env.SP_P2P_ICE_SERVERS); }
    catch { this.iceServers = []; this.enabled = false; log.warn('[p2p] Invalid SP_P2P_ICE_SERVERS; peer delivery disabled'); }
  }

  capable(session) { return this.enabled && session.connected && !!session.ws && this.capabilities.get(session) === session.ws; }

  enable(session, enabled) {
    if (enabled && this.enabled) this.capabilities.set(session, session.ws);
    else this.capabilities.delete(session);
    if (!this.capable(session)) sendSession(session, { t: 'p2p.config', enabled: false });
  }

  disconnect(session) { this.capabilities.delete(session); }

  /** Sync after every membership/socket change; repeated room-state requests also resend their config. */
  sync(room, sessions, requester = null) {
    sessions = sessions.filter((s) => s.connected && s.ws?.readyState === 1 && s.roomCode === room.code);
    const peers = room.mode === 'coop' && !room.disposed ? sessions.filter((s) => this.capable(s)) : [];
    const previous = this.rooms.get(room);
    const same = previous && previous.match === room.match && previous.matchCtx === room.matchCtx && previous.members.length === sessions.length
      && previous.members.every((m, i) => m.session === sessions[i] && m.ws === sessions[i].ws)
      && previous.peers.length === peers.length && previous.peers.every((p, i) => p.session === peers[i]);
    if (same) {
      if (requester) this.config(previous, requester);
      return previous;
    }
    if (previous) this.clear(room);
    if (peers.length < 2) {
      for (const s of peers) sendSession(s, { t: 'p2p.config', enabled: false });
      return null;
    }
    this.keys ||= generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const plan = {
      room, match: room.match, matchCtx: room.matchCtx, epoch: randomBytes(16).toString('hex'), seq: 0,
      members: sessions.map((session) => ({ session, ws: session.ws })),
      peers: peers.map((session) => ({ session, ready: false, blocked: false, leaseUntil: 0, ack: 0, pending: null, timer: null })),
    };
    this.rooms.set(room, plan);
    for (const s of peers) this.config(plan, s);
    return plan;
  }

  config(plan, session) {
    if (!plan.peers.some((p) => p.session === session)) return;
    sendSession(session, {
      t: 'p2p.config', enabled: true, epoch: plan.epoch, relayId: plan.peers[0].session.playerId,
      peers: plan.peers.map((p) => p.session.playerId), publicKey: this.keys.publicKey.export({ format: 'jwk' }),
      iceServers: this.iceServers, leaseMs: P2P_LEASE_MS,
    });
  }

  signal(room, session, msg) {
    const plan = this.rooms.get(room);
    if (msg.epoch !== plan?.epoch && this.capable(session)) return { ok: true };
    const from = plan?.peers.find((p) => p.session === session);
    const to = plan?.peers.find((p) => p.session.playerId === msg.to);
    if (!plan || msg.epoch !== plan.epoch || !from || !to || from === to
      || (from !== plan.peers[0] && to !== plan.peers[0])) return { error: ERR.BAD_TARGET };
    // The network's normal 40/s bucket applies too. Limit forwarded SDP/ICE separately to prevent room amplification.
    const now = this.now();
    if (from.signalAt === undefined || now - from.signalAt >= 1000) { from.signalAt = now; from.signals = 0; }
    if (++from.signals > 24) return { error: ERR.RATE };
    const fields = msg.description ? { description: { type: msg.description.type, sdp: msg.description.sdp } }
      : { candidate: { candidate: msg.candidate.candidate, sdpMid: msg.candidate.sdpMid, sdpMLineIndex: msg.candidate.sdpMLineIndex } };
    sendSession(to.session, { t: 'p2p.signal', epoch: plan.epoch, from: session.playerId, ...fields });
    return { ok: true };
  }

  ready(room, session, msg) {
    const plan = this.rooms.get(room);
    if (msg.epoch !== plan?.epoch && this.capable(session)) return { ok: true };
    const peer = plan?.peers.find((p) => p.session === session);
    if (!peer || plan.epoch !== msg.epoch || msg.seq > plan.seq || msg.seq < peer.ack) return { error: ERR.BAD_TARGET };
    if (!msg.ready) peer.blocked = false;
    if (msg.ready && peer.blocked) return { ok: true };
    const advanced = msg.seq > peer.ack;
    peer.ready = msg.ready;
    peer.leaseUntil = msg.ready ? this.now() + P2P_LEASE_MS : 0;
    peer.ack = msg.seq;
    if (!msg.ready) this.fallback(plan, peer);
    else if (peer.pending && msg.seq >= peer.pending.seq) this.clearPending(peer);
    else if (peer.pending && advanced && msg.seq >= peer.pending.oldestSeq) {
      // A healthy receiver may always be a few frames behind an actively updating room.
      // ACK progress proves the old delivery succeeded even while a newer snapshot is in flight.
      peer.pending.oldestSeq = msg.seq + 1;
      this.watch(plan, peer);
    }
    return { ok: true };
  }

  clearPending(peer) {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = null;
    peer.pending = null;
  }

  watch(plan, peer) {
    if (peer.timer) clearTimeout(peer.timer);
    peer.timer = setTimeout(() => {
      if (this.rooms.get(plan.room) === plan) this.fallback(plan, peer, true);
    }, this.ackMs);
    peer.timer.unref?.();
  }

  fallback(plan, peer, timeout = false) {
    const latest = timeout && peer.pending ? encode({ ...peer.pending.frame, fallback: true }) : peer.pending?.payload;
    this.clearPending(peer);
    peer.ready = false;
    peer.leaseUntil = 0;
    if (timeout) peer.blocked = true;
    if (latest && peer.session.roomCode === plan.room.code) sendRaw(peer.session.ws, latest);
  }

  rawFallback(room, sessions, plan) {
    // A new raw snapshot has no peer sequence. Invalidate pending peer bytes before it can supersede them,
    // including two snapshots produced in the same serverNow millisecond.
    if (plan.peers.some((p) => p.pending)) {
      this.clear(room);
      this.sync(room, sessions);
    }
    return false;
  }

  /** True if this method delivered the broadcast; false leaves the original WS broadcast to the lobby. */
  broadcast(room, sessions, payload) {
    const plan = this.sync(room, sessions);
    if (!plan) return false;
    const now = this.now();
    const relay = plan.peers[0];
    const receivers = relay.ready && relay.leaseUntil > now
      ? plan.peers.slice(1).filter((p) => p.ready && p.leaseUntil > now) : [];
    if (!receivers.length) return this.rawFallback(room, sessions, plan);
    // Reserve overhead before signing: large payloads use the existing reliable WebSocket transport.
    const seq = plan.seq + 1;
    const unsigned = { t: 'p2p.frame', epoch: plan.epoch, seq, payload, signature: 'A'.repeat(88) };
    if (Buffer.byteLength(JSON.stringify(unsigned)) >= P2P_FRAME_BYTES) return this.rawFallback(room, sessions, plan);
    const signature = sign('sha256', Buffer.from(JSON.stringify([plan.epoch, seq, payload])),
      { key: this.keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
    const frame = { ...unsigned, signature };
    const data = encode(frame);
    if (!sendRaw(relay.session.ws, data)) {
      for (const p of plan.peers) this.fallback(plan, p);
      return false;
    }
    plan.seq = seq;
    for (const session of sessions) {
      if (session === relay.session) continue;
      const peer = plan.peers.find((p) => p.session === session);
      if (receivers.includes(peer)) {
        const oldestSeq = peer.pending?.oldestSeq ?? seq;
        peer.pending = { seq, payload, frame, oldestSeq };
        // Sending newer state cannot postpone the deadline; only an advancing ACK can do that.
        if (!peer.timer) this.watch(plan, peer);
      } else {
        if (peer) this.clearPending(peer);
        if (!peer || !sendRaw(session.ws, data)) sendRaw(session.ws, payload);
      }
    }
    return true;
  }

  clear(room) {
    const plan = this.rooms.get(room);
    if (!plan) return;
    this.rooms.delete(room);
    for (const peer of plan.peers) {
      this.fallback(plan, peer);
      sendSession(peer.session, { t: 'p2p.config', enabled: false });
    }
  }

  dispose() { for (const room of this.rooms.keys()) this.clear(room); }
}
