import s from "@/components/marketing/aura/aura.module.css";
import { cn } from "@/lib/utils";

export function AuthHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className="mb-9 space-y-3">
      <h1 className={cn(s.title, s.titleAuth)}>{title}</h1>
      {subtitle ? (
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      ) : null}
    </div>
  );
}
