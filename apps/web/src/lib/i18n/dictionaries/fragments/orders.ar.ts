import type { ordersEn } from "./orders.en";

/** Arabic side of the `orders` namespace — see ./orders.en.ts for the shape rules. */
export const ordersAr: typeof ordersEn = {
  eyebrow: "الطلبات",
  title: "الطلبات",
  description:
    "الطلبات التي استلمها المساعد من المحادثات. اعتمدها من هنا، وتابع وصولها إلى متجرك، وحدّد ما الذي يعمل دون إشراف.",
  errorTitle: "تعذّر تحميل الطلبات",
  errorBody: "لم نتمكّن من الوصول إلى خدمة الطلبات.",

  tabs: {
    queue: "بانتظار الاعتماد",
    all: "كل الطلبات",
  },

  status: {
    pending_approval: "بانتظار قرارك",
    confirmed: "مؤكَّد",
    rejected: "مرفوض",
    expired: "منتهي المدة",
    cancelled: "ملغى",
    fulfilled: "تم التسليم",
    failed: "فشل",
  },

  sync: {
    label: "المتجر",
    not_applicable: "لا يوجد متجر مرتبط",
    pending: "جارٍ إرساله إلى المتجر",
    synced: "وصل إلى متجرك",
    failed: "لم يصل إلى متجرك",
  },

  list: {
    filterStatusLabel: "الحالة",
    filterStatusAll: "كل الحالات",
    filterSyncLabel: "حالة المتجر",
    filterSyncAll: "كل حالات المتجر",
    tableCaption: "الطلبات، الأحدث أولاً",
    colReference: "الطلب",
    colCustomer: "العميل",
    colStatus: "الحالة",
    colSync: "المتجر",
    colTotal: "الإجمالي",
    colCreated: "تاريخ الطلب",
    colActions: "إجراءات",
    view: "فتح",
    openChat: "فتح المحادثة",
    noChat: "المحادثة لم تعد مرتبطة",
    previousPage: "السابق",
    nextPage: "التالي",
    showingTemplate: "{count} طلبات في هذه الصفحة، الأحدث أولاً.",
    emptyTitle: "لا توجد طلبات بعد",
    emptyBody:
      "عندما يُكمل عميل طلبًا داخل المحادثة سيظهر هنا. فعّل استقبال الطلبات من الأسفل ليبدأ المساعد باستلامها.",
    emptyFilteredTitle: "لا توجد نتائج لهذه التصفية",
    emptyFilteredBody: "جرّب حالة أوسع، أو امسح عوامل التصفية.",
    scopedCustomer: "عرض طلبات عميل واحد",
    scopedConversation: "عرض طلبات محادثة واحدة",
    clearScope: "عرض الكل",
    clearFilters: "مسح التصفية",
    couldNotLoad: "تعذّر تحميل الطلبات.",
    notNotified: "لم يُبلَّغ العميل",
    notNotifiedHint:
      "انتهت نافذة الـ24 ساعة في واتساب فلم نتمكّن من إرسال التحديث. تواصل مع العميل بطريقة أخرى.",
  },

  queue: {
    title: "بانتظار قرارك",
    description:
      "لا يصل العميل أي تأكيد حتى تعتمد الطلب أو ترفضه. الأسعار هي التي ذُكرت له في المحادثة.",
    emptyTitle: "لا شيء بالانتظار",
    emptyBody:
      "تم البتّ في كل الطلبات. سيظهر الطلب الجديد هنا لحظة تأكيد العميل له في المحادثة.",
    disabledTitle: "استقبال الطلبات متوقف",
    disabledBody:
      "المساعد لا يستطيع استلام الطلبات حاليًا، لذلك لن يصل شيء إلى هذه القائمة. فعّل الاستقبال من اللوحة أعلاه.",
    autoTitle: "يعمل دون إشراف",
    autoBody:
      "الطلبات تُؤكَّد تلقائيًا الآن، لذلك تبقى هذه القائمة فارغة. ستجدها كلها في تبويب كل الطلبات.",
    placedTemplate: "طُلب {age}",
    expiresTemplate: "تنتهي مدته خلال {hours} ساعة",
    expiresSoon: "تنتهي مدته خلال أقل من ساعة",
    windowTemplate:
      "الطلب الذي لا يُبتّ فيه خلال {hours} ساعة تنتهي مدته تلقائيًا. ولا يُحجز له مخزون في هذه الأثناء.",
    approve: "اعتماد الطلب",
    reject: "رفض",
    loadMore: "عرض المزيد",
    refresh: "تحديث القائمة",
    viewDetail: "عرض الأصناف",
    itemsHint: "افتح الطلب للاطّلاع على الأصناف وعنوان التوصيل.",
  },

  actions: {
    approvedTemplate: "تم اعتماد الطلب {reference} وأُبلغ العميل.",
    approvedNotNotifiedTemplate:
      "تم اعتماد الطلب {reference}، لكن نافذة المحادثة كانت مغلقة فلم يُبلَّغ العميل.",
    rejectedTemplate: "تم رفض الطلب {reference}.",
    cancelledTemplate: "تم إلغاء الطلب {reference}.",
    retryQueuedTemplate: "جارٍ إعادة إرسال الطلب {reference} إلى متجرك.",
    alreadyDecidedTitle: "تمّت معالجته مسبقًا",
    alreadyDecidedTemplate:
      "أحد أعضاء فريقك حوّل الطلب {reference} إلى “{status}” قبلك. تم تحديث الصف.",
    stockConflictTitle: "تغيّر المخزون منذ هذا الطلب",
    outOfSync: "تغيّرت حالة هذا الطلب قبل قليل. تم تحديثه.",
    couldNotApprove: "تعذّر اعتماد هذا الطلب.",
    couldNotReject: "تعذّر رفض هذا الطلب.",
    couldNotCancel: "تعذّر إلغاء هذا الطلب.",
    couldNotRetry: "تعذّرت إعادة إرسال الطلب إلى متجرك.",
    cancelOrder: "إلغاء الطلب",
    retryStorePush: "إعادة الإرسال إلى المتجر",
  },

  reject: {
    title: "رفض هذا الطلب",
    descriptionTemplate:
      "سيُغلق الطلب {reference} وتصل العميل رسالة قصيرة ومحايدة.",
    reasonLabel: "ما سبب الرفض؟",
    reasonHint: "لفريقك فقط — لا يراه العميل إطلاقًا. حتى 500 حرف.",
    reasonPlaceholder: "الصنف غير متوفر في الفرع، عنوان خاطئ، طلب مكرر…",
    reasonRequired: "اكتب سببًا ليعرف فريقك ما الذي حدث.",
    reasonTooLong: "اجعل السبب أقل من 500 حرف.",
    confirm: "رفض الطلب",
    cancel: "إبقاؤه بالانتظار",
  },

  detail: {
    eyebrow: "طلب",
    back: "كل الطلبات",
    errorTitle: "تعذّر تحميل هذا الطلب",
    errorBody: "لم نتمكّن من الوصول إلى خدمة الطلبات.",
    placedTemplate: "أُنشئ في {date}",
    itemsTitle: "الأصناف",
    colItem: "الصنف",
    colSku: "رمز الصنف",
    colUnitPrice: "سعر الوحدة",
    colQuantity: "الكمية",
    colLineTotal: "إجمالي السطر",
    subtotal: "المجموع",
    total: "الإجمالي",
    priceSnapshotNote:
      "هذه هي الأسعار التي عُرضت على العميل وقت الطلب، وليست أسعار الكتالوج اليوم.",
    totalsNote: "الشحن والضريبة غير محتسبين في هذه المرحلة، لذلك الإجمالي يساوي المجموع.",
    deliveryTitle: "التوصيل",
    contactName: "الاسم",
    contactPhone: "رقم الجوال",
    city: "المدينة",
    address: "العنوان",
    notes: "ملاحظات",
    notGiven: "غير مُدخل",
    paymentTitle: "الدفع",
    paymentMethod: "الطريقة",
    paymentStatus: "الحالة",
    paymentCod: "الدفع عند الاستلام",
    paymentUnpaid: "لم يُحصَّل",
    paymentCollected: "تم التحصيل",
    paymentNote: "الدفع عند الاستلام هو الطريقة الوحيدة المتاحة في هذه المرحلة.",
    timelineTitle: "ما الذي حدث",
    timelinePlaced: "أنشأ العميل الطلب في المحادثة",
    timelineApproved: "تم الاعتماد",
    timelineApprovedByTemplate: "اعتمده {user}",
    timelineRejected: "تم الرفض",
    timelineRejectionReasonTemplate: "السبب الداخلي: {reason}",
    timelineCancelled: "تم الإلغاء",
    timelineExpired: "انتهت مدته دون قرار",
    timelineFulfilled: "تم التسليم",
    timelineFailed: "فشل",
    timelineNotified: "أُبلغ العميل عبر واتساب",
    timelineNotNotified: "لم يُبلَّغ العميل — كانت نافذة الـ24 ساعة مغلقة",
    timelineUpdated: "آخر تغيير",
    timelineNote:
      "مبني على تواريخ الطلب نفسه. تفاصيل من فعل ماذا موجودة أيضًا في سجل التدقيق.",
    linksTitle: "مصدر هذا الطلب",
    openConversation: "فتح المحادثة",
    noConversation: "حُذفت المحادثة التي جاء منها هذا الطلب.",
    customerIdLabel: "معرّف العميل",
    customerIdNote: "استخدم هذا المعرّف للوصول إلى بقية طلبات هذا العميل.",
    filterByCustomer: "طلبات أخرى لهذا العميل",
    storeTitle: "متجرك",
    storeNone: "هذا الطلب غير موجّه إلى متجر مرتبط.",
    storeExternalIdTemplate: "رقم الطلب في المتجر {id}",
    storeAttemptsTemplate: "{count} محاولات حتى الآن",
    storeErrorLabel: "آخر خطأ",
    storeFailedBody:
      "الطلب مؤكَّد لدينا، لكنه لم يصل إلى متجرك بعد. يمكنك إعادة إرساله.",
  },

  settings: {
    title: "استقبال الطلبات",
    description: "هل يستطيع المساعد استلام الطلبات، ومن الذي يؤكّدها.",
    show: "إعدادات الطلبات",
    hide: "إخفاء الإعدادات",
    modeLabel: "نمط استقبال الطلبات",
    modeDisabled: "متوقف",
    modeDisabledHint:
      "لن يعرض المساعد استلام أي طلب ولا يستطيع إنشاءه. هذا هو الوضع الافتراضي لكل مساحة عمل.",
    modeHumanApproval: "أنت تعتمد كل طلب",
    modeHumanApprovalHint:
      "يجمع المساعد تفاصيل الطلب ويخبر العميل أنه لم يُعتمد بعد. ولا يتأكّد شيء قبل اعتماد أحد من الفريق.",
    modeAuto: "تأكيد تلقائي",
    modeAutoHint:
      "يؤكّد المساعد الطلبات من تلقاء نفسه دون تدخل بشري. لا يُتاح إلا بعد اجتياز كل الشروط أدناه.",
    codLabel: "الدفع عند الاستلام",
    codHint: "طريقة الدفع الوحيدة المتاحة في هذه المرحلة.",
    codOn: "معروض على العملاء",
    codOff: "غير معروض",
    windowLabel: "مهلة الاعتماد (بالساعات)",
    windowHint:
      "الطلب الذي لا يُبتّ فيه خلال هذه المدة تنتهي مدته تلقائيًا حتى لا تمتلئ القائمة بطلبات قديمة. من 1 إلى 168.",
    windowInvalid: "أدخل عدد ساعات صحيحًا بين 1 و168.",
    save: "حفظ إعدادات الطلبات",
    saved: "تم حفظ إعدادات الطلبات.",
    couldNotSave: "تعذّر حفظ هذه الإعدادات.",
    couldNotLoad: "تعذّر تحميل إعدادات الطلبات.",
    adminOnlyTitle: "تغيير النمط من صلاحية المشرف",
    adminOnlyBody:
      "يمكنك اعتماد الطلبات ورفضها، أما تغيير طريقة استلامها فهي من صلاحيات المشرف. اطلب من مشرف مساحة العمل فتح هذه الصفحة.",
    eligibilityTitle: "قبل تفعيل التأكيد التلقائي",
    eligibilityBody:
      "التأكيد دون إشراف يعني أموالًا حقيقية يلتزم بها نموذج ذكاء اصطناعي، لذلك لا يُفتح إلا بعد سجل واضح لمساحة عملك. يجب اجتياز الشروط الخمسة كلها.",
    eligibleTitle: "جاهز للتأكيد التلقائي",
    eligibleBody:
      "كل الشروط مستوفاة. يمكنك التحويل إلى التأكيد التلقائي متى شئت.",
    blockedTitle: "التأكيد التلقائي غير متاح",
    blockedBody: "هذه الشروط لم تُستوفَ بعد:",
    measuredTemplate: "تم الفحص في {date}",
    met: "مستوفى",
    notMet: "غير مستوفى",
    refusedTitle: "تعذّر التحويل إلى التأكيد التلقائي",
    autoEnabledTemplate: "فُعّل التأكيد التلقائي في {date}.",
    noDemotionNote:
      "لن نعيدك إلى الاعتماد اليدوي تلقائيًا — إذا ارتفعت نسبة الرفض سننبّهك، ويبقى القرار قرارك.",
  },

  criteria: {
    human_approval_tenure: "سبعة أيام من الاعتماد اليدوي",
    decided_orders: "البتّ في عشرين طلبًا",
    rejection_rate: "نسبة رفض أقل من 5%",
    catalog_ready: "منتجات جاهزة للبيع",
    cod_enabled: "تفعيل الدفع عند الاستلام",
    unknown: "شرط إضافي",
  },

  criteriaDetail: {
    tenureNever:
      "يتطلب {required} أيام من اعتمادك للطلبات بنفسك؛ لم يُفعَّل استقبال الطلبات بعد.",
    tenure:
      "يتطلب {required} أيام من اعتمادك للطلبات بنفسك؛ فُعِّل قبل {days} يوم، والوضع الحالي «{mode}».",
    decidedOrders: "يتطلب {required} طلبًا تمت الموافقة عليها أو رفضها؛ حتى الآن {count}.",
    rejectionRate:
      "يتطلب نسبة رفض أقل من {max}%؛ النسبة الحالية {rate}% ({rejected} من {total}).",
    catalogEmpty: "يتطلب منتجًا نشطًا واحدًا على الأقل؛ لا توجد منتجات بعد.",
    catalogUnlinked:
      "المتجر مرتبط لكن لا يوجد منتج نشط مرتبط به، لذا سيفشل إرسال كل طلب تلقائي إلى المتجر.",
    catalogLinked: "{active} منتج نشط، منها {linked} مرتبط بمتجر متصل.",
    catalogNoStore: "{active} منتج نشط؛ لا يوجد متجر متصل، لذا تبقى الطلبات في كلارلي.",
    codOn: "الدفع عند الاستلام مفعَّل.",
    codOff: "الدفع عند الاستلام هو طريقة الدفع الوحيدة حاليًا، وهو متوقف.",
    tenureDays: "يتطلب {required} من اعتمادك للطلبات بنفسك؛ حتى الآن {actual}.",
    rejectionRateShort: "يتطلب نسبة رفض أقل من {required}؛ النسبة الحالية {actual}.",
    productsLinked: "المنتجات المرتبطة بمتجرك: {actual} (المطلوب {required} على الأقل).",
    storeNotConnected: "لا يوجد متجر متصل، لذا تبقى الطلبات في كلارلي.",
  },

  escalationReason: {
    customerComplaint: "شكوى بخصوص طلب",
  },
};
