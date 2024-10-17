import { Buffer } from 'node:buffer';

const CP437 = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';
const REVERSE_CP437 = {};
for (let i = 0; i <= 0xff; ++i) {
  REVERSE_CP437[CP437.charCodeAt(i)] = i;
}

export function encodeCP437(string) {
  const length = string.length;
  const result = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; ++i) {
    const b = REVERSE_CP437[string.charCodeAt(i)];
    if (b === undefined) {
      throw new Error(`character not encodable in CP437: ${JSON.stringify(string[i])}`);
    }
    result[i] = b;
  }
  return result;
}
