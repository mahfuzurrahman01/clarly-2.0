import { cn } from "@/lib/utils";
import { StarField } from "@/components/marketing/landing/star-field";
import s from "./aura.module.css";

type GlowPlacement = "top" | "end" | "start" | "center";

const GLOW_CLASS: Record<GlowPlacement, string> = {
  top: s.glowTop,
  end: s.glowEnd,
  start: s.glowStart,
  center: s.glowCenter,
};

/**
 * The landing page's sky behind any public page: the star-dot field drawn in
 * the theme's foreground, plus slow-drifting lime glows. Place it as the first
 * child of an `AuraSurface`; it sits behind the content (z-index -1).
 */
export function AuraSky({ glows = ["top", "end"], className }: { glows?: GlowPlacement[]; className?: string }) {
  return (
    <div className={cn(s.sky, className)} aria-hidden>
      <StarField className={s.stars} colorVar="--foreground" />
      {glows.map((g) => (
        <div key={g} className={cn(s.glow, GLOW_CLASS[g])} />
      ))}
    </div>
  );
}
