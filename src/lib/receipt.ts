// Every punch gets a short receipt code the staff member sees on screen
// ("Punch saved, receipt 7KQ2-M9XD"). The same code is computed on the device
// and on the server, so an offline punch has its receipt before it syncs, and
// a disputed punch can be looked up by the code the employee wrote down.
// This is a reference number, not a security signature.

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O or 1/I

function fnv1a(input: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function receiptCode(p: { id: string; staffId: string; type: string; clientTime: string }): string {
  const input = `${p.id}|${p.staffId}|${p.type}|${p.clientTime}`;
  const a = fnv1a(input, 0x811c9dc5);
  const b = fnv1a(input, 0x9e3779b9);
  let out = "";
  for (let i = 0; i < 4; i++) out += ALPHABET[(a >>> (i * 5)) & 31];
  out += "-";
  for (let i = 0; i < 4; i++) out += ALPHABET[(b >>> (i * 5)) & 31];
  return out;
}
