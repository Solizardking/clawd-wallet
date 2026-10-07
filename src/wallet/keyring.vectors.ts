// Verifies our keyring reproduces the exact addresses from the referenced
// Solana extension's own test vectors
// (browser-extension/src/background/__tests__/wallet-derivation.test.ts).
// Run with: npm run test:keyring
import { mnemonicToSeedHex, deriveAccount } from "./keyring.js";

const MNEMONIC_001 =
  "iron language purpose cargo access peanut insane pencil still burst sing nurse";
const EXPECTED_SEED =
  "55830e41db976a04df5775aeebf7751b3f599bec8f9d56568092b467aa64dad5698c828878ea5cdf84c10259bbe58f380ffddc94c5a1d868f55405429ea27c52";
const EXPECTED_ADDRESSES = [
  "FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu",
  "59dqcH5gJr6M2R5hFtmmXUfNmgGJWfQh8Gx33fnAReKo",
  "EUprufj4shLXPRmdcwqD9WVSuqzKk3TcZhbfEGKWB6Q8",
];

let failures = 0;
function check(label: string, actual: string, expected: string) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}\n  actual:   ${actual}\n  expected: ${expected}`);
}

const seed = mnemonicToSeedHex(MNEMONIC_001);
check("seed(hex)", seed, EXPECTED_SEED);
EXPECTED_ADDRESSES.forEach((expected, i) => {
  check(`account[${i}] address`, deriveAccount(seed, i).address, expected);
});

if (failures > 0) {
  console.error(`\n${failures} vector(s) FAILED`);
  process.exit(1);
}
console.log("\nAll derivation vectors match the reference extension.");
