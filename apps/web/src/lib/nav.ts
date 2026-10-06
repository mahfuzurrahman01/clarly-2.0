import {
  BarChart3,
  Cable,
  Bot,
  BookOpen,
  CalendarDays,
  Building2,
  CreditCard,
  DoorOpen,
  FileDown,
  FlaskConical,
  History,
  Home,
  Inbox,
  LayoutList,
  MessageSquareText,
  MessagesSquare,
  Package,
  ClipboardList,
  Truck,
  Megaphone,
  SlidersHorizontal,
  Store,
  Users,
  Webhook,
  type LucideIcon,
} from "lucide-react";

export type NavItemId =
  | "home"
  | "tickets"
  | "inbox"
  | "catalog"
  | "orders"
  | "bookings"
  | "deliveries"
  | "campaigns"
  | "insights"
  | "playground";

export type NavItem = {
  id: NavItemId;
  href: string;
  icon: LucideIcon;
  /** Built yet? Not-ready items render disabled with a "soon" marker. */
  ready: boolean;
  /** Hidden for the agent role — the backend guard 403s these anyway. */
  adminOnly?: boolean;
};

export type NavGroupId = "main" | "understand";

export type NavGroup = {
  id: NavGroupId;
  items: NavItem[];
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "main",
    items: [
      { id: "home", href: "/home", icon: Home, ready: true },
      { id: "tickets", href: "/tickets", icon: LayoutList, ready: true },
      { id: "inbox", href: "/inbox", icon: Inbox, ready: true },
      // Catalog is not admin-gated: the API only requires a tenant + an
      // active entitlement, so an agent can look a product up too.
      { id: "catalog", href: "/catalog", icon: Package, ready: true },
      // Phase 7. Orders and deliveries are agent-visible on purpose: the
      // approval queue and the shipment view are day-to-day agent work, not
      // admin configuration (the mode switch inside /orders is admin-gated
      // by the API, which 403s an agent that tries to flip it).
      { id: "orders", href: "/orders", icon: ClipboardList, ready: true },
      // v2 S2: appointments. Agent-visible like orders: confirming a request
      // is working a conversation; the settings that turn it on are admin-only.
      { id: "bookings", href: "/bookings", icon: CalendarDays, ready: true },
      { id: "deliveries", href: "/deliveries", icon: Truck, ready: true },
    ],
  },
  {
    id: "understand",
    items: [
      {
        id: "insights",
        href: "/insights",
        icon: BarChart3,
        ready: true,
        adminOnly: true,
      },
      {
        id: "campaigns",
        href: "/campaigns",
        icon: Megaphone,
        ready: true,
        adminOnly: true,
      },
      {
        id: "playground",
        href: "/playground",
        icon: FlaskConical,
        ready: true,
        adminOnly: true,
      },
    ],
  },
];

// Settings is rendered separately from NAV_GROUPS (see NavLinks) — one
// collapsible entry in its own "Workspace" section, not a single link,
// so each section is reachable directly instead of landing on a shared
// tabbed page. Admin-only throughout; the backend 403s these for agents.
export type SettingsChildId =
  | "settingsWorkspace"
  | "settingsBookings"
  | "settingsAgent"
  | "settingsChannels"
  | "settingsWebsiteChat"
  | "settingsStore"
  | "settingsKnowledge"
  | "settingsTeam"
  | "settingsBilling"
  | "settingsPolicy"
  | "settingsDelivery"
  | "settingsTemplates"
  | "settingsDataExport"
  | "settingsAuditLog"
  | "settingsWebhooks"
  | "settingsOffboarding";

export type SettingsChild = {
  id: SettingsChildId;
  href: string;
  icon: LucideIcon;
};

export const SETTINGS_CHILDREN: SettingsChild[] = [
  // v2 S1: the workspace profile (vertical, country, currency, language).
  { id: "settingsWorkspace", href: "/settings/workspace", icon: Building2 },
  { id: "settingsAgent", href: "/settings/agent", icon: Bot },
  { id: "settingsBookings", href: "/settings/bookings", icon: CalendarDays },
  { id: "settingsChannels", href: "/settings/channels", icon: Cable },
  // v2 S3: the website chat widget (the `web` channel).
  { id: "settingsWebsiteChat", href: "/settings/website-chat", icon: MessagesSquare },
  { id: "settingsStore", href: "/settings/store", icon: Store },
  { id: "settingsKnowledge", href: "/settings/knowledge", icon: BookOpen },
  { id: "settingsTemplates", href: "/settings/templates", icon: MessageSquareText },
  { id: "settingsTeam", href: "/settings/team", icon: Users },
  { id: "settingsBilling", href: "/settings/billing", icon: CreditCard },
  { id: "settingsPolicy", href: "/settings/policy", icon: SlidersHorizontal },
  { id: "settingsDelivery", href: "/settings/delivery", icon: Truck },
  { id: "settingsDataExport", href: "/settings/data-export", icon: FileDown },
  { id: "settingsAuditLog", href: "/settings/audit-log", icon: History },
  { id: "settingsWebhooks", href: "/settings/webhooks", icon: Webhook },
  // Last on purpose: closing the workspace is the end of the list, not a
  // neighbour of everyday settings.
  { id: "settingsOffboarding", href: "/settings/offboarding", icon: DoorOpen },
];
