import { hourWeight, tempo, type Song } from './songs';

/**
 * The chorus engine: a handful of singers, each one scheduling its song a little ahead of the clock. Works on any
 * AudioContext, so the page plays it live and a test renders it offline and measures the result.
 *
 * Analogy: a band where every player reads the same thermometer for tempo and the Atlas for who showed up.
 */

export interface Singer {
  /** Atlas species index, for the roll. */
  sp: number;
  song: Song;
  /** 0-1: how in season it is here today. */
  density: number;
}

export interface Weather {
  /** Air temperature, °C. */
  c: number;
  /** Hour of the day, 0-24. */
  hour: number;
}

/** One sound made, for the roll to draw. */
export interface Note {
  sp: number;
  at: number;
  dur: number;
}

/** A small seeded random, so an offline render is repeatable. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

interface Voice {
  sp: number;
  song: Song;
  out: AudioNode;
  next: number;
  level: number;
  rand: () => number;
  /** Slight personal pitch and pace, so a field of the same species does not sing in unison. */
  pitch: number;
  pace: number;
}

export class Chorus {
  private voices: Voice[] = [];
  private bus: GainNode;
  private noise: AudioBuffer;
  private rand: () => number;
  readonly notes: Note[] = [];
  weather: Weather = { c: 22, hour: 22 };

  constructor(
    private readonly ctx: BaseAudioContext,
    dest: AudioNode = ctx.destination,
    seed = 7,
  ) {
    this.rand = rng(seed);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22;
    comp.ratio.value = 6;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(1.4);
    this.bus.connect(comp);
    this.bus.connect(verb);
    verb.connect(wet);
    wet.connect(comp);
    const makeup = ctx.createGain();
    makeup.gain.value = 3;
    comp.connect(makeup);
    makeup.connect(dest);
    // One second of white noise, looped by the sounds that need a rasp.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = this.rand() * 2 - 1;
  }

