/* Guards the native Kokoro weighted-convolution bias against retaining a new
 * lazy MLX reshape node after every inference. This source-level check is kept
 * deliberately narrow because KokoroSwift is vendored without a test target.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.ALOUD_ROOT
  || path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SOURCE = path.join(
  ROOT,
  'ios/Aloud.swiftpm/Vendor/KokoroSwift/Sources/KokoroSwift/BuildingBlocks/ConvWeighted.swift'
);
const source = fs.readFileSync(SOURCE, 'utf8');

const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const retainedAssignment = /\bbias\s*=\s*bias\?\.reshaped\s*\(/g;
const storedBiasAssignments = code.match(/\b(?:self\.)?bias\s*=/g) || [];
const expectedInitializer = code.match(/\bself\.bias\s*=\s*bias\b/g) || [];
const localViews = code.match(/\blet\s+reshapedBias\s*=\s*bias\?\.reshaped\s*\(\s*\[1,\s*1,\s*-1\]\s*\)/g) || [];
const localUses = code.match(/\bif\s+let\s+reshapedBias\s*\{/g) || [];

if (retainedAssignment.test(source)) {
  console.error('native Kokoro memory self-check: stored bias is reassigned to a lazy reshape');
  process.exit(1);
}
if (storedBiasAssignments.length !== 1 || expectedInitializer.length !== 1) {
  console.error(
    'native Kokoro memory self-check: stored bias is mutated outside initialization ' +
    `(assignments=${storedBiasAssignments.length})`
  );
  process.exit(1);
}
if (localViews.length !== 2 || localUses.length !== 2) {
  console.error(
    'native Kokoro memory self-check: expected both ConvWeighted overloads to use a local reshaped bias ' +
    `(views=${localViews.length}, uses=${localUses.length})`
  );
  process.exit(1);
}

console.log('native Kokoro memory self-check: PASS (stored bias remains graph-stable)');
