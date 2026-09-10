/* ==========================================================================
   The main-thread half of noise suppression.

   Two things live here:

   1. buildDenoiser() — wraps a raw microphone stream in a WebAudio graph and
      hands back a *new* stream whose audio track is the cleaned one. The graph
      is deliberately short: a high-pass to drop rumble and handling noise
      before the suppressor ever sees it, the suppressor itself (an
      AudioWorklet, see js/worklets/denoise-processor.js), a make-up gain, and
      a gentle limiter so a suddenly-loud talker doesn't clip on the way out.

   2. probeMic() — the same graph pointed at nothing but a meter, which is what
      Settings uses to show what your room actually sounds like right now. It
      reports a real dBFS figure, so "quiet"/"noisy" is a measurement rather
      than a vibe.

   Everything degrades honestly. If AudioWorklet is missing (old WebKit, some
   in-app browsers) buildDenoiser returns the untouched stream with
   supported:false, and the UI says the browser's own suppression is all
   there is — it does not pretend a slider is doing something.
   ========================================================================== */

const WORKLET_URL = '/js/worklets/denoise-processor.js';

export const denoiseSupported = () =>
  typeof AudioWorkletNode === 'function' &&
  typeof (window.AudioContext || window.webkitAudioContext) === 'function';

/* Constraints for getUserMedia. The browser's own suppression stays on unless
   the whole feature is off: it and ours are complementary — theirs is tuned
   for stationary hiss at the driver level, ours works on the spectrum and
   handles non-stationary noise (traffic, a room full of people) far better.
   voiceIsolation is only shipped by some Chromium builds; listing it in
   `advanced` means it is used where it exists and ignored where it doesn't,
   instead of failing the whole request. */
export function micConstraints(mode = 'auto') {
  const on = mode !== 'off';
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: on,
      autoGainControl: true,
      channelCount: 1,
      advanced: [{ voiceIsolation: on }, { googExperimentalNoiseSuppression: on }],
    },
  };
}

export const NOISE_LABELS = [
  [-46, 'quiet'], [-38, 'a little background'], [-30, 'noisy'], [-24, 'loud'], [Infinity, 'very loud'],
];
export const noiseWord = db => (NOISE_LABELS.find(([t]) => db < t) || NOISE_LABELS.at(-1))[1];

let ctxRef = null;
function audioContext() {
  if (ctxRef && ctxRef.state !== 'closed') return ctxRef;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  ctxRef = new Ctor({ latencyHint: 'interactive' });
  return ctxRef;
}

let workletReady = null;
async function ensureWorklet(ctx) {
  if (!workletReady) workletReady = ctx.audioWorklet.addModule(WORKLET_URL);
  await workletReady;
}

/* ── the live suppressor ──────────────────────────────────────────── */
/**
 * @param {MediaStream} raw  the stream straight out of getUserMedia
 * @returns {Promise<{stream, supported, setMode, setStrength, setMuted, stats, stop}>}
 */
export async function buildDenoiser(raw, { mode = 'auto', strength = 0.6, onStats } = {}) {
  const rawAudio = raw.getAudioTracks()[0] || null;
  const passthrough = () => ({
    stream: raw, supported: false, rawAudio,
    setMode() {}, setStrength() {}, setMuted(m) { if (rawAudio) rawAudio.enabled = !m; },
    reset() {}, stats: () => null, stop() {},
  });

  if (!rawAudio || mode === 'off' || !denoiseSupported()) return passthrough();

  let ctx;
  try {
    ctx = audioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    await ensureWorklet(ctx);
  } catch (e) {
    console.warn('denoise unavailable, passing the microphone through untouched', e);
    return passthrough();
  }

  try {
    const source = ctx.createMediaStreamSource(new MediaStream([rawAudio]));

    // 85 Hz, gentle. Below this there is nothing but desk thumps, wind and
    // mains hum — and anything the suppressor never sees, it cannot smear.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 85; hp.Q.value = 0.707;

    const node = new AudioWorkletNode(ctx, 'wisp-denoise', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    });

    const makeup = ctx.createGain();
    makeup.gain.value = 1.12;                  // the suppressor takes a little off

    // A limiter, not a compressor: high threshold, fast release. It only ever
    // acts on peaks, so quiet speech is untouched.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -6; limit.knee.value = 4;
    limit.ratio.value = 8; limit.attack.value = 0.003; limit.release.value = 0.12;

    const out = ctx.createMediaStreamDestination();
    source.connect(hp).connect(node).connect(makeup).connect(limit).connect(out);

    let last = null;
    node.port.onmessage = ({ data }) => { last = data; onStats?.(data); };
    node.port.postMessage({ type: 'set', mode, strength });

    const processed = out.stream.getAudioTracks()[0];
    const stream = new MediaStream([processed, ...raw.getVideoTracks()]);

    return {
      stream, supported: true, rawAudio, node,
      setMode: m => node.port.postMessage({ type: 'set', mode: m }),
      setStrength: v => node.port.postMessage({ type: 'set', strength: v }),
      // Belt and braces: disable the source track *and* close the make-up gain,
      // so nothing the worklet synthesises (comfort noise) can leak while muted.
      setMuted(m) {
        if (rawAudio) rawAudio.enabled = !m;
        makeup.gain.setTargetAtTime(m ? 0 : 1.12, ctx.currentTime, 0.01);
      },
      reset: () => node.port.postMessage({ type: 'reset' }),
      stats: () => last,
      stop() {
        try { node.port.onmessage = null; node.disconnect(); source.disconnect(); hp.disconnect(); } catch {}
        try { makeup.disconnect(); limit.disconnect(); } catch {}
        try { processed.stop(); } catch {}
      },
    };
  } catch (e) {
    console.warn('denoise graph failed, passing the microphone through untouched', e);
    return passthrough();
  }
}

/* ── the microphone test in Settings ─────────────────────────────────────
   Opens the mic, runs it through the same suppressor, and reports both the
   input level and what the suppressor is doing about it. Returns a stop().  */
export async function probeMic(onReading) {
  const raw = await navigator.mediaDevices.getUserMedia(micConstraints('auto'));
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume();

  const den = await buildDenoiser(raw, { mode: 'auto' });
  const an = ctx.createAnalyser();
  an.fftSize = 1024; an.smoothingTimeConstant = 0.6;
  ctx.createMediaStreamSource(new MediaStream([raw.getAudioTracks()[0]])).connect(an);
  const buf = new Float32Array(an.fftSize);

  let live = true;
  const tick = () => {
    if (!live) return;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = 10 * Math.log10(sum / buf.length + 1e-12);
    const s = den.stats();
    onReading({
      levelDb: Math.round(rms * 10) / 10,
      noiseDb: s?.noiseDb ?? null,
      reduceDb: s?.reduceDb ?? null,
      strength: s?.strength ?? null,
      speech: !!s?.speech,
      supported: den.supported,
    });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return () => {
    live = false;
    den.stop();
    raw.getTracks().forEach(t => t.stop());
  };
}
