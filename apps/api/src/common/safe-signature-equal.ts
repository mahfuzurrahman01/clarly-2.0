// Shared webhook-signature comparison.
//
// Lived in `modules/store/ports/store-provider.port.ts` until F26 needed it
// too. F26's D2 requires it to move somewhere shared rather than have
// `courier/` import `store/`: the two modules are peers and a courier adapter
// must not depend on the store integration. `store-provider.port.ts` re-exports
// it from here so every existing importer keeps working unchanged.
import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time signature comparison that is also length-safe.
 * `crypto.timingSafeEqual` THROWS on length mismatch, so calling it directly
 * on an attacker-controlled buffer turns a forged short signature into a 500
 * instead of a clean rejection.
 */
export function safeSignatureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
