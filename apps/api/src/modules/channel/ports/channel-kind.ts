// Channel (ChannelModule, Feature 16): the closed set of channels a
// conversation can arrive on.
//
// In its own file, with no imports, on purpose: `persistence/drizzle/
// *.table.ts` needs this type for the `channel` column and must not reach
// into a port file that (transitively) pulls in adapters — the platform
// layer depending on a channel binding is exactly the kind of edge
// AI_PIPELINE_PLAN.md's module-boundary rules exist to prevent.
export const CHANNELS = ['whatsapp', 'messenger', 'instagram', 'web'] as const;
export type ChannelKind = (typeof CHANNELS)[number];

/** The channel every row written before Feature 16 arrived on. Used as the column default so no backfill is guessed. */
export const DEFAULT_CHANNEL: ChannelKind = 'whatsapp';

export function isChannelKind(value: unknown): value is ChannelKind {
  return (
    typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
  );
}
