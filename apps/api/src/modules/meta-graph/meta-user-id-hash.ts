// Channel (MetaGraphModule, Gulf T7 / D7): the one way a Meta app-scoped
// user id (ASID) is turned into something we store.
//
// We only ever MATCH these ids — "which channels did this user connect",
// "has this user asked for deletion before" — so we keep a SHA-256 of them,
// never the id itself. Domain-separated so the same digits hashed for some
// other purpose never collide with this column.
//
// Honest about what this is: pseudonymisation, not anonymisation. ASIDs are
// ~15-17 decimal digits, so a determined attacker holding the table could
// brute-force one back. It keeps the plaintext id out of backups, logs and
// data exports, which is the realistic exposure; it is not a secret.
//
// Lives in MetaGraphModule (moved from meta-channel/ in Gulf T5) because two
// modules write it: SocialChannelCredentialsService (T4's handshake) and
// WhatsApp Embedded Signup (T5). Both already depend on MetaGraphModule, and
// WhatsappModule cannot import MetaChannelModule (that edge runs the other
// way). The privacy callbacks only read through those two writers.
import { createHash } from 'node:crypto';

const DOMAIN = 'meta-asid:v1:';

export function hashMetaUserId(appScopedUserId: string): string {
  return createHash('sha256')
    .update(DOMAIN + appScopedUserId)
    .digest('hex');
}
