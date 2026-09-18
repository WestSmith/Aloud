#!/usr/bin/env node
/* kokoro-wasm-bench — measure a Kokoro ONNX tier on the SAME onnxruntime-web
   build kokoro-js 1.2.1 pulls into the browser, on the wasm backend.

   This is the path a GitHub Pages deploy gets on iPhone/iPad Safari (and on
   any desktop without WebGPU): no threads unless the page is cross-origin
   isolated, so THREADS=1 is the production baseline. It answers two
   questions the model card cannot: how much process memory a tier holds
   after generating a sentence, and how much slower than real time it runs.
   Absolute times depend on the CPU; the RATIOS between tiers and thread
   counts are what carry over to a phone.

   Setup (run from tools/kokoro-wasm-bench/, kept out of git):
     mkdir -p kokoro-wasm-bench && cd kokoro-wasm-bench && npm init -y
     npm i onnxruntime-web@1.22.0-dev.20250409-89f8206ba4
     R=https://huggingface.co/shawnahmed/Kokoro-82M-v1.0-ONNX-timestamped/resolve/main
     mkdir -p onnx
     curl -sSL -o onnx/model_quantized.onnx $R/onnx/model_quantized.onnx    # q8
     curl -sSL -o onnx/model_q4.onnx        $R/onnx/model_q4.onnx
     curl -sSL -o tokenizer.json            $R/tokenizer.json
     curl -sSL -o am_puck.bin https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_puck.bin
     apt-get install -y espeak-ng          # optional: realistic phoneme ids

   Run (from that directory):
     node ../kokoro-wasm-bench.mjs model_quantized
     node ../kokoro-wasm-bench.mjs model_q4
     THREADS=4 node ../kokoro-wasm-bench.mjs model_quantized

   Measured 2026-09-18 on a 2.8GHz Xeon vCPU, 115 ids (~6.7s of audio):
     q8  1 thread: session 468MB → 680MB after a run,  RTF 3.5
     q4  1 thread: session 1123MB → 1272MB after a run, RTF 3.8
     q8  4 threads:                                     RTF 2.0
   q4 is the heavier tier by ~600MB and no faster — the reason phones/iPads
   now default to q8 (see kokoroConfig in index.html). */
import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

ort.env.wasm.numThreads = +(process.env.THREADS || 1);
ort.env.wasm.proxy = false;
const which = process.argv[2] || 'model_quantized';
const text = process.argv[3] || 'The current version plays on my phone, but every time there is a pause in the playback, the pause is extremely long.';

const vocab = JSON.parse(fs.readFileSync('tokenizer.json', 'utf8')).model.vocab;
let ph = text;
try { ph = execSync(`espeak-ng -q --ipa=3 -v en-us "${text.replace(/"/g, '')}"`).toString().trim().replace(/_/g, ''); }
catch { console.warn('espeak-ng not found; using letters as a stand-in for phonemes'); }
const ids = [0];
for (const ch of ph) if (vocab[ch] != null) ids.push(vocab[ch]);
ids.push(0);
const styleAll = new Float32Array(fs.readFileSync('am_puck.bin').buffer.slice(0));
const off = Math.min(Math.max(ids.length - 2, 0), 509) * 256;
const mem = () => { const m = process.memoryUsage(); return `rss=${(m.rss / 1048576) | 0}MB arrayBuffers=${(m.arrayBuffers / 1048576) | 0}MB`; };

console.log(`${which}: ${ids.length} ids, ${ort.env.wasm.numThreads} thread(s), before: ${mem()}`);
let t0 = performance.now();
const sess = await ort.InferenceSession.create(fs.readFileSync(`onnx/${which}.onnx`), { executionProviders: ['wasm'] });
console.log(`session create ${(performance.now() - t0) | 0} ms, ${mem()}`);
const feeds = {
  input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
  style: new ort.Tensor('float32', styleAll.slice(off, off + 256), [1, 256]),
  speed: new ort.Tensor('float32', [1], [1]),
};
for (let i = 0; i < 3; i++) {
  t0 = performance.now();
  const out = await sess.run(feeds);
  const dt = (performance.now() - t0) / 1000, audio = out.waveform.data.length / 24000;
  console.log(`run ${i}: ${dt.toFixed(2)}s for ${audio.toFixed(2)}s of audio → RTF ${(dt / audio).toFixed(2)}, ${mem()}`);
}
