import type { deliveryEn } from "./delivery.en";

/** Arabic side of the `delivery` namespace — see ./delivery.en.ts for the shape rules. */
export const deliveryAr: typeof deliveryEn = {
  // --- /deliveries ---
  eyebrow: "التجارة",
  title: "الشحنات",
  description: "كل شحنة مرتبطة بطلب، ومعها سجل التتبّع كما ورد من شركة الشحن.",
  errorTitle: "تعذّر تحميل الشحنات.",
  errorBody: "لم تصلنا قائمة الشحنات.",

  list: {
    filtersTitle: "تصفية القائمة",
    orderStatusLabel: "حالة الطلب",
    courierLabel: "شركة الشحن",
    shipmentStatusLabel: "حالة الشحنة",
    all: "الكل",
    serverFilterNote:
      "حالة الطلب تُطبَّق على الخادم أثناء جلب الصفحات. أمّا شركة الشحن وحالة الشحنة فتُصفّيان ما تم تحميله فقط — حمّل مزيدًا من الطلبات لتوسيع البحث.",
    columnShipment: "الشحنة",
    columnStatus: "الحالة",
    columnUpdated: "آخر تحديث",
    columnOrder: "الطلب",
    countTemplate: "{shown} من {loaded} شحنة ضمن {orders} طلبًا",
    loadMore: "تحميل طلبات أقدم",
    loading: "جارٍ التحميل",
    refresh: "تحديث",
    couldNotLoad: "تعذّر تحميل مزيد من الشحنات.",
    expand: "عرض سجل التتبّع",
    collapse: "إخفاء سجل التتبّع",
    emptyTitle: "لا توجد شحنات بعد",
    emptyBody:
      "تظهر الشحنة هنا بعد تسليم الطلب لشركة الشحن وتسجيل رقم التتبّع. سجّلها من صفحة الطلب عبر «إضافة رقم التتبّع».",
    emptyHint: "اربط شركة شحن أولًا حتى يمكن تتبّع رقم الشحنة.",
    emptyFilteredTitle: "لا توجد شحنات مطابقة لهذه التصفية",
    emptyFilteredBody:
      "بحثنا في الطلبات المحمّلة فقط. أزِل أحد عوامل التصفية أو حمّل مزيدًا من الطلبات.",
    clearFilters: "إزالة التصفية",
    settingsLink: "إعدادات شركات الشحن",
    openOrder: "فتح الطلب",
  },

  detail: {
    trackingLabel: "رقم التتبّع",
    courierLabel: "شركة الشحن",
    orderLabel: "الطلب",
    etaLabel: "التسليم المتوقّع",
    etaUnknown: "لم تنشره شركة الشحن",
    deliveredLabel: "تم التسليم",
    notifiedLabel: "آخر إشعار للعميل",
    notifiedNever: "لم يُبلَّغ العميل بشيء عن هذه الشحنة",
    freshnessTitle: "ما مدى حداثة هذه المعلومة؟",
    lastPolled: "آخر استعلام",
    neverPolled: "لم يجرِ أي استعلام",
    lastWebhook: "آخر تحديث فوري من شركة الشحن",
    noWebhook: "لم يصل أي تحديث فوري",
    pollOnlyNote:
      "هذه الشركة لا ترسل تحديثات فورية، لذا فالحالة هنا حديثة بقدر آخر استعلام فقط.",
    webhookNote:
      "هذه الشركة ترسل التحديثات فور حدوثها، ويستمر الاستعلام الدوري كشبكة أمان.",
    terminalNote: "الشحنات المسلَّمة والمرتجعة والملغاة لا يجري الاستعلام عنها بعد ذلك.",
    pollFailures: "محاولات استعلام فاشلة متتالية",
    pollFailuresHealthy: "الاستعلام يعمل بسلاسة",
    timelineTitle: "سجل التتبّع",
    timelineEmpty: "لم تُسجّل شركة الشحن أي حدث على رقم التتبّع هذا بعد.",
    monotonicNote:
      "الحالة تتقدّم للأمام فقط. إذا أعادت شركة الشحن إرسال حدث قديم فإنه يُحفظ في السجل أدناه دون أن يُرجع الشحنة للخلف.",
    rawStatusLabel: "رمز شركة الشحن",
    locationLabel: "الموقع",
    sourceLabel: "المصدر",
    notAdvanced: "مُسجَّل ولم يُقدّم الحالة",
    current: "الحالة الحالية",
  },

  status: {
    labelCreated: "تم إنشاء البوليصة",
    pickedUp: "تم الاستلام",
    inTransit: "في الطريق",
    outForDelivery: "خرجت للتسليم",
    delivered: "تم التسليم",
    failedAttempt: "محاولة تسليم فاشلة",
    returned: "مرتجعة",
    cancelled: "ملغاة",
    exception: "حالة استثنائية",
    unknown: "غير معروفة",
  },

  orderStatus: {
    pendingApproval: "بانتظار الاعتماد",
    confirmed: "مؤكّد",
    rejected: "مرفوض",
    expired: "منتهي الصلاحية",
    cancelled: "ملغي",
    fulfilled: "مكتمل",
    failed: "فشل",
  },

  source: {
    poll: "استعلام دوري",
    webhook: "تحديث فوري",
    manual: "إدخال يدوي",
  },

  // --- /settings/delivery ---
  settings: {
    eyebrow: "الإعدادات",
    title: "الشحن والتوصيل",
    description:
      "حسابات شركات الشحن التي نتتبّع الشحنات من خلالها، وما إذا كان العملاء يُبلَّغون بتغيّر الحالة.",
    errorTitle: "تعذّر تحميل إعدادات الشحن.",
    errorBody: "لم تصلنا بيانات الربط مع شركات الشحن.",
  },

  connections: {
    title: "حسابات شركات الشحن",
    description:
      "تحصل على البيانات من مدير حسابك لدى شركة الشحن. نتّصل بالشركة للتحقّق منها قبل تفعيل الربط.",
    trustNote:
      "«تم التحقّق» تعني أن شركة الشحن قبِلت هذه البيانات في اتصال فعلي. الربط مع الشركات الأربع حديث العهد — إن بدا التتبّع غير صحيح بعد الربط فأبلغنا بدل افتراض وجود خلل في الحساب.",
    pollOnly: "استعلام دوري فقط",
    pollOnlyHint:
      "هذه الشركة لا تنشر آلية تحديث فوري يمكننا التحقّق من توقيعها، لذا نستعلم منها وفق جدول زمني.",
    webhookVerified: "تحديث فوري مع استعلام دوري",
    webhookVerifiedHint:
      "هذه الشركة تستطيع إرسال التحديثات إلى رابط موقَّع، ويستمر الاستعلام الدوري إلى جانبه.",
    stateConnected: "مرتبط",
    stateInactive: "غير مفعّل",
    stateNotConnected: "غير مرتبط",
    verifiedAt: "تم التحقّق",
    neverVerified: "لم يتم التحقّق",
    lastPolled: "آخر استعلام",
    neverPolled: "لم يجرِ استعلام بعد",
    accountRefLabel: "رقم الحساب لدى الشركة",
    accountRefHint:
      "رقم الشاحن أو الحساب لديك في هذه الشركة. يُستخدم أيضًا لتوجيه تحديثات الشركة إليك، فاكتبه كما هو تمامًا.",
    connect: "ربط",
    reenter: "إعادة إدخال البيانات",
    disconnect: "إلغاء الربط",
    disconnectConfirmTemplate:
      "إلغاء الربط مع {courier}؟ سيتوقّف تتبّع شحنات هذا الحساب حتى تعيد ربطه.",
    disconnected: "تم إلغاء الربط.",
    saving: "جارٍ التحقّق لدى شركة الشحن",
    save: "تحقّق واربط",
    cancel: "إلغاء",
    saved: "تم الربط. قبِلت شركة الشحن هذه البيانات.",
    savedInactive: "حُفظت البيانات، لكن شركة الشحن رفضتها.",
    couldNotSave: "تعذّر حفظ هذا الربط.",
    couldNotDisconnect: "تعذّر إلغاء الربط.",
    rejectionTitle: "رفضت شركة الشحن هذه البيانات",
    rejectionHint: "هذا نص شركة الشحن كما ورد، دون تعديل.",
    requiredFields: "املأ كل الحقول — نرسلها جميعًا إلى شركة الشحن.",
  },

  credentials: {
    writeOnlyTitle: "لا نعرض بيانات محفوظة مرة أخرى",
    writeOnlyBody:
      "تُشفَّر البيانات فور وصولها ولا يمكن قراءتها بعد ذلك، لا منك ولا منّا. لتغيير أي قيمة أدخل المجموعة كاملة من جديد، فالمجموعة الجديدة تحلّ محلّ القديمة.",
    aramexUsername: "اسم المستخدم",
    aramexPassword: "كلمة المرور",
    aramexAccountNumber: "رقم الحساب",
    aramexAccountPin: "الرقم السري للحساب",
    aramexAccountEntity: "رمز المحطة",
    aramexAccountEntityHint: "رمز المحطة من ثلاثة أحرف، مثل DXB أو RUH.",
    aramexAccountCountryCode: "رمز دولة الحساب",
    aramexAccountCountryCodeHint: "حرفان، مثل AE أو SA.",
    smsaApiKey: "مفتاح الـ API",
    smsaApiKeyHint:
      "مفتاح واجهة eCom REST الذي يُرسَل في ترويسة apikey — وليس مفتاح passkey القديم.",
    naqelClientId: "معرّف العميل",
    naqelPassword: "كلمة المرور",
    jtApiAccount: "حساب الـ API",
    jtPrivateKey: "المفتاح الخاص",
    jtPrivateKeyHint: "يُستخدم لتوقيع كل طلب وللتحقّق من كل تحديث يصلنا.",
  },

  shipmentForm: {
    sectionTitle: "الشحنات",
    none: "لم يُسجّل رقم تتبّع لهذا الطلب بعد.",
    notShippable: "يمكن إضافة رقم التتبّع بعد تأكيد الطلب.",
    viewAll: "كل الشحنات",
    couldNotLoad: "تعذّر تحميل شحنات هذا الطلب.",
    open: "إضافة رقم التتبّع",
    title: "إضافة رقم التتبّع",
    descriptionPrefix: "سجّل الشحنة التي سلّمتها لشركة الشحن للطلب",
    descriptionSuffix:
      ". سنتابع حالتها لدى شركة الشحن من الآن؛ هذا لا يحجز موعد استلام.",
    courierLabel: "حساب شركة الشحن",
    courierPlaceholder: "اختر حساب شركة الشحن",
    courierRequired: "اختر حساب شركة الشحن التي استلمت الشحنة.",
    noConnections:
      "لا يوجد حساب شحن مفعّل بعد. اربط حسابًا من إعدادات الشحن ثم عُد لإضافة رقم التتبّع.",
    trackingLabel: "رقم التتبّع",
    trackingHint:
      "كما طبعته شركة الشحن تمامًا. إضافة الرقم نفسه مرتين تُبقي شحنة واحدة.",
    trackingRequired: "أدخل رقم التتبّع.",
    trackingTooLong: "رقم التتبّع لا يتجاوز 128 حرفًا.",
    cancel: "إلغاء",
    submit: "حفظ رقم التتبّع",
    created: "تم حفظ رقم التتبّع.",
    couldNotCreate: "تعذّر حفظ رقم التتبّع.",
  },

  webhook: {
    title: "رابط تحديثات شركة الشحن",
    description:
      "الصق هذا الرابط في لوحة J&T، ثم الصق بجانبه مفتاح التوقيع. حتى تكتمل الخطوتان يظل التتبّع يعمل، لكنه ينتظر الاستعلام التالي.",
    urlLabel: "رابط التحديثات",
    copyUrl: "نسخ الرابط",
    copied: "تم النسخ",
    secretSet: "مفتاح التوقيع مُعدّ",
    secretMissing: "لا يوجد مفتاح توقيع بعد",
    generate: "إنشاء مفتاح توقيع",
    rotate: "استبدال مفتاح التوقيع",
    rotating: "جارٍ الإنشاء",
    rotateConfirm:
      "استبدال المفتاح يوقف التحديثات الفورية حتى تلصق المفتاح الجديد في لوحة شركة الشحن. هل تريد المتابعة؟",
    revealTitle: "انسخه الآن — يُعرض مرة واحدة فقط",
    revealBody:
      "نحتفظ بنسخة مشفّرة لا يمكن استرجاعها. بإغلاق هذه اللوحة يختفي المفتاح نهائيًا وستحتاج إلى إنشاء غيره.",
    dismiss: "حفظته",
    couldNotRotate: "تعذّر إنشاء مفتاح التوقيع.",
  },

  notifications: {
    title: "إبلاغ العملاء بحالة شحناتهم",
    description:
      "عندما تصل الشحنة إلى حالة ربطتها بقالب أدناه، يصل العميل قالب واتساب المحدّد تلقائيًا.",
    stateOff: "متوقّف",
    stateOn: "مفعّل",
    toggleLabel: "إرسال تحديثات الشحن إلى العملاء",
    defaultOffNote:
      "متوقّف حتى تفعّله بنفسك. لم يُرسَل أي شيء لأي عميل ما دام متوقفًا.",
    consequenceTitle: "ماذا يحدث عند التفعيل",
    consequenceBody:
      "كل عميل لديه شحنة سيبدأ باستلام رسالة واتساب عند كل حالة ربطتها — تم الاستلام، خرجت للتسليم، تم التسليم، محاولة فاشلة، مرتجعة. هذه قوالب خدمية يبدأها النشاط التجاري، ويحتسب واتساب رسومًا على كل رسالة.",
    consequenceGuards:
      "تُرسل كل حالة مرة واحدة لكل شحنة ولا تتكرّر. ونتجاوز العملاء الذين ألغوا الاشتراك في الرسائل، والحالة غير المرتبطة بقالب لا تُرسل إطلاقًا.",
    mappingTitle: "ربط الحالة بالقالب",
    mappingHint:
      "تُقبل القوالب الخدمية المعتمدة فقط — يرفض واتساب استخدام قالب تسويقي لتحديث شحنة.",
    noTemplate: "لا ترسل شيئًا",
    noApprovedTemplates:
      "لا يوجد قالب خدمي معتمد بعد. أنشئ قالبًا من الإعدادات ← القوالب وأرسله للاعتماد قبل التفعيل.",
    templatesLink: "الذهاب إلى القوالب",
    enabledWithoutMapping:
      "الخاصية مفعّلة لكن لا توجد حالة مرتبطة بقالب — لن يُرسل شيء حتى تربط حالة واحدة على الأقل.",
    updatedAt: "آخر تعديل",
    neverUpdated: "لم يُعدّل",
    save: "حفظ إعدادات الإشعارات",
    saving: "جارٍ الحفظ",
    saved: "تم حفظ إعدادات الإشعارات.",
    couldNotSave: "تعذّر حفظ إعدادات الإشعارات.",
    couldNotLoadTemplates: "تعذّر تحميل القوالب.",
  },
};
