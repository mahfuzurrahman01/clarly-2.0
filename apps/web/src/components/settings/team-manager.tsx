"use client";

import { useState } from "react";
import { Loader2, Mail, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import {
  type AppRole,
  type TeamMemberRecord,
  changeTeamRole,
  inviteTeamMember,
  removeTeamMember,
} from "@/lib/api/team";
import { ApiError } from "@/lib/api/client";
import { apiErrorMessage } from "@/lib/api/error-message";
import { useTranslations } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function TeamManager({
  initial,
  currentUserId,
}: {
  initial: TeamMemberRecord[];
  currentUserId: string;
}) {
  const t = useTranslations();
  const [members, setMembers] = useState<TeamMemberRecord[]>(initial);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AppRole>("agent");
  const [inviting, setInviting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  function roleLabel(role: AppRole): string {
    return role === "admin" ? t.team.roleAdmin : t.team.roleAgent;
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || inviting) return;
    setInviting(true);
    try {
      const result = await inviteTeamMember(trimmed, inviteRole);
      setMembers((prev) => [
        ...prev.filter((m) => m.userId !== result.userId),
        { userId: result.userId, email: result.email, appRole: result.appRole },
      ]);
      setEmail("");
      toast.success(
        result.invited
          ? t.team.inviteSentTemplate.replace("{email}", result.email)
          : t.team.inviteRecordedTemplate.replace("{email}", result.email),
      );
    } catch (err) {
      toast.error(apiErrorMessage(err, t, t.team.couldNotInvite));
    } finally {
      setInviting(false);
    }
  }

  async function changeRole(member: TeamMemberRecord, role: AppRole) {
    if (member.userId === currentUserId || role === member.appRole) return;
    setBusyId(member.userId);
    try {
      const updated = await changeTeamRole(member.userId, role);
      setMembers((prev) =>
        prev.map((m) => (m.userId === updated.userId ? updated : m)),
      );
      toast.success(
        t.team.roleChangedTemplate
          .replace("{email}", updated.email)
          .replace("{role}", updated.appRole === "admin" ? t.team.roleAdmin : t.team.roleAgent),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t.team.lastAdminError
          : err instanceof Error
            ? err.message
            : t.team.couldNotChangeRole,
      );
    } finally {
      setBusyId(null);
    }
  }

  async function remove(member: TeamMemberRecord) {
    if (member.userId === currentUserId) return;
    if (!confirm(t.team.removeConfirmTemplate.replace("{email}", member.email))) {
      return;
    }
    setBusyId(member.userId);
    try {
      const result = await removeTeamMember(member.userId);
      setMembers((prev) => prev.filter((m) => m.userId !== member.userId));
      toast.success(
        t.team.removedTemplate.replace("{email}", member.email) +
          (result.releasedTickets > 0
            ? t.team.removeTicketsNoteTemplate.replace(
                "{count}",
                String(result.releasedTickets),
              )
            : ""),
      );
    } catch (err) {
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t.team.lastAdminError
          : err instanceof Error
            ? err.message
            : t.team.couldNotRemove,
      );
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-8">
      {/* Invite */}
      <section className="rounded-xl border border-border bg-card/60 p-6 backdrop-blur-md">
        <h2 className="font-display text-lg font-medium tracking-tight">
          {t.team.inviteTitle}
        </h2>
        <form onSubmit={invite} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <label className="text-sm font-medium" htmlFor="invite-email">
              {t.team.emailLabel}
            </label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t.team.emailPlaceholder}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t.team.roleLabel}</label>
            <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as AppRole)}>
              <SelectTrigger className="w-32">
                <SelectValue>{() => roleLabel(inviteRole)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">{t.team.roleAgent}</SelectItem>
                <SelectItem value="admin">{t.team.roleAdmin}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button type="submit" disabled={inviting || !email.trim()}>
            {inviting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <UserPlus className="size-4" />
            )}
            {t.team.inviteButton}
          </Button>
        </form>
      </section>

      {/* Roster */}
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.team.noMembers}</p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {members.map((member) => {
            const isSelf = member.userId === currentUserId;
            const busy = busyId === member.userId;
            return (
              <li
                key={member.userId}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <Mail className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {member.email}
                    {isSelf ? (
                      <span className="ms-2 text-xs font-normal text-muted-foreground">
                        ({t.team.you})
                      </span>
                    ) : null}
                  </p>
                </div>
                <Select
                  value={member.appRole}
                  onValueChange={(v) => changeRole(member, v as AppRole)}
                  disabled={isSelf || busy}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue>{() => roleLabel(member.appRole)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">{t.team.roleAgent}</SelectItem>
                    <SelectItem value="admin">{t.team.roleAdmin}</SelectItem>
                  </SelectContent>
                </Select>
                <button
                  type="button"
                  onClick={() => remove(member)}
                  disabled={isSelf || busy}
                  aria-label={t.team.remove}
                  className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
