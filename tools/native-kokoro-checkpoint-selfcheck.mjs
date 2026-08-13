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

// Exercise the reservation protocol independently of Dispatch/MLX. Source
// assertions below bind these transitions to the Swift implementation; this
// small clocked model catches the races the old late busy marker permitted.
function exerciseReservationProtocol() {
  let owner = null;
  let reportIdle = false;
  const events = [];

  const reserve = requestId => {
    if (owner) {
      reportIdle = true;
      events.push(`busy:${requestId}`);
      return false;
    }
    owner = { requestId };
    return true;
  };
  const cancel = () => {}; // Cancellation cannot interrupt an executing owner.
  const finish = requestId => {
    if (!owner || owner.requestId !== requestId) return false;
    owner = null;
    if (reportIdle) events.push(`idle:${requestId}`);
    reportIdle = false;
    events.push(`reply:${requestId}`);
    return true;
  };

  assert(reserve('fast'), 'fresh request was not admitted');
  assert(finish('fast'), 'fast owner did not release');
  assert(
    events.join(',') === 'reply:fast',
    'an uncontended request produced a spurious busy/idle event'
  );

  events.length = 0;
  assert(reserve('owner'), 'owner was not admitted');
  assert(!reserve('contender'), 'a concurrent contender was admitted');
  cancel('owner');
  assert(owner?.requestId === 'owner', 'JavaScript cancellation released the executing owner');
  assert(!finish('wrong-owner'), 'a non-owner released the reservation');
  assert(finish('owner'), 'the admitted owner did not release');
  assert(
    events.join(',') === 'busy:contender,idle:owner,reply:owner',
    'busy -> idle -> terminal reply ordering regressed'
  );
  assert(reserve('next'), 'terminal release did not admit the next chunk');
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
  const generate = functionBody(native, 'generate');
  const reservation = functionBody(native, 'reserveGeneration');
  const release = functionBody(native, 'releaseGenerationReservation');
  const publishActivity = functionBody(native, 'publishActivity');
  const cancel = functionBody(native, 'cancel');
  const generationSuccess = functionBody(native, 'replyGenerationSuccess');
  const generationFailure = functionBody(native, 'replyGenerationFailure');
  assert(
    /struct\s+GenerationReservation\s*\{[\s\S]*requestID:\s*String[\s\S]*admittedAt:\s*Date/.test(native),
    'native generation reservation lost its request-keyed health fields'
  );
  assert(
    generate.indexOf('reserveGeneration(requestID: requestID)') >= 0 &&
    generate.indexOf('reserveGeneration(requestID: requestID)') < generate.indexOf('queue.async'),
    'generation ownership is not reserved synchronously before queue dispatch'
  );
  assert(
    generate.includes('defer { self.releaseGenerationReservation(requestID: requestID) }'),
    'admitted generation lost its defensive owner release'
  );
  const afterAdmission = generate.slice(generate.indexOf('guard reserveGeneration'));
  assert(
    !afterAdmission.includes('self.replySuccess(') && !afterAdmission.includes('self.replyFailure('),
    'a generation terminal reply can bypass release-and-order helpers'
  );

  const reservationLock = reservation.indexOf('healthLock.lock()');
  const reservationCheck = reservation.indexOf('if let reservation = generationReservation');
  const reservationWrite = reservation.indexOf('generationReservation = GenerationReservation(');
  const reservationUnlock = reservation.lastIndexOf('healthLock.unlock()');
  assert(
    reservationLock >= 0 && reservationLock < reservationCheck &&
    reservationCheck < reservationWrite && reservationWrite < reservationUnlock,
    'reservation check/write is no longer one locked admission operation'
  );
  assert(
    reservation.includes('code: "native_busy"') &&
    reservation.indexOf('lifecycleEventQueue.async') < reservation.indexOf('healthLock.unlock()'),
    'concurrent rejection is not ordered ahead of the owner idle event'
  );
  assert(
    publishActivity.includes('generationReservation.map') &&
    publishActivity.includes('generationReservation != nil'),
    'lifecycle activity stopped reporting admission-time reservation health'
  );
  assert(
    release.includes('generationReservation?.requestID == requestID') &&
    release.indexOf('generationReservation = nil') < release.indexOf('lifecycleEventQueue.async'),
    'reservation release is not owner-checked before its ordered idle event'
  );
  assert(
    !cancel.includes('releaseGenerationReservation'),
    'JavaScript cancel can incorrectly release an executing MLX reservation'
  );
  for (const [name, terminal] of [
    ['success', generationSuccess],
    ['failure', generationFailure],
  ]) {
    const ownerRelease = terminal.indexOf('releaseGenerationReservation(requestID: requestID)');
    const serialReply = terminal.indexOf('lifecycleEventQueue.sync');
    const reply = terminal.indexOf(name === 'success' ? 'replySuccess(' : 'replyFailure(');
    assert(
      ownerRelease >= 0 && ownerRelease < serialReply && serialReply < reply,
      `generation ${name} no longer releases, delivers idle, then replies in serial order`
    );
  }
  assert(
    !native.includes('generationStartedAt') && !native.includes('markGenerationStarted'),
    'late MLX-only busy marker was reintroduced'
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

  exerciseReservationProtocol();
  assert(evaluations >= 12, `expected at least 12 forced evaluation boundaries, found ${evaluations}`);
  console.log(`native Kokoro checkpoint self-check: PASS (${evaluations} forced evaluations guarded)`);
} catch (error) {
  console.error(`native Kokoro checkpoint self-check: FAIL — ${error.message}`);
  process.exit(1);
}
