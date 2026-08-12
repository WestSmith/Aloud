/* Guards the native Kokoro lifecycle checkpoint path. MLX is lazy, so a
 * foreground check only at generateAudio() entry is insufficient: every
 * item()/asArray() below can submit the next graph to Metal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ALOUD_ROOT
  || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function functionBody(source, name) {
  const start = source.indexOf(`func ${name}`);
  assert(start >= 0, `missing ${name}()`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}()`);
}

function assertEvaluationsCheckpointed(relative) {
  const lines = read(relative).split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('//') || !/\.(?:item|asArray)\s*\(/.test(line)) continue;
    count++;
    const lead = lines.slice(Math.max(0, i - 3), i).join('\n');
    assert(
      /try\s+checkpoint\s*\(\s*\)/.test(lead),
      `${relative}:${i + 1} evaluates MLX without an immediately preceding checkpoint`
    );
  }
  return count;
}

try {
  const native = read('ios/Aloud.swiftpm/NativeKokoroEngine.swift');
  const kokoro = read(
    'ios/Aloud.swiftpm/Vendor/KokoroSwift/Sources/KokoroSwift/TTSEngine/KokoroTTS.swift'
  );
  const misakiProcessor = read(
    'ios/Aloud.swiftpm/Vendor/KokoroSwift/Sources/KokoroSwift/TextProcessing/MisakiG2PProcessor.swift'
  );
  const generator = read(
    'ios/Aloud.swiftpm/Vendor/KokoroSwift/Sources/KokoroSwift/Decoder/Generator.swift'
  );

  assert(
    /checkpoint:\s*\(\)\s*throws\s*->\s*Void\s*=\s*\{\s*\}/.test(kokoro),
    'generateAudio checkpoint stopped being API-compatible by default'
  );
  assert(
    /checkpoint:\s*\{[\s\S]*isCancellationPending\(requestID\)[\s\S]*isAppActive/.test(native),
    'native generation no longer supplies cancellation and activity checks'
  );
  const pending = functionBody(native, 'isCancellationPending');
  assert(pending.includes('.contains(requestID)') && !pending.includes('.remove('),
         'evaluation checkpoint consumed the cancellation tombstone');
  assert(
    /catch\s+is\s+NativeKokoroGenerationCancelled[\s\S]*consumeCancellation\(requestID\)/.test(native),
    'cancelled generation no longer has one terminal tombstone consumer'
  );
  assert(
    /misaki\.phonemize\(text:\s*input,\s*checkpoint:\s*checkpoint\)/.test(misakiProcessor),
    'Misaki fallback no longer receives the native lifecycle checkpoint'
  );
  assert(
    !/\.(?:item|asArray)\s*\(/.test(generator),
    'Generator.init restored a preparation-time forced MLX evaluation'
  );

  const evaluations = [
    'ios/Aloud.swiftpm/Vendor/KokoroSwift/Sources/KokoroSwift/TTSEngine/KokoroTTS.swift',
    'ios/Aloud.swiftpm/Vendor/KokoroSwift/Sources/KokoroSwift/TTSEngine/TimestampPredictor.swift',
    'ios/Aloud.swiftpm/Vendor/MisakiSwift/Sources/MisakiSwift/English/FallbackNetwork/BARTModel.swift',
    'ios/Aloud.swiftpm/Vendor/MisakiSwift/Sources/MisakiSwift/English/FallbackNetwork/EnglishFallbackNetwork.swift',
  ].reduce((total, relative) => total + assertEvaluationsCheckpointed(relative), 0);

  assert(evaluations >= 12, `expected at least 12 forced evaluation boundaries, found ${evaluations}`);
  console.log(`native Kokoro checkpoint self-check: PASS (${evaluations} forced evaluations guarded)`);
} catch (error) {
  console.error(`native Kokoro checkpoint self-check: FAIL — ${error.message}`);
  process.exit(1);
}
