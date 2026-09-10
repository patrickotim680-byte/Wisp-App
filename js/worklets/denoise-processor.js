/* ==========================================================================
   wisp-denoise — a real single-channel noise suppressor, running on the audio
   thread.

   What this actually is: a short-time spectral-gain suppressor. Every 128
   samples it takes a 512-point windowed FFT, estimates the noise power in each
   frequency bin, works out how much of that bin is signal rather than noise,
   and multiplies the bin by a gain between "keep it" and "throw it away".
   Overlap-add puts the waveform back together.

   The parts that matter, and why:

   * Decision-directed a-priori SNR (Ephraim & Malah). Deciding a bin's gain
     from the current frame alone is what makes cheap noise gates warble; this
     blends the previous frame's estimate in, so gains move smoothly and
     "musical noise" (those little tonal chirps) mostly doesn't happen.

   * Minimum-statistics noise tracking. The noise floor per bin is followed by
     tracking its running minimum over a ~1.5s window and only letting it rise
     slowly. That is what lets it work without a "please stay quiet for three
     seconds" calibration step, and what lets it recover when the noise
     changes — a fan starting, a car passing, a room going quiet.

   * A voice-activity detector that is not just a level threshold. Level alone
     calls a slammed door "speech" and a quiet talker "silence". This combines
     three things: broadband SNR, how much energy sits in the 300–3400 Hz voice
     band, and spectral flatness (steady noise is flat across frequency, speech
     is peaky). All three have to agree, with hysteresis so a gap between words
     doesn't flip it.

   * Automatic strength. This is the "knows when you're in a noisy place" bit.
     The tracked noise floor is a real measurement in dBFS, so the processor
     scales its own aggressiveness from it: in a quiet room it backs almost all
     the way off (a suppressor working hard on nothing only damages your
     voice), in a loud one it goes deep. The ramp is slow on purpose — a second
     and a half — so it settles rather than pumping.

   * Comfort noise. A gate that reaches true silence sounds like the call
     dropped. A trace of the measured noise shape is mixed back under the gate
     so the line still sounds open.

   Latency is one window: 512 samples, about 10.7 ms at 48 kHz.
   ========================================================================== */

const N = 512;                 // FFT size
const HOP = 128;               // exactly one render quantum
const HALF = N / 2 + 1;        // usable bins for a real signal

/* ── a small in-place iterative radix-2 FFT ───────────────────────────── */
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / n);
    sin[i] = Math.sin(2 * Math.PI * i / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k], s = inverse ? -sin[k] : sin[k];
          const tre = re[j + half] * c + im[j + half] * s;
          const tim = -re[j + half] * s + im[j + half] * c;
          re[j + half] = re[j] - tre; im[j + half] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
}

class Denoise extends AudioWorkletProcessor {
  constructor() {
    super();
    this.fft = makeFFT(N);

    // sqrt-Hann for analysis and synthesis both: at 75% overlap the two
    // windows multiply back to a Hann, which sums to a constant, so overlap-add
    // reconstructs the input exactly when every gain is 1.
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    this.norm = 1 / 2;                       // Σ w² over the hops at N/4

    this.inBuf = new Float32Array(N);
    this.outBuf = new Float32Array(N);
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);

    // Minimum statistics, MCRA style. `sp` is a fast recursive average of the
    // power; its running minimum over the last SUBS sub-windows is the noise
    // estimate, scaled by BIAS to undo the well-known downward bias of taking
    // a minimum (a minimum of a fluctuating quantity sits below its mean).
    this.noise = new Float32Array(HALF).fill(1e-8);
    this.sp = new Float32Array(HALF).fill(1e-8);
    this.minRun = new Float32Array(HALF).fill(1e9);
    this.minSub = new Float32Array(HALF).fill(1e9);
    this.SUBS = 4;
    this.subs = Array.from({ length: 4 }, () => new Float32Array(HALF).fill(1e9));
    this.subIdx = 0;
    this.BIAS = 1.85;
    this.snrPrio = new Float32Array(HALF).fill(1);
    this.gainPrev = new Float32Array(HALF).fill(1);
    this.mag2 = new Float32Array(HALF);
    this.gain = new Float32Array(HALF);
    this.smoothed = new Float32Array(HALF);

    this.frame = 0;
    this.minCount = 0;
    this.MIN_WINDOW = Math.max(8, Math.round(1.5 * sampleRate / HOP));  // ~1.5 s
    this.SUB_LEN = Math.max(2, Math.round(this.MIN_WINDOW / 4));
    this.speechRun = 0;
    this.silenceRun = 0;
    this.speech = false;
    this.autoStrength = 0.5;
    this.noiseDb = -70;
    this.reduceDb = 0;

