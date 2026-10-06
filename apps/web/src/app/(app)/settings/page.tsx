import { redirect } from "next/navigation";

// Settings has no landing of its own yet — the agent config is the natural home.
export default function SettingsIndex() {
  redirect("/settings/agent");
}
