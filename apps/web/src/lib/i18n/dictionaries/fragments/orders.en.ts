/**
 * Phase 7 console — `orders` dictionary namespace.
 *
 * Kept in its own file so the three Phase 7 lanes could be built in
 * parallel without three agents editing the same 1000-line dictionary.
 *
 * Shape constraint: the `Dictionary` mapped type in ../en.ts flattens at
 * depth three, so nest at most `orders.section.key` and keep every leaf a
 * string. Anything deeper silently becomes `string` and stops type-checking.
 */
export const ordersEn = {
  eyebrow: "Orders",
  title: "Orders",
  description:
    "Orders your agent took in chat. Approve them here, follow them to the store, and decide how much runs unattended.",
  errorTitle: "Couldn't load orders",
  errorBody: "We couldn't reach the orders service.",

  tabs: {
    queue: "Approval queue",
    all: "All orders",
  },

  /** `orders.status` — the order's own lifecycle. */
  status: {
    pending_approval: "Waiting for you",
    confirmed: "Confirmed",
    rejected: "Rejected",
    expired: "Expired",
    cancelled: "Cancelled",
    fulfilled: "Fulfilled",
    failed: "Failed",
  },

  /**
   * `orders.sync` — the store push, a lifecycle of its own. A confirmed order
   * whose push failed is still a real order.
   */
  sync: {
    label: "Store",
    not_applicable: "No store connected",
    pending: "Sending to store",
    synced: "In your store",
    failed: "Didn't reach your store",
  },

  list: {
    filterStatusLabel: "Status",
    filterStatusAll: "Any status",
    filterSyncLabel: "Store sync",
    filterSyncAll: "Any sync state",
    tableCaption: "Orders, newest first",
    colReference: "Order",
    colCustomer: "Customer",
    colStatus: "Status",
    colSync: "Store",
    colTotal: "Total",
    colCreated: "Placed",
    colActions: "Actions",
    view: "Open",
    openChat: "Open chat",
    noChat: "Chat no longer linked",
    previousPage: "Previous",
    nextPage: "Next",
    showingTemplate: "{count} orders on this page, newest first.",
    emptyTitle: "No orders yet",
    emptyBody:
      "When a customer completes an order in chat, it lands here. Turn ordering on below to let your agent start taking them.",
    emptyFilteredTitle: "Nothing matches those filters",
    emptyFilteredBody: "Try a wider status, or clear the filters.",
    scopedCustomer: "Showing one customer's orders",
    scopedConversation: "Showing one chat's orders",
    clearScope: "Show all",
    clearFilters: "Clear filters",
    couldNotLoad: "Couldn't load orders.",
    notNotified: "Customer not told",
    notNotifiedHint:
      "The 24-hour WhatsApp window had closed, so we couldn't send the update. Reach out another way.",
  },

  queue: {
    title: "Waiting for your decision",
    description:
      "Nothing is sent to the customer until you approve or reject. Prices are the ones quoted in the chat.",
    emptyTitle: "Nothing waiting",
    emptyBody:
      "Every order has been decided. New ones appear here the moment a customer confirms in chat.",
    disabledTitle: "Ordering is off",
    disabledBody:
      "Your agent can't take orders yet, so nothing will arrive in this queue. Switch ordering on in the panel above.",
    autoTitle: "Running unattended",
    autoBody:
      "Orders are confirmed automatically right now, so this queue stays empty. Everything still shows up under All orders.",
    placedTemplate: "Placed {age}",
    expiresTemplate: "Expires in {hours}h",
    expiresSoon: "Expires within the hour",
    windowTemplate:
      "An order left undecided for {hours} hours expires on its own. Nothing is reserved in the meantime.",
    approve: "Approve order",
    reject: "Reject",
    loadMore: "Load more",
    refresh: "Refresh queue",
    viewDetail: "See items",
    itemsHint: "Open the order to see the items and delivery address.",
  },

  actions: {
    approvedTemplate: "Order {reference} approved — the customer has been told.",
    approvedNotNotifiedTemplate:
      "Order {reference} approved, but the chat window had closed so the customer wasn't told.",
    rejectedTemplate: "Order {reference} rejected.",
    cancelledTemplate: "Order {reference} cancelled.",
    retryQueuedTemplate: "Sending order {reference} to your store again.",
    alreadyDecidedTitle: "Already handled",
    alreadyDecidedTemplate:
      "Someone on your team already set order {reference} to “{status}”. Refreshed.",
    stockConflictTitle: "Stock changed since this order",
    outOfSync: "That order had already moved on. Refreshed.",
    couldNotApprove: "Couldn't approve that order.",
    couldNotReject: "Couldn't reject that order.",
    couldNotCancel: "Couldn't cancel that order.",
    couldNotRetry: "Couldn't queue that order for your store.",
    cancelOrder: "Cancel order",
    retryStorePush: "Send to store again",
  },

  reject: {
    title: "Reject this order",
    descriptionTemplate:
      "Order {reference} will be closed and the customer gets a short, neutral message.",
    reasonLabel: "Why are you rejecting it?",
    reasonHint:
      "For your team only — the customer never sees this. Up to 500 characters.",
    reasonPlaceholder: "Out of stock at the branch, wrong address, duplicate…",
    reasonRequired: "Add a reason so your team knows what happened.",
    reasonTooLong: "Keep the reason under 500 characters.",
    confirm: "Reject order",
    cancel: "Keep it waiting",
  },

  detail: {
    eyebrow: "Order",
    back: "All orders",
    errorTitle: "Couldn't load this order",
    errorBody: "We couldn't reach the orders service.",
    placedTemplate: "Placed {date}",
    itemsTitle: "Items",
    colItem: "Item",
    colSku: "SKU",
    colUnitPrice: "Unit price",
    colQuantity: "Qty",
    colLineTotal: "Line total",
    subtotal: "Subtotal",
    total: "Total",
    priceSnapshotNote:
      "These are the prices quoted at the time of the order, not today's catalogue prices.",
    totalsNote: "Shipping and VAT aren't calculated yet, so the total is the subtotal.",
    deliveryTitle: "Delivery",
    contactName: "Name",
    contactPhone: "Phone",
    city: "City",
    address: "Address",
    notes: "Notes",
    notGiven: "Not given",
    paymentTitle: "Payment",
    paymentMethod: "Method",
    paymentStatus: "Status",
    paymentCod: "Cash on delivery",
    paymentUnpaid: "Not collected",
    paymentCollected: "Collected",
    paymentNote: "Cash on delivery is the only method available in this phase.",
    timelineTitle: "What happened",
    timelinePlaced: "Customer placed the order in chat",
    timelineApproved: "Approved",
    timelineApprovedByTemplate: "Approved by {user}",
    timelineRejected: "Rejected",
    timelineRejectionReasonTemplate: "Internal reason: {reason}",
    timelineCancelled: "Cancelled",
    timelineExpired: "Expired without a decision",
    timelineFulfilled: "Fulfilled",
    timelineFailed: "Failed",
    timelineNotified: "Customer told on WhatsApp",
    timelineNotNotified:
      "Customer not told — the 24-hour WhatsApp window had closed",
    timelineUpdated: "Last change",
    timelineNote:
      "Built from the order's own timestamps. Who did what is also in the audit log.",
    linksTitle: "Where this came from",
    openConversation: "Open the chat",
    noConversation: "The chat this came from has been removed.",
    customerIdLabel: "Customer ID",
    customerIdNote: "Use this ID to find every other order from this customer.",
    filterByCustomer: "Other orders from this customer",
    storeTitle: "Your store",
    storeNone: "This order isn't going to a connected store.",
    storeExternalIdTemplate: "Store order {id}",
    storeAttemptsTemplate: "{count} attempts so far",
    storeErrorLabel: "Last error",
    storeFailedBody:
      "The order is confirmed on our side. It just hasn't reached your store yet — you can send it again.",
  },

  settings: {
    title: "Ordering",
    description: "Whether your agent can take orders, and who confirms them.",
    show: "Ordering settings",
    hide: "Hide settings",
    modeLabel: "Ordering mode",
    modeDisabled: "Off",
    modeDisabledHint:
      "Your agent won't offer to take an order and can't place one. This is where every workspace starts.",
    modeHumanApproval: "You approve each order",
    modeHumanApprovalHint:
      "The agent collects the order and tells the customer it isn't placed yet. Nothing is confirmed until someone here approves it.",
    modeAuto: "Confirm automatically",
    modeAutoHint:
      "The agent confirms orders on its own, with no one in the loop. Only available once every check below passes.",
    codLabel: "Cash on delivery",
    codHint: "The only payment method available in this phase.",
    codOn: "Offered to customers",
    codOff: "Not offered",
    windowLabel: "Approval window (hours)",
    windowHint:
      "An order nobody decides within this many hours expires on its own, so the queue doesn't fill with stale orders. Between 1 and 168.",
    windowInvalid: "Enter a whole number of hours between 1 and 168.",
    save: "Save ordering settings",
    saved: "Ordering settings saved.",
    couldNotSave: "Couldn't save those settings.",
    couldNotLoad: "Couldn't load your ordering settings.",
    adminOnlyTitle: "Admins set the ordering mode",
    adminOnlyBody:
      "You can approve and reject orders, but changing how orders are taken is an admin job. Ask a workspace admin to open this page.",
    eligibilityTitle: "Before you can confirm automatically",
    eligibilityBody:
      "Unattended ordering is real money placed by a model, so it unlocks only after your workspace has a track record. All five have to pass.",
    eligibleTitle: "Ready for unattended ordering",
    eligibleBody:
      "Every check passes. You can switch to automatic confirmation whenever you want to.",
    blockedTitle: "Automatic confirmation is blocked",
    blockedBody: "These checks haven't passed yet:",
    measuredTemplate: "Checked {date}",
    met: "Passed",
    notMet: "Not yet",
    refusedTitle: "Couldn't switch to automatic",
    autoEnabledTemplate: "Automatic confirmation turned on {date}.",
    noDemotionNote:
      "We never switch you back automatically — if your rejection rate slips we'll tell you, and the call stays yours.",
  },

  /** `orders.criteria` — the five D1.5 gates. The API sends the evidence per criterion; these are the headings. */
  criteria: {
    human_approval_tenure: "Seven days approving orders yourself",
    decided_orders: "Twenty orders decided",
    rejection_rate: "Rejection rate under 5%",
    catalog_ready: "Products ready to sell",
    cod_enabled: "Cash on delivery switched on",
    unknown: "Additional check",
  },

  /**
   * `orders.criteriaDetail` — the API sends each criterion's evidence as an
   * English sentence. format.ts recognises the known shapes and re-renders
   * them from these templates; an unrecognised sentence is shown as sent.
   */
  criteriaDetail: {
    tenureNever:
      "Needs {required} days of you approving orders yourself; ordering hasn't been switched on yet.",
    tenure:
      "Needs {required} days of you approving orders yourself; switched on {days} days ago, currently set to “{mode}”.",
    decidedOrders: "Needs {required} approved or rejected orders; {count} so far.",
    rejectionRate:
      "Needs a rejection rate below {max}%; currently {rate}% ({rejected} of {total}).",
    catalogEmpty: "Needs at least one active product; there are none yet.",
    catalogUnlinked:
      "A store is connected but none of your active products is linked to it, so every automatic order would fail to reach the store.",
    catalogLinked: "{active} active products, {linked} linked to a connected store.",
    catalogNoStore: "{active} active products; no store connected, so orders stay in Clarly.",
    codOn: "Cash on delivery is on.",
    codOff: "Cash on delivery is the only payment method for now, and it's switched off.",
    // Built from the API's structured evidence (`code` + `required`/`actual`).
    tenureDays: "Needs {required} of you approving orders yourself; {actual} so far.",
    rejectionRateShort: "Needs a rejection rate below {required}; currently {actual}.",
    productsLinked: "Products linked to your store: {actual} (needs at least {required}).",
    storeNotConnected: "No store connected, so orders stay in Clarly.",
  },

  /**
   * F25 added `CUSTOMER_COMPLAINT` to the shared escalation enum. Its label
   * belongs in the `tickets` namespace with the other reasons, but that
   * namespace lives in en.ts/ar.ts which this lane doesn't own — so it is
   * parked here and read by lib/tickets/escalation.ts. Move it to
   * `tickets.escalationCustomerComplaint` when en.ts/ar.ts are next touched.
   */
  escalationReason: {
    customerComplaint: "Complaint about an order",
  },
};