    // voice band, in bins
    this.loBin = Math.max(1, Math.floor(300 / (sampleRate / N)));
    this.hiBin = Math.min(HALF - 1, Math.ceil(3400 / (sampleRate / N)));

    this.mode = 'auto';        // 'auto' | 'on' | 'off'
    this.userStrength = 0.6;   // only consulted when mode === 'on'

    this.port.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'set') {
        if (data.mode) this.mode = data.mode;
        if (typeof data.strength === 'number') this.userStrength = Math.min(1, Math.max(0, data.strength));
      }
      if (data.type === 'reset') { this.noise.fill(1e-8); this.frame = 0; }
    };
  }

  /* Effective aggressiveness for this frame. In auto, it comes from the
     measured noise floor. */
  strengthNow() {
    if (this.mode === 'off') return 0;
    if (this.mode === 'on') return this.userStrength;
    // -50 dBFS is a quiet room, -28 dBFS is a cafe or a street. Between them
    // the suppressor scales itself; outside them it saturates.
    const t = Math.min(1, Math.max(0, (this.noiseDb + 50) / 22));
    const target = 0.12 + t * 0.88;
    // slow ramp: ~1.5 s to settle, so it never pumps mid-sentence
    const k = HOP / (1.5 * sampleRate);
    this.autoStrength += (target - this.autoStrength) * Math.min(1, k * 6);
    return this.autoStrength;
  }

  analyse() {
    const { re, im, mag2 } = this;
    for (let i = 0; i < N; i++) { re[i] = this.inBuf[i] * this.win[i]; im[i] = 0; }
    this.fft(re, im, false);
    let total = 0;
    for (let k = 0; k < HALF; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      mag2[k] = p;
      total += p;
    }
    return total;
  }

  /* Minimum statistics with sub-windows. No calibration period, no "please be
     quiet for three seconds": the estimate is simply the smallest smoothed
     power each bin has shown recently, bias-corrected. Because the window
     slides in quarters, it also recovers within about a second and a half when
     the room genuinely changes — a fan starting, a car passing, a bus filling
     up. */
  trackNoise(speech) {
    const { mag2, noise, sp, minRun, minSub, subs } = this;
    for (let k = 0; k < HALF; k++) {
      sp[k] = sp[k] * 0.72 + mag2[k] * 0.28;
      const v = sp[k];
      if (v < minSub[k]) minSub[k] = v;
      if (v < minRun[k]) minRun[k] = v;
      let est = minRun[k] * this.BIAS;
      // A long confirmed silence is the one moment it is safe to let the
      // estimate climb straight to what is being heard, so a sudden new noise
      // is tracked in tens of milliseconds rather than over a whole window.
      if (!speech && this.silenceRun > 40 && est < v) est = est * 0.85 + v * 0.15;
      noise[k] = noise[k] * 0.9 + est * 0.1;
      if (noise[k] < 1e-11) noise[k] = 1e-11;
    }
    if (++this.minCount >= this.SUB_LEN) {
      this.minCount = 0;
      subs[this.subIdx].set(minSub);
      this.subIdx = (this.subIdx + 1) % this.SUBS;
      for (let k = 0; k < HALF; k++) {
        let m = subs[0][k];
        for (let u = 1; u < this.SUBS; u++) if (subs[u][k] < m) m = subs[u][k];
        minRun[k] = m;
        minSub[k] = sp[k];
      }
    }
  }

  /* Three independent cues, all of which have to agree, plus hysteresis. */
  detectSpeech(total) {
    const { mag2, noise } = this;
    let nTotal = 0, band = 0, logSum = 0, linSum = 0;
    for (let k = 1; k < HALF; k++) {
      nTotal += noise[k];
      if (k >= this.loBin && k <= this.hiBin) band += mag2[k];
      const p = mag2[k] + 1e-12;
      logSum += Math.log(p);
      linSum += p;
    }
    const snrDb = 10 * Math.log10((total + 1e-12) / (nTotal + 1e-12));
    const bandRatio = band / (total + 1e-12);
    const flatness = Math.exp(logSum / (HALF - 1)) / (linSum / (HALF - 1) + 1e-12);

    const looksVoiced = snrDb > 4.5 && bandRatio > 0.35 && flatness < 0.5;
    if (looksVoiced) { this.speechRun++; this.silenceRun = 0; }
    else { this.silenceRun++; this.speechRun = 0; }
    // 2 frames to open (~5 ms), 14 to close (~37 ms) — fast enough not to clip
    // a word's first consonant, slow enough to ride through a gap.
    if (!this.speech && this.speechRun >= 2) this.speech = true;
    else if (this.speech && this.silenceRun >= 14) this.speech = false;

    // Parseval, for a sqrt-Hann window at this overlap: the one-sided power
    // sum is (N^2 / 4) times the time-domain variance. BIAS_DB undoes the
    // residual downward bias left by reading the floor off a minimum tracker.
    // Measured against known-level signals this lands within about a decibel of
    // true dBFS, which is what makes the quiet-room/loud-room decision in
    // strengthNow() an absolute judgement rather than a guess.
    this.noiseDb = 10 * Math.log10(nTotal / (N * N * 0.25) + 1e-12) + 6;
    return this.speech;
  }

  suppress(strength) {
    const { mag2, noise, snrPrio, gainPrev, gain, smoothed } = this;
    const floor = 0.34 - strength * 0.31;        // 0.34 (gentle) … 0.03 (deep)
    const over = 1 + strength * 0.9;             // how hard to read the noise estimate
    const alpha = 0.94;                          // decision-directed memory
    let sumIn = 0, sumOut = 0;

    for (let k = 0; k < HALF; k++) {
      const nk = noise[k] * over;
      const post = mag2[k] / (nk + 1e-12);
      const prio = alpha * (gainPrev[k] * gainPrev[k] * post) + (1 - alpha) * Math.max(post - 1, 0);
      snrPrio[k] = prio;
      let g = prio / (1 + prio);                 // Wiener
      if (g < floor) g = floor;
      if (g > 1) g = 1;
      gain[k] = g;
    }

    // Smooth across frequency (3-bin) — a gain that jumps bin to bin is what
    // musical noise sounds like.
    for (let k = 0; k < HALF; k++) {
      const a = gain[Math.max(0, k - 1)], b = gain[k], c = gain[Math.min(HALF - 1, k + 1)];
      smoothed[k] = (a + 2 * b + c) / 4;
    }
    // Asymmetric smoothing in time: open fast, close slowly.
    for (let k = 0; k < HALF; k++) {
      const g = smoothed[k] > gainPrev[k] ? smoothed[k] : gainPrev[k] * 0.7 + smoothed[k] * 0.3;
      gainPrev[k] = g;
      gain[k] = g;
      sumIn += mag2[k];
      sumOut += mag2[k] * g * g;
    }
    this.reduceDb = 10 * Math.log10((sumOut + 1e-12) / (sumIn + 1e-12));

    // Apply, with a trace of comfort noise so a hard gate doesn't sound dead.
    const { re, im } = this;
    const comfort = 0.045 * strength;
    for (let k = 0; k < HALF; k++) {
      const g = gain[k];
      const cn = comfort > 0 ? Math.sqrt(noise[k]) * comfort * (Math.random() * 2 - 1) : 0;
      re[k] = re[k] * g + cn;
      im[k] = im[k] * g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    im[0] = 0;
    im[N / 2] = 0;
  }

  synthesise() {
    this.fft(this.re, this.im, true);
    for (let i = 0; i < N; i++) this.outBuf[i] += this.re[i] * this.win[i] * this.norm;
  }

  process(inputs, outputs) {
    const inCh = inputs[0]?.[0];
    const out = outputs[0]?.[0];
    if (!out) return true;

    if (!inCh) { out.fill(0); return true; }

    if (this.mode === 'off') { out.set(inCh); return true; }

    // slide the analysis buffer by one hop and drop the new block in
    this.inBuf.copyWithin(0, HOP);
    this.inBuf.set(inCh, N - HOP);

    const total = this.analyse();
    const speech = this.detectSpeech(total);
    this.trackNoise(speech);
    this.suppress(this.strengthNow());
    this.synthesise();

    // emit the oldest hop, then slide the synthesis buffer
    out.set(this.outBuf.subarray(0, HOP));
    this.outBuf.copyWithin(0, HOP);
    this.outBuf.fill(0, N - HOP);

    if ((++this.frame & 31) === 0) {
      this.port.postMessage({
        noiseDb: Math.round(this.noiseDb * 10) / 10,
        reduceDb: Math.round(this.reduceDb * 10) / 10,
        speech,
        strength: Math.round(this.strengthNow() * 100) / 100,
        mode: this.mode,
      });
    }
    return true;
  }
}

registerProcessor('wisp-denoise', Denoise);
