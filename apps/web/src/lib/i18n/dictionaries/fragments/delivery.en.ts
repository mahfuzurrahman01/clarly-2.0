/**
 * Phase 7 console — `delivery` dictionary namespace.
 *
 * Kept in its own file so the three Phase 7 lanes could be built in
 * parallel without three agents editing the same 1000-line dictionary.
 *
 * Shape constraint: the `Dictionary` mapped type in ../en.ts flattens at
 * depth three, so nest at most `delivery.section.key` and keep every leaf a
 * string. Anything deeper silently becomes `string` and stops type-checking.
 */
export const deliveryEn = {
  // --- /deliveries ---
  eyebrow: "Commerce",
  title: "Deliveries",
  description:
    "Every shipment raised against an order, with the courier's own trail behind it.",
  errorTitle: "We couldn't load your shipments.",
  errorBody: "The deliveries list didn't come back.",

  list: {
    filtersTitle: "Narrow the list",
    orderStatusLabel: "Order status",
    courierLabel: "Courier",
    shipmentStatusLabel: "Shipment status",
    all: "All",
    serverFilterNote:
      "Order status is applied by the server as it pages. Courier and shipment status narrow what is already loaded — load more to widen the search.",
    columnShipment: "Shipment",
    columnStatus: "Status",
    columnUpdated: "Last update",
    columnOrder: "Order",
    countTemplate: "{shown} of {loaded} shipments from {orders} orders",
    loadMore: "Load more orders",
    loading: "Loading",
    refresh: "Refresh",
    couldNotLoad: "We couldn't load more shipments.",
    expand: "Show tracking history",
    collapse: "Hide tracking history",
    emptyTitle: "No shipments yet",
    emptyBody:
      "A shipment appears here once an order is handed to a courier and its tracking number is recorded. Record one from an order's page with “Add tracking number”.",
    emptyHint: "Connect a courier first so a tracking number can be polled.",
    emptyFilteredTitle: "No shipments match these filters",
    emptyFilteredBody:
      "Only the orders loaded so far were searched. Clear a filter, or load more orders.",
    clearFilters: "Clear filters",
    settingsLink: "Courier settings",
    openOrder: "Open order",
  },

  detail: {
    trackingLabel: "Tracking number",
    courierLabel: "Courier",
    orderLabel: "Order",
    etaLabel: "Estimated delivery",
    etaUnknown: "Not published by the courier",
    deliveredLabel: "Delivered",
    notifiedLabel: "Customer last told",
    notifiedNever: "Customer has not been told about this shipment",
    freshnessTitle: "How fresh is this?",
    lastPolled: "Last polled",
    neverPolled: "Never polled",
    lastWebhook: "Last push from courier",
    noWebhook: "No push received",
    pollOnlyNote:
      "This courier has no push callback, so the status here is only as recent as the last poll.",
    webhookNote:
      "This courier pushes updates as they happen; polling still runs underneath as a safety net.",
    terminalNote: "Delivered, returned and cancelled shipments are no longer polled.",
    pollFailures: "Consecutive poll failures",
    pollFailuresHealthy: "Polling is healthy",
    timelineTitle: "Tracking history",
    timelineEmpty:
      "The courier has not reported an event for this tracking number yet.",
    monotonicNote:
      "Status only moves forward. A courier replaying an older event is kept in the history below but does not move the shipment back.",
    rawStatusLabel: "Courier's own code",
    locationLabel: "Location",
    sourceLabel: "Source",
    notAdvanced: "Recorded, did not advance",
    current: "Current",
  },

  status: {
    labelCreated: "Label created",
    pickedUp: "Picked up",
    inTransit: "In transit",
    outForDelivery: "Out for delivery",
    delivered: "Delivered",
    failedAttempt: "Failed attempt",
    returned: "Returned",
    cancelled: "Cancelled",
    exception: "Exception",
    unknown: "Unknown",
  },

  orderStatus: {
    pendingApproval: "Awaiting approval",
    confirmed: "Confirmed",
    rejected: "Rejected",
    expired: "Expired",
    cancelled: "Cancelled",
    fulfilled: "Fulfilled",
    failed: "Failed",
  },

  source: {
    poll: "Poll",
    webhook: "Courier push",
    manual: "Entered by hand",
  },

  // --- /settings/delivery ---
  settings: {
    eyebrow: "Settings",
    title: "Delivery",
    description:
      "Courier accounts this workspace tracks shipments through, and whether customers hear about status changes.",
    errorTitle: "We couldn't load your delivery settings.",
    errorBody: "The courier connections didn't come back.",
  },

  connections: {
    title: "Courier accounts",
    description:
      "Credentials come from your account manager at the courier. We call the courier with them before saving the connection as active.",
    trustNote:
      "\"Verified\" means the courier accepted these credentials on a live call. Connectors for all four couriers are new — if tracking looks wrong after connecting, tell us rather than assuming the account is at fault.",
    pollOnly: "Polling only",
    pollOnlyHint:
      "This courier publishes no callback we can verify, so we ask it for updates on a schedule.",
    webhookVerified: "Push + polling",
    webhookVerifiedHint:
      "This courier can push updates to a signed URL. Polling continues underneath it.",
    stateConnected: "Connected",
    stateInactive: "Not active",
    stateNotConnected: "Not connected",
    verifiedAt: "Verified",
    neverVerified: "Never verified",
    lastPolled: "Last polled",
    neverPolled: "Not polled yet",
    accountRefLabel: "Account reference",
    accountRefHint:
      "Your shipper or account number at this courier. It also routes the courier's callbacks back to you, so it must match exactly.",
    connect: "Connect",
    reenter: "Re-enter credentials",
    disconnect: "Disconnect",
    disconnectConfirmTemplate:
      "Disconnect {courier}? Shipments on this account stop being polled until you connect it again.",
    disconnected: "Courier disconnected.",
    saving: "Verifying with the courier",
    save: "Verify and connect",
    cancel: "Cancel",
    saved: "Connected. The courier accepted these credentials.",
    savedInactive: "Saved, but the courier rejected these credentials.",
    couldNotSave: "We couldn't save this connection.",
    couldNotDisconnect: "We couldn't disconnect this courier.",
    rejectionTitle: "The courier rejected these credentials",
    rejectionHint: "This is the courier's own wording, passed through untouched.",
    requiredFields: "Fill every field — the courier is called with all of them.",
  },

  credentials: {
    writeOnlyTitle: "We never show a saved credential again",
    writeOnlyBody:
      "Credentials are encrypted when they arrive and are not readable afterwards, by you or by us. To change one, enter the full set again — the new set replaces the old one.",
    aramexUsername: "Username",
    aramexPassword: "Password",
    aramexAccountNumber: "Account number",
    aramexAccountPin: "Account PIN",
    aramexAccountEntity: "Account entity",
    aramexAccountEntityHint: "The three-letter station code, e.g. DXB or RUH.",
    aramexAccountCountryCode: "Account country code",
    aramexAccountCountryCodeHint: "Two letters, e.g. AE or SA.",
    smsaApiKey: "API key",
    smsaApiKeyHint: "The eCom REST key, sent as the apikey header — not the older SOAP passkey.",
    naqelClientId: "Client ID",
    naqelPassword: "Password",
    jtApiAccount: "API account",
    jtPrivateKey: "Private key",
    jtPrivateKeyHint: "Used to sign every call and to verify each callback we receive.",
  },

  shipmentForm: {
    sectionTitle: "Shipments",
    none: "No tracking number recorded for this order yet.",
    notShippable: "Tracking numbers can be added once the order is confirmed.",
    viewAll: "All deliveries",
    couldNotLoad: "We couldn't load this order's shipments.",
    open: "Add tracking number",
    title: "Add tracking number",
    descriptionPrefix: "Record the parcel you've handed to a courier for order",
    descriptionSuffix:
      ". We'll poll the courier for status from then on; this doesn't book a pickup.",
    courierLabel: "Courier account",
    courierPlaceholder: "Choose a courier account",
    courierRequired: "Choose which courier account the parcel went with.",
    noConnections:
      "No active courier account yet. Connect one in courier settings, then come back to add the tracking number.",
    trackingLabel: "Tracking number",
    trackingHint:
      "Exactly as the courier printed it. Adding the same number twice keeps one shipment.",
    trackingRequired: "Enter the tracking number.",
    trackingTooLong: "Tracking numbers are at most 128 characters.",
    cancel: "Cancel",
    submit: "Save tracking number",
    created: "Tracking number saved.",
    couldNotCreate: "We couldn't save the tracking number.",
  },

  webhook: {
    title: "Courier callback",
    description:
      "Paste this URL into your J&T console, then paste the signing secret beside it. Until both are in place, tracking still works — it just waits for the next poll.",
    urlLabel: "Callback URL",
    copyUrl: "Copy URL",
    copied: "Copied",
    secretSet: "Signing secret is set",
    secretMissing: "No signing secret yet",
    generate: "Generate signing secret",
    rotate: "Replace signing secret",
    rotating: "Generating",
    rotateConfirm:
      "Replacing the secret breaks callbacks until you paste the new one into the courier's console. Continue?",
    revealTitle: "Copy this now — it is shown once",
    revealBody:
      "We store a one-way copy. Close this panel and the secret is gone for good; you would have to generate another.",
    dismiss: "I've saved it",
    couldNotRotate: "We couldn't generate a signing secret.",
  },

  notifications: {
    title: "Tell customers about their shipment",
    description:
      "When a shipment reaches a status you map below, the customer gets that WhatsApp template automatically.",
    stateOff: "Off",
    stateOn: "On",
    toggleLabel: "Send delivery updates to customers",
    defaultOffNote:
      "Off until you turn it on. Nothing has been sent to any customer while this is off.",
    consequenceTitle: "What turning this on does",
    consequenceBody:
      "Every customer with a shipment starts receiving a WhatsApp message each time it reaches a status you mapped — picked up, out for delivery, delivered, failed attempt, returned. These are business-initiated utility templates, so WhatsApp bills each one.",
    consequenceGuards:
      "Each status is sent once per shipment, never twice. Customers who opted out of messages are skipped, and a status you leave unmapped is never sent.",
    mappingTitle: "Status to template",
    mappingHint:
      "Only approved utility templates can be used — WhatsApp refuses a marketing template for a shipment update.",
    noTemplate: "Don't send anything",
    noApprovedTemplates:
      "No approved utility template exists yet. Create one under Settings → Templates and submit it for approval before turning this on.",
    templatesLink: "Go to templates",
    enabledWithoutMapping:
      "This is on, but no status is mapped — nothing will be sent until you map at least one.",
    updatedAt: "Last changed",
    neverUpdated: "Never changed",
    save: "Save notification settings",
    saving: "Saving",
    saved: "Notification settings saved.",
    couldNotSave: "We couldn't save your notification settings.",
    couldNotLoadTemplates: "We couldn't load your templates.",
  },
};