  private impulse(sec: number): AudioBuffer {
    const n = Math.floor(this.ctx.sampleRate * sec);
    const b = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (this.rand() * 2 - 1) * (1 - i / n) ** 3;
    }
    return b;
  }

  /** Replace the cast. Singers keep their place in the song when the cast does not change much. */
  setCast(cast: Singer[], from: number): void {
    const want: Voice[] = [];
    for (const s of cast) {
      const count = Math.max(1, Math.round(s.density * 3));
      for (let k = 0; k < count; k++) {
        const old = this.voices.find((v) => v.sp === s.sp && !want.includes(v));
        if (old) {
          want.push(old);
          continue;
        }
        const pan: AudioNode = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : this.ctx.createGain();
        if (pan instanceof StereoPannerNode) pan.pan.value = this.rand() * 1.6 - 0.8;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 5000 + this.rand() * 9000;
        const g = this.ctx.createGain();
        const far = 0.25 + this.rand() * 0.75;
        g.gain.value = 0.12 * far * (0.5 + 0.5 * s.density);
        g.connect(pan);
        pan.connect(lp);
        lp.connect(this.bus);
        want.push({
          sp: s.sp,
          song: s.song,
          out: g,
          next: from + this.rand() * 2,
          level: far,
          rand: rng(Math.floor(this.rand() * 1e9)),
          pitch: 0.97 + this.rand() * 0.06,
          pace: 0.9 + this.rand() * 0.2,
        });
      }
    }
    for (const v of this.voices) if (!want.includes(v)) v.out.disconnect();
    this.voices = want;
  }

  /** Schedule everything that starts before `until` (seconds on the context clock). */
  run(until: number): void {
    const { c, hour } = this.weather;
    for (const v of this.voices) {
      const on = hourWeight(v.song, hour) * (tempo(v.song, c) > 0 ? 1 : 0);
      let guard = 0;
      while (v.next < until && guard++ < 200) {
        if (on <= 0 || v.rand() > on) {
          v.next += 0.8 + v.rand() * 1.2;
          continue;
        }
        const k = tempo(v.song, c) * v.pace;
        const dur = this.sing(v, v.next, k);
        this.notes.push({ sp: v.sp, at: v.next, dur });
        v.next += dur + this.gap(v.song, k, v.rand);
      }
    }
    if (this.notes.length > 400) this.notes.splice(0, this.notes.length - 400);
  }

  /** Quiet between songs: short for a chirper (the rate is the gap), longer for a trill, drone or buzz. */
  private gap(s: Song, k: number, r: () => number): number {
    switch (s.shape) {
      case 'chirp':
      case 'rasp':
      case 'tick':
        return Math.max(0.05, 1 / (s.rate * k) - 0.15) * (0.8 + r() * 0.4);
      case 'trill':
        return 0.3 + r() * 2.2;
      case 'buzz':
        return 0.4 + r() * 4;
      case 'drone':
        return 1.5 + r() * 6;
    }
  }

  private osc(type: OscillatorType, hz: number, t: number, dur: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = hz;
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const n = this.ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    n.start(t, this.rand());
    n.stop(t + dur + 0.05);
    return n;
  }

  /** Play one song event at `t`; returns how long it lasts. */
  private sing(v: Voice, t: number, k: number): number {
    const s = v.song;
    const out = this.ctx.createGain();
    out.gain.value = 0;
    out.connect(v.out);
    const hz = s.hz * v.pitch;
    const A = out.gain;
    switch (s.shape) {
      case 'chirp':
      case 'tick': {
        // A short run of pulses: sine bursts for a cricket, sharper and quicker for a ticker.
        const period = (s.shape === 'chirp' ? 0.02 : 0.045) / (k * v.pace);
        const len = s.shape === 'chirp' ? period * 0.55 : 0.006;
        const dur = period * s.pulses;
        const o = this.osc('sine', hz, t, dur);
        o.connect(out);
        for (let i = 0; i < s.pulses; i++) {
          const a = t + i * period;
          A.setValueAtTime(0, a);
          A.linearRampToValueAtTime(1, a + len * 0.3);
          A.linearRampToValueAtTime(0, a + len);
        }
        return dur;
      }
      case 'rasp': {
        // "Katy-did": a few rough pulses, bright noise shaped around the pitch.
        const period = 0.11 / (k * v.pace);
        const dur = period * s.pulses;
        const n = this.noiseSrc(t, dur);
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = hz;
        bp.Q.value = 3;
        n.connect(bp);
        bp.connect(out);
        const o = this.osc('sawtooth', 140 * v.pitch, t, dur);
        o.connect(bp);
        for (let i = 0; i < s.pulses; i++) {
          const a = t + i * period;
          A.setValueAtTime(0, a);
          A.linearRampToValueAtTime(1.5, a + period * 0.15);
          A.linearRampToValueAtTime(0.2, a + period * 0.6);
          A.linearRampToValueAtTime(0, a + period * 0.8);
        }
        return dur;
      }
      case 'trill': {
        // A held tone chopped into pulses at the song's own rate.
        const dur = 1 + v.rand() * 3.5;
        const o = this.osc('sine', hz, t, dur);
        const am = this.ctx.createGain();
        am.gain.value = 0.5;
        const lfo = this.osc('sine', s.rate * k * v.pace, t, dur);
        const depth = this.ctx.createGain();
        depth.gain.value = 0.5;
        lfo.connect(depth);
        depth.connect(am.gain);
        o.connect(am);
        am.connect(out);
        A.setValueAtTime(0, t);
        A.linearRampToValueAtTime(1, t + 0.15);
        A.setValueAtTime(1, t + dur - 0.25);
        A.linearRampToValueAtTime(0, t + dur);
        return dur;
      }
      case 'buzz':
      case 'drone': {
        const drone = s.shape === 'drone';
        const dur = drone ? 6 + v.rand() * 9 : 1.5 + v.rand() * 5;
        const n = this.noiseSrc(t, dur);
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = hz;
        bp.Q.value = drone ? 2.5 : 4;
        const am = this.ctx.createGain();
        am.gain.value = 0.5;
        const lfo = this.osc('sawtooth', s.rate * k * v.pace, t, dur);
        const depth = this.ctx.createGain();
        depth.gain.value = 0.5;
        lfo.connect(depth);
        depth.connect(am.gain);
        n.connect(bp);
        bp.connect(am);
        am.connect(out);
        if (drone) {
          // A cicada swells up, holds, then fades, and its pitch leans a little with the swell.
          bp.frequency.setValueAtTime(hz * 0.93, t);
          bp.frequency.linearRampToValueAtTime(hz * 1.03, t + dur * 0.4);
          bp.frequency.linearRampToValueAtTime(hz * 0.97, t + dur);
          A.setValueAtTime(0, t);
          A.linearRampToValueAtTime(1, t + dur * 0.35);
          A.linearRampToValueAtTime(0.8, t + dur * 0.7);
          A.linearRampToValueAtTime(0, t + dur);
        } else {
          A.setValueAtTime(0, t);
          A.linearRampToValueAtTime(1, t + 0.1);
          A.setValueAtTime(1, t + dur - 0.15);
          A.linearRampToValueAtTime(0, t + dur);
        }
        return dur;
      }
    }
  }

  dispose(): void {
    for (const v of this.voices) v.out.disconnect();
    this.voices = [];
    this.bus.disconnect();
  }
}
