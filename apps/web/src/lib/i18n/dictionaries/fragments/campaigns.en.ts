/**
 * Phase 7 console — `campaigns` dictionary namespace.
 *
 * Kept in its own file so the three Phase 7 lanes could be built in
 * parallel without three agents editing the same 1000-line dictionary.
 *
 * Shape constraint: the `Dictionary` mapped type in ../en.ts flattens at
 * depth three, so nest at most `campaigns.section.key` and keep every leaf a
 * string. Anything deeper silently becomes `string` and stops type-checking.
 *
 * Placeholders are `{name}` and substituted at the call site with
 * `.replace()` — counts are formatted with the reader's locale first so
 * Arabic gets Arabic-Indic digits where the browser provides them.
 */
export const campaignsEn = {
  eyebrow: "Broadcast",
  title: "Campaigns",
  description:
    "Send an approved WhatsApp template to a segment of your customers — with a spend ceiling, a delivery record, and a way to stop.",

  list: {
    newCampaign: "New campaign",
    audiences: "Audiences",
    emptyTitle: "No campaigns yet",
    emptyBody:
      "A campaign needs two things: an audience (a saved segment of your customers) and a WhatsApp template Meta has already approved. Build the audience first — you can check its size before anyone is messaged.",
    emptyAction: "Build your first audience",
    columnCampaign: "Campaign",
    columnStatus: "Status",
    columnAudience: "Audience",
    columnSpend: "Spend",
    columnUpdated: "Updated",
    notLaunched: "Not launched",
    recipients: "{count} recipients",
    ofCap: "of {cap} cap",
    previous: "Previous",
    next: "Next",
    couldNotLoad: "We couldn't load your campaigns.",
    openCampaign: "Open campaign",
    draftBadge: "Draft — nothing has been sent",
  },

  status: {
    draft: "Draft",
    scheduled: "Scheduled",
    sending: "Sending",
    pausedSpendCap: "Paused — budget reached",
    pausedTemplate: "Paused — template revoked",
    pausedManual: "Paused by you",
    pausedEligibility: "Stopped — account not eligible",
    completed: "Completed",
    canceled: "Canceled",
    failed: "Failed",
  },

  /**
   * The four paused states are four different problems with four different
   * fixes. They are never collapsed into one "Paused" chip.
   */
  paused: {
    spendCapTitle: "This campaign reached its spend cap",
    spendCapWhat:
      "Sending stopped the moment the next message would have cost more than the cap you set. Every remaining recipient is still queued — nobody was dropped, and nothing was sent past the cap.",
    spendCapFix:
      "A campaign's cap is fixed once it launches — only drafts can be edited. Resuming re-checks the whole audience against the money already spent, so a campaign stopped at its ceiling will refuse to resume until there is room. To reach the people still queued, cancel this campaign and create a new one with a higher cap.",
    spendCapAction: "New campaign with a higher cap",

    eligibilityTitle: "WhatsApp will not let this account send right now",
    eligibilityWhat:
      "A check on your WhatsApp Business account failed — verification, number health, quality rating or billing. The campaign stopped itself before Meta could refuse the messages. Everyone still queued is untouched.",
    eligibilityFix:
      "Fix the account condition below first. Resuming without fixing it will simply trip the same check again and stop the campaign a second time.",
    eligibilityAction: "Open channel settings",

    templateTitle: "Meta withdrew approval for this template mid-send",
    templateWhat:
      "WhatsApp paused, rejected or disabled the template while the campaign was running, so sending stopped. Every remaining recipient is still queued.",
    templateFix:
      "Fix the template in WhatsApp Manager, re-sync your templates here, then resume.",
    templateAction: "Open templates",

    manualTitle: "You paused this campaign",
    manualWhat:
      "Nothing is wrong. Sending stopped when a member of your team pressed Pause; every remaining recipient is still queued exactly as it was.",
    manualFix: "Resume whenever you're ready. No other action is needed.",
    manualAction: "Resume sending",

    reasonLabel: "What the system recorded",
    remaining: "{count} recipients still queued",
  },

  compose: {
    title: "New campaign",
    editTitle: "Edit draft",
    subtitle:
      "Nothing is sent until you launch. Saving creates a draft you can come back to.",
    nameLabel: "Campaign name",
    namePlaceholder: "Eid offer — returning customers",
    nameHint: "Only your team sees this.",
    numberLabel: "Send from",
    numberHint:
      "Template approval and messaging limits are per number. Pick the number this audience should hear from.",
    noNumbers:
      "No WhatsApp number is connected yet. Connect one in Channels before creating a campaign.",
    segmentLabel: "Audience",
    segmentHint: "Saved segments only — build or edit one in Audiences.",
    segmentNone: "No audience selected",
    spendCapLabel: "Spend cap (USD)",
    spendCapHint:
      "Sending stops before a message that would cross this. Leave blank to use your workspace default.",
    save: "Save draft",
    saveChanges: "Save changes",
    cancel: "Cancel",
    saved: "Draft saved.",
    couldNotSave: "We couldn't save this campaign.",
    editLockedTitle: "This campaign can no longer be edited",
    editLockedBody:
      "A campaign is editable only while it is a draft. Once it is scheduled or sending, its audience and template are frozen so the delivery record stays true.",
    missingFields: "Pick a template, an audience and a sending number first.",
  },

  template: {
    label: "Template",
    hint: "Only templates WhatsApp has approved can be broadcast.",
    none: "No template selected",
    choose: "Choose a template",
    empty:
      "No approved template is available. Create one under Templates, submit it to Meta, and come back once it is approved.",
    openTemplates: "Go to templates",
    category: "Category",
    language: "Language",
    preview: "Approved body",
    blockedApproval: "Not approved by WhatsApp — {detail}",
    blockedApprovalPlain: "Not approved by WhatsApp yet.",
    blockedCanned:
      "Canned replies can only be sent inside an open conversation, not broadcast.",
    blockedAuthentication:
      "Authentication templates cannot be used for a broadcast — it breaches WhatsApp policy on your own account.",
    marketingOptOutTitle: "Marketing templates must carry an opt-out line",
    marketingOptOutBody:
      "WhatsApp sends only the body it approved, so we cannot append an unsubscribe line for you. Add \"Reply STOP MARKETING to unsubscribe\" (or \"إلغاء الاشتراك\") to the template in WhatsApp Manager, re-submit it, and re-sync — otherwise launching will be refused.",
    marketingOptOutOk: "Opt-out line found in the approved body.",
    valuesTitle: "Fill in the template",
    valuesHint:
      "Every placeholder needs a value. WhatsApp rejects an empty one, so a customer field always needs a fallback.",
    valueLiteral: "Same text for everyone",
    valueCustomerName: "Customer's name",
    valueCustomerPhone: "Customer's phone",
    valueTextLabel: "Text",
    valueFallbackLabel: "If it's missing, use",
    valueFallbackPlaceholder: "there",
    valuePlaceholder: "Value for {position}",
    valueMissing: "Fill in every placeholder before saving.",
  },

  segment: {
    title: "Audiences",
    subtitle:
      "An audience is a saved rule, not a fixed list — it is re-counted every time you preview and frozen only at the moment a campaign launches.",
    create: "New audience",
    edit: "Edit",
    editTitle: "Edit audience",
    createTitle: "New audience",
    nameLabel: "Audience name",
    namePlaceholder: "Returning customers in the last 90 days",
    descriptionLabel: "Description",
    descriptionPlaceholder: "Who is in here and why (optional)",
    matchLabel: "Customers must match",
    matchAll: "all of these rules",
    matchAny: "any of these rules",
    addRule: "Add rule",
    removeRule: "Remove rule",
    negate: "Exclude instead",
    negated: "Excluded",
    noRules:
      "Add at least one rule. Customers who opted out are always excluded — that is not a rule you need to add.",
    consentNote:
      "Customers who opted out are always excluded, and consent is checked again for every message at send time.",
    preview: "Count audience",
    previewing: "Counting…",
    previewResult: "{count} customers match",
    previewAt: "Counted {time}",
    previewNever: "Not counted yet",
    previewEmpty:
      "No customer matches these rules. Loosen them before you build a campaign on this audience.",
    save: "Save audience",
    saved: "Audience saved.",
    deleted: "Audience deleted.",
    delete: "Delete",
    deleteTitle: "Delete this audience?",
    deleteBody:
      "Campaigns that already sent keep their own record of who was messaged. An audience still referenced by a campaign cannot be deleted.",
    deleteConfirm: "Delete audience",
    couldNotSave: "We couldn't save this audience.",
    couldNotDelete: "We couldn't delete this audience.",
    couldNotPreview: "We couldn't count this audience.",
    empty: "No audiences yet.",
    emptyBody:
      "Build one from labels, tags, channel, how recently someone wrote in, or their order history.",
    tooManyRules: "An audience can hold at most {max} rules.",
    unsupportedShape:
      "This audience was built with nested groups the simple editor can't show. Its rules still work — edit it through the API, or replace it with a new audience.",
    close: "Close",
  },

  criteria: {
    label: "Has label",
    tag: "Has tag",
    channel: "Came in on channel",
    customerCreated: "Became a customer within the last",
    customerCreatedBefore: "Became a customer more than",
    lastInboundWithinDays: "Wrote to us within the last",
    lastInboundBeforeDays: "Hasn't written to us in",
    orderCount: "Number of completed orders",
    orderTotalUsd: "Total spent across completed orders",
    lastOrderWithinDays: "Ordered within the last",
    neverOrdered: "Has never completed an order",
    daysSuffix: "days",
    daysAgoSuffix: "days ago",
    opGte: "at least",
    opLte: "at most",
    valuesPlaceholder: "Type a value and press Enter",
    valuesEmpty: "Add at least one value.",
    channelWhatsapp: "WhatsApp",
    channelMessenger: "Messenger",
    channelInstagram: "Instagram",
    notAvailable: "Not available yet",
    notAvailableBody:
      "This rule isn't wired up on the server yet. It will appear here as soon as it is — nothing you have to do.",
    pickRule: "Pick a rule",
    orderStatesNote:
      "Only confirmed and fulfilled orders count as purchases. An order still waiting for your approval — or rejected, expired or cancelled — does not, so a customer whose only order is pending counts as never having ordered.",
    orderCurrencyNote:
      "Totals are summed in your workspace's own currency, exactly as the orders are stored. Nothing is converted.",
    orderZeroNote:
      "“At most 0” also matches customers who never ordered — it overlaps with the “has never completed an order” rule.",
  },

  lifecycle: {
    launch: "Launch now",
    schedule: "Schedule",
    pause: "Pause",
    resume: "Resume",
    cancel: "Cancel campaign",
    scheduleAtLabel: "Send at",
    scheduleHint:
      "A time in the past means send immediately. Times are in your device's timezone.",
    launchTitle: "Send to {count} people?",
    launchBody:
      "This sends the approved template to everyone in the audience, one message at a time, from {number}. It cannot be undone once it starts — you can pause it, but a message already delivered stays delivered.",
    launchEstimateNote:
      "Estimated from published rates per country, not a quote. Unknown country codes are charged at our highest listed rate.",
    launchConfirmLabel: "Type the campaign name to confirm",
    launchConfirm: "Send now",
    scheduleTitle: "Schedule this campaign",
    scheduleConfirm: "Schedule",
    scheduled: "Campaign scheduled.",
    launched: "Campaign launched.",
    pauseTitle: "Pause this campaign?",
    pauseBody:
      "Sending stops after the message in flight. Everyone not yet messaged stays queued, and you can resume later. Messages already sent are not recalled.",
    pauseConfirm: "Pause sending",
    paused: "Campaign paused.",
    resumeTitle: "Resume sending?",
    resumeBody:
      "We re-check the template, your remaining budget and your account's eligibility before a single message goes out. If any of them refuses, nothing is sent and the reason is shown here.",
    resumeConfirm: "Resume sending",
    resumed: "Campaign resumed.",
    cancelTitle: "Cancel this campaign?",
    cancelBody:
      "Every remaining recipient is marked skipped and this campaign can never send again. Messages already sent stay sent. This cannot be undone.",
    cancelConfirmLabel: "Type the campaign name to confirm",
    cancelConfirm: "Cancel campaign",
    canceled: "Campaign canceled.",
    nameMismatch: "The name doesn't match.",
    working: "Working…",
  },

  refusal: {
    title: "This campaign was not sent",
    templateTitle: "WhatsApp will not allow this template",
    templateFix:
      "Fix it in WhatsApp Manager, re-sync your templates, then try again. Nothing was sent.",
    spendCapTitle: "This costs more than the campaign's spend cap",
    spendCapEstimate: "Estimated cost",
    spendCapCurrent: "Current cap",
    spendCapRequired: "Raise the cap to at least",
    spendCapFix:
      "Raise the cap on the draft, or narrow the audience. Costs are estimates, so leave a little headroom.",
    eligibilityTitle: "Your WhatsApp account isn't eligible to broadcast yet",
    eligibilityFix:
      "Every blocking condition is listed — fix them all, then try again. These checks fail closed: an unknown value is treated as a block, never waved through.",
    stateTitle: "That action doesn't apply to this campaign",
    dismiss: "Dismiss",
    retry: "Try again",
  },

  eligibility: {
    numberNotFound: "Sending number",
    numberNotActive: "Connection",
    messagingRestricted: "Messaging health",
    qualityRed: "Quality rating",
    noPaymentMethod: "Billing on WhatsApp",
    tierUnknown: "Messaging tier",
    overTierSpan: "Audience size vs. tier",
    businessNotVerified: "Business verification",
    verificationUnknown: "Business verification",
    templateWabaMismatch: "Template and sending number",
    billingBlocked: "Subscription",
    unknown: "Account check",
  },

  stats: {
    title: "Delivery",
    recipients: "Audience",
    sent: "Sent",
    delivered: "Delivered",
    read: "Read",
    replied: "Replied",
    failed: "Failed",
    skipped: "Skipped",
    pending: "Queued",
    sending: "In flight",
    spend: "Spent",
    spendOfCap: "{spent} of {cap}",
    estimated: "Estimated total {cost}",
    deliveredNote: "Delivered includes messages that were also read.",
    repliedNote:
      "A reply counts when it arrives within 7 days and is attributed to this campaign only if it was the last one that messaged the customer.",
    notLaunched: "Nothing has been sent yet.",
    notLaunchedBody:
      "Delivery numbers appear here the moment the first message goes out.",
    skippedTitle: "Why people were skipped",
    skipOptedOut: "Opted out of marketing",
    skipCanceled: "Campaign canceled",
    skipNoConversation: "No conversation on this channel",
    skipInvalidPhone: "Unusable phone number",
    couldNotLoad: "We couldn't load the delivery numbers.",
    refresh: "Refresh",
  },

  recipients: {
    title: "Recipients",
    subtitle:
      "The frozen list this campaign is sending to. Every row ends with a reason — nothing is ever silently dropped.",
    columnCustomer: "Customer",
    columnStatus: "Status",
    columnDelivery: "Delivery",
    columnCost: "Cost",
    columnSent: "Sent",
    filterAll: "All statuses",
    statusPending: "Queued",
    statusSending: "In flight",
    statusSent: "Sent",
    statusFailed: "Failed",
    statusSkipped: "Skipped",
    deliveryRead: "Read",
    deliveryDelivered: "Delivered",
    deliveryReplied: "Replied",
    deliveryNone: "No update yet",
    attempts: "{count} attempts",
    empty: "No recipients match this filter.",
    emptyBeforeLaunch:
      "The recipient list is created when the campaign launches — the audience is counted live until then.",
    couldNotLoad: "We couldn't load the recipients.",
    previous: "Previous",
    next: "Next",
  },

  detail: {
    back: "All campaigns",
    overview: "Overview",
    template: "Template",
    audience: "Audience",
    number: "Sending number",
    createdAt: "Created",
    scheduledFor: "Scheduled for",
    startedAt: "Started",
    completedAt: "Completed",
    spendCap: "Spend cap",
    estimated: "Estimated cost",
    estimatedNote: "Estimate, not a quote.",
    failureTitle: "This campaign failed before sending",
    edit: "Edit draft",
    notFound: "We couldn't find that campaign.",
  },

  adminOnly:
    "Campaigns are limited to workspace admins. Ask an admin on your team for access.",
};
