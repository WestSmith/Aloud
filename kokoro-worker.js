/* Aloud Kokoro worker
   Kept as a same-origin module because iOS WKWebView can silently stall blob
   module workers before they ever report an error. */

let tts = null;
let ts = { idChar: null, cap: null };

function stage(name, message, id) {
  self.postMessage({ type: 'stage', stage: name, message, id });
}

function kokoroSpokenWords(idChar, ids, dur, audioLen, sr) {
  if (!idChar || !ids || !dur || ids.length !== dur.length || ids.length < 3) return null;
  let total = 0;
  for (let k = 0; k < dur.length; k++) total += dur[k];
  if (!(total > 0) || !(audioLen > 0)) return null;
  const spf = audioLen / total;
  const words = [];
  let acc = dur[0] || 0;
  let cur = null;
  for (let k = 1; k < ids.length - 1; k++) {
    const ch = idChar[ids[k]];
    if (ch === ' ' || ch == null) cur = null;
    else {
      if (!cur) { cur = { t: (acc * spf) / sr, ph: '' }; words.push(cur); }
      cur.ph += ch;
    }
    acc += dur[k];
  }
  return words.length ? words : null;
}

function instrumentKokoroTTS(engine) {
  const state = { idChar: null, cap: null };
  try {
    const inner = engine.model;
    engine.model = async (inputs) => {
      const out = await inner(inputs);
      state.cap = (out.pred_dur && inputs.input_ids)
        ? { ids: Array.from(inputs.input_ids.data, Number), dur: Array.from(out.pred_dur.data, Number) }
        : null;
      return out;
    };
    const vocab = engine.tokenizer && engine.tokenizer.model && engine.tokenizer.model.vocab;
    if (Array.isArray(vocab)) state.idChar = vocab;
    else if (vocab instanceof Map) {
      state.idChar = [];
      vocab.forEach((id, ch) => { state.idChar[id] = ch; });
    } else if (vocab && typeof vocab === 'object') {
      state.idChar = [];
      for (const ch of Object.keys(vocab)) state.idChar[vocab[ch]] = ch;
    }
    if (state.idChar && state.idChar.indexOf(' ') < 0) state.idChar = null;
  } catch {}
  return state;
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      stage('module', 'Loading the Kokoro engine code…');
      const module = await import('https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm');
      const KokoroTTS = module.KokoroTTS || (module.default && module.default.KokoroTTS);
      if (!KokoroTTS) throw new Error('kokoro-js loaded without KokoroTTS');

      stage('model', `Opening the ${message.dtype} voice model…`);
      const options = {
        dtype: message.dtype,
        device: message.device,
        progress_callback: (progress) => {
          if (progress.status === 'progress' && progress.total) {
            self.postMessage({
              type: 'progress',
              loaded: progress.loaded,
              total: progress.total,
            });
          }
        },
      };

      try {
        tts = await KokoroTTS.from_pretrained(message.model, options);
      } catch (primaryError) {
        if (!message.fallbackModel) throw primaryError;
        stage('fallback', 'The timed model was unavailable; opening the standard Kokoro model…');
        tts = await KokoroTTS.from_pretrained(message.fallbackModel, options);
      }

      stage('session', 'Finishing the on-device speech engine…');
      ts = instrumentKokoroTTS(tts);
      self.postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'generate') {
      if (!tts) throw new Error('the Kokoro model is not ready');
      stage('generate', 'Creating Kokoro speech…', message.id);
      ts.cap = null;
      const raw = await tts.generate(message.text, { voice: message.voice, speed: 1 });
      const pwords = ts.cap
        ? kokoroSpokenWords(ts.idChar, ts.cap.ids, ts.cap.dur, raw.audio.length, raw.sampling_rate)
        : null;
      const nIds = ts.cap ? ts.cap.ids.length : 0;
      self.postMessage(
        { type: 'result', id: message.id, audio: raw.audio, sr: raw.sampling_rate, pwords, nIds },
        [raw.audio.buffer],
      );
    }
  } catch (error) {
    self.postMessage({
      type: message.type === 'init' ? 'initerror' : 'error',
      id: message.id,
      message: String((error && error.message) || error),
    });
  }
};
