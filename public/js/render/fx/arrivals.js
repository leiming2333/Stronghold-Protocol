// public/js/render/fx/arrivals.js — FxSystem deploy, promotion, death, crates and pops.
// Installed on FxSystem.prototype by ./system.js (a method container: never instantiated; `this` is the effect system).

import { COLORS, DMG_STYLE } from '../style.js';
import { SKILL_GOLD, easeOut } from './limits.js';

export class FxArrivals {
  deploy(view) {
    if (!view) return;
    const p = this._proj(view.x, view.y, view.z || 0);
    const s = p.s;
    const col = view.isEnemy ? 0xff6a5a : 0x9ff0dc;
    this.particle('pillar', p.x, p.y, { tint: col, life: 0.45, s0: s / 64 * 0.7, s1: s / 64 * 0.2, a0: 0.9, a1: 0, sx: 1, ay: 1 });
    this.ring(view.x, view.y, view.z || 0, 0.1, 0.8, col, 0.45);
    this.burst(p.x, p.y, s, 6, col, { speed: 1.6, up: 0.4, life: 0.4, tex: 'dot' });
  }

  /**
   * Promotion (精锐晋升, a merge of three copies) at the elite's spot — the board tile of the consumed copy it replaced
   * (PRTS 卫戍协议/帮助 "若消耗已部署至作战区的干员，则发送至作战区对应位置") or its bench slot. The loudest cue on the
   * board, so a merge reads at a glance over the deploy flash and a skill burst: `from` = world points of the other
   * consumed copies, each feeding the elite two gold streaks (a bright one over a soft one) and, at high quality, a
   * flare where it stood; at the elite a tall gold pillar around a white-hot core with a slow sky beam, a star flare
   * and a ground glow, a wide shockwave plus two hex rings sweeping out (a second, slower one behind), and a dense
   * golden burst (star-shaped sparks at high quality) with slow motes rising through the pillar. Counted in
   * `promotions` (render/app.js setPrep; tests).
   * @param {any} view
   * @param {Array<{ x: number, y: number, z?: number }>} [from]
   */
  promote(view, from = []) {
    if (!view) return;
    this.promotions = (this.promotions || 0) + 1;
    const z = view.z || 0;
    const g = this._proj(view.x, view.y, z, this._g);
    const gx = g.x, gy = g.y, s = g.s;
    // the consumed copies feed the elite: two streaks each (0.3 / 0.55 tiles up, so the pair reads as one thick line),
    // plus a flare standing where each was — the origin is read before streak() re-projects into the shared buffers
    for (const f of from) {
      if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.y)) continue;
      const fz = Math.max(z, f.z || 0);
      if (this.rich) {
        const fp = this._proj(f.x, f.y, fz, this._q);
        this.particle('flare', fp.x, fp.y, { tint: 0xfff2c0, life: 0.34, s0: (fp.s / 128) * 0.95, s1: (fp.s / 128) * 0.25, a0: 1, a1: 0, rot: Math.random() * 3 });
      }
      this.streak(f.x, f.y, view.x, view.y, fz + 0.3, SKILL_GOLD, 0.65);
      this.streak(f.x, f.y, view.x, view.y, fz + 0.55, 0xfff2c0, 0.5);
    }
    // the elite: a taller gold pillar (up to 1.85 tiles) around a white-hot core and a slow sky beam; a star flare and a
    // ground glow at the chest — the flash the old cue lacked, and what makes the merge unmistakable from a distance
    this.particle('pillar', gx, gy, { tint: SKILL_GOLD, life: 1.05, s0: (s / 64) * 1.25, s1: (s / 64) * (this.rich ? 1.85 : 1.5), a0: 0.95, a1: 0, sx: 0.9, ay: 1 });
    this.particle('pillar', gx, gy, { tint: 0xffffff, life: 0.55, s0: (s / 64) * 1.0, s1: (s / 64) * 1.5, a0: 0.9, a1: 0, sx: 0.4, ay: 1 });
    this.particle('pillar', gx, gy, { tint: 0xfff6cc, life: 0.95, s0: (s / 64) * 0.3, s1: (s / 64) * 0.95, a0: 0.75, a1: 0, sx: 0.22, ay: 1, fadeIn: 0.15 });
    const c = this._chest(view, this._q);
    const cx = c.x, cy = c.y;
    this.particle('flare', cx, cy, { tint: 0xfff0b0, life: 0.42, s0: (s / 128) * 2.6, s1: (s / 128) * 0.7, a0: 1, a1: 0, rot: Math.random() * 3 });
    this.particle('glow', cx, cy, { tint: SKILL_GOLD, life: 0.5, s0: (s / 128) * 1.4, s1: (s / 128) * 3.0, a0: 0.9, a1: 0 });
    // the ground: a wider shockwave, a bigger hex ring, and a second slower hex sweeping out behind it
    this.ring(view.x, view.y, z, 0.1, 2.2, 0xffe7a0, 0.6, 'shock');
    this.ring(view.x, view.y, z, 0.2, 1.7, SKILL_GOLD, 0.9, 'hex');
    this.ring(view.x, view.y, z, 0.45, 1.15, 0xfff2c0, 1.05, 'hex');
    // dense golden burst off the chest, and slow motes rising through the pillar (cosmetic: high quality only)
    this.burst(cx, cy, s, this.rich ? 18 : 8, 0xffe28a, { speed: 1.7, up: 2.0, life: 0.95, tex: this.rich ? 'spark' : 'dot', size: 0.4 });
    if (this.rich) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.random() * 0.6;
        this.particle('dot', gx + Math.cos(a) * s * 0.28, gy + Math.sin(a) * s * 0.1, {
          tint: 0xffe9a8, vx: Math.cos(a) * s * 0.08, vy: -s * (0.45 + Math.random() * 0.6), drag: 0.35,
          life: 1.15 + Math.random() * 0.45, s0: (s / 64) * 0.15, s1: (s / 64) * 0.02, a0: 0.85, a1: 0, fadeIn: 0.2,
        });
      }
    }
  }

  death(view) {
    if (!view) return;
    const p = this._chest(view);
    const s = p.s;
    const col = view.isEnemy ? 0xff7a52 : 0xbfeee2;
    const n = this.quality === 'low' ? 5 : 12;
    for (let i = 0; i < n; i++) {
      this.particle(i % 3 ? 'dot' : 'shard', p.x + (Math.random() - 0.5) * s * 0.5, p.y + (Math.random() - 0.3) * s * 0.6, {
        tint: col, vx: (Math.random() - 0.5) * s * 0.6, vy: -s * (0.4 + Math.random() * 0.8), drag: 1.5,
        life: 0.7 + Math.random() * 0.5, s0: s / 32 * 0.12, s1: 0, a0: 0.9, a1: 0, spin: (Math.random() - 0.5) * 6,
      });
    }
    this.particle('smoke', p.x, p.y, { add: false, tint: 0x1a1a1a, life: 0.8, s0: s / 128 * 0.6, s1: s / 128 * 1.4, a0: 0.5, a1: 0 });
  }

  crateBreak(x, y, z, tint = null) {
    const p = this._proj(x, y, (z || 0) + 0.35);
    const s = p.s;
    for (let i = 0; i < (this.quality === 'low' ? 4 : 10); i++) {
      this.particle('shard', p.x, p.y, {
        add: false, tint: tint ?? (i % 2 ? 0xc89a5a : 0x9a6d38), vx: (Math.random() - 0.5) * s * 2.2, vy: -s * (0.6 + Math.random()), g: s * 4,
        life: 0.6, s0: s / 32 * 0.25, s1: s / 32 * 0.15, a0: 1, a1: 0.2, spin: (Math.random() - 0.5) * 14,
      });
    }
    this.particle('smoke', p.x, p.y, { add: false, tint: 0x8a7a60, life: 0.7, s0: s / 128 * 0.6, s1: s / 128 * 1.5, a0: 0.45, a1: 0 });
  }

  /** Screen-space pop (bond layer gain / bounty coins). `icon` = texture or null. */
  pop(icon, label, tint, i = 0) {
    const P = this.P;
    const size = this.ctx.screenSize();
    const top = this.ctx.fieldTop ? this.ctx.fieldTop() : size.height * 0.2;
    const c = new P.Container();
    const x = size.width / 2 + (i % 5 - 2) * 70;
    c.position.set(x, top);
    if (icon) {
      const glow = new P.Sprite(this.tex.glow);
      glow.anchor.set(0.5); glow.tint = tint; glow.blendMode = P.BLEND_MODES.ADD; glow.scale.set(0.9);
      const sp = new P.Sprite(icon);
      sp.anchor.set(0.5);
      sp.tint = tint;
      // 46 px along its longer side. A bond icon (app.js 'layer': PIXI.Texture.from(url)) is a 1×1 placeholder until
      // its image has loaded: sized from that it was drawn 46× too big, ~5000 px over the whole screen for the pop's
      // 1.4 s (user playtest #4 item 13) — so it is sized once its texture is valid, and hidden until then.
      const fit = () => {
        if (sp.destroyed) return;
        sp.scale.set(46 / Math.max(1, icon.width, icon.height));
        sp.visible = true;
      };
      if (icon.valid) fit();
      else { sp.visible = false; icon.once('update', fit); }
      c.addChild(glow, sp);
    }
    if (label) {
      const t = new P.BitmapText(label, { fontName: DMG_STYLE.heal.font, fontSize: 26 });
      t.anchor.set(0, 0.5);
      t.position.set(26, 0);
      if (tint === COLORS.gold) t.tint = 0xffe066;
      c.addChild(t);
    }
    this.ctx.layers.screen.addChild(c);
    this.pops.push({ c, t: 0, dur: 1.4, y0: top });
    if (this.pops.length > 12) { const o = this.pops.shift(); o.c.destroy({ children: true }); }
  }

  _updatePops(dt) {
    let w = 0;
    for (const p of this.pops) {
      p.t += dt;
      if (p.t >= p.dur) { p.c.destroy({ children: true }); continue; }
      const k = p.t / p.dur;
      p.c.position.y = p.y0 - 40 * easeOut(k);
      p.c.alpha = k < 0.15 ? k / 0.15 : k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
      const s = k < 0.15 ? 0.6 + (k / 0.15) * 0.5 : 1.1 - Math.min(0.1, (k - 0.15));
      p.c.scale.set(s);
      this.pops[w++] = p;
    }
    this.pops.length = w;
  }
}
