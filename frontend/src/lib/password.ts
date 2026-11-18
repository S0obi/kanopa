// A password Kanopa makes for the person: 20 characters, at least one of each kind, from an alphabet
// without look-alikes (0 O 1 l I) and without the characters that are awkward to type or paste
// (quotes, backslash, backtick, space, and the dead keys ^ ~ ¨ on Swiss and French keyboards).
// 67 characters: about 121 bits. Made here with crypto.getRandomValues; the server is not asked.

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!#%*+-=?@_";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

export const PASSWORD_LENGTH = 20;
export const PASSWORD_ALPHABET = ALL;

/** An index below n without modulo bias: bytes past the last full multiple of n are thrown away. */
function randomIndex(n: number): number {
  const limit = 256 - (256 % n);
  const byte = new Uint8Array(1);
  do crypto.getRandomValues(byte);
  while (byte[0]! >= limit);
  return byte[0]! % n;
}

/** One of each kind first, the rest from the whole alphabet, then a Fisher–Yates shuffle. */
export function generatePassword(): string {
  const chars = [UPPER, LOWER, DIGIT, SYMBOL].map((set) => set[randomIndex(set.length)]!);
  while (chars.length < PASSWORD_LENGTH) chars.push(ALL[randomIndex(ALL.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
