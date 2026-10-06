/**
 * Clarly 2.0 S3 — `widget` namespace: Settings → Website chat.
 * Same shape rules as ./delivery.en.ts (max depth three, string leaves).
 */
export const widgetEn = {
  eyebrow: "Channels",
  title: "Website chat",
  description:
    "A chat button on your own website. Visitors get the same agent, the same rules and the same hand-off to your team as on WhatsApp.",
  adminOnly: "Only an admin can change the website chat.",
  statusLabel: "Website chat",
  on: "On",
  off: "Off",
  statusHint: "While it is off, the button does not appear on any website.",
  originsLabel: "Websites allowed to show it",
  originsHint:
    "The full address of each website, for example https://shop.example.com. The chat refuses to load anywhere else, so copying your snippet onto another site does nothing.",
  originPlaceholder: "https://shop.example.com",
  addOrigin: "Add",
  removeOrigin: "Remove",
  invalidOrigin: "Use the full https address, for example https://shop.example.com.",
  noOrigins: "No websites yet. Add the address of the site you will paste the snippet on.",
  appearanceLabel: "Look",
  titleLabel: "Title (optional)",
  titleHint: "Shown at the top of the chat. Your workspace name is used when empty.",
  welcomeLabel: "Welcome message (optional)",
  welcomeHint: "The first bubble a visitor sees. Write it in the language your visitors use.",
  colorLabel: "Colour",
  positionLabel: "Button position",
  positions: {
    right: "Bottom right",
    left: "Bottom left",
  },
  localeLabel: "Language",
  locales: {
    auto: "Follow the website",
    ar: "العربية",
    en: "English",
  },
  save: "Save",
  saved: "Website chat saved.",
  couldNotSave: "Couldn't save the website chat.",
  snippetLabel: "Embed snippet",
  snippetHint: "Paste this just before </body> on every page where the chat should appear.",
  copy: "Copy",
  copied: "Snippet copied.",
  rotate: "Issue a new key",
  rotateConfirm: "Issue a new key? The current snippet stops working at once and has to be replaced on every website.",
  rotated: "New key issued. Replace the snippet on your websites.",
  enableFirst: "Turn the chat on and add your website before pasting the snippet.",
};
