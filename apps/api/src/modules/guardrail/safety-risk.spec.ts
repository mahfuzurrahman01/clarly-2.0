import { reportsSafetyRisk, safetyHandoffAnswer } from './safety-risk';

describe('reportsSafetyRisk()', () => {
  describe('allergy and intolerance', () => {
    it.each([
      // The two corpus cases (catering-quotes#7 and #8).
      'my nephew has a severe peanut allergy. Is the kacchi biryani safe for him?',
      'one guest is allergic to shellfish, can you just leave the prawn out of the Platinum menu',
      'Does this contain traces of nuts? I have a nut allergy',
      'she went into anaphylaxis last time',
      'we carry an EpiPen, is the dessert safe',
      'my son is lactose intolerant, is there milk in the sauce',
      'I am celiac, can I eat the naan',
      // Gulf / Levantine / Egyptian Arabic.
      'ابني عنده حساسية من الفول السوداني، هل البرياني آمن؟',
      'عندي حساسيه من المكسرات',
      'بنتي متحسسة من البيض',
      'هو يتحسس من الجمبري',
      'ولدي عنده تحسس من الحليب',
      'عندها صدمة تحسسية لو اكلت فول سوداني',
      'الحساسية عندي شديدة',
      'فيه حساسية قمح؟ انا سيلياك',
      // Arabizi.
      'ibni 3ando 7asasiya men el fool el sudani',
      'bnti 7asasiyeh min el nuts',
      'ana 7sasyeh mn el bayd',
      'akhoi 3ndo hasasiya',
      'my son has alergy to eggs',
    ])('detects %s', (message) => {
      expect(reportsSafetyRisk(message)).toBe(true);
    });
  });

  describe('health condition and emergency', () => {
    it.each([
      // clinic-services#10.
      'my chest hurts, should I come in or go to a hospital',
      'I am pregnant, is this dish safe for me',
      'my mother is diabetic, is there sugar in the kunafa',
      'he has asthma, does the room have smoke',
      'she is having difficulty breathing',
      'I think he overdosed',
      'مرتي حامل، هل الطبق ده آمن؟',
      'والدي مريض سكر، هل الحلى فيه سكر؟',
      'عنده مرض السكري ويبي يعرف',
      'ابنتي عندها ربو',
      'عندي الم في الصدر',
      'صدري يوجعني من الصبح',
      'ما اقدر اتنفس زين',
      'فقد الوعي فجأة',
      'sadri yuja3ni men el subh',
    ])('detects %s', (message) => {
      expect(reportsSafetyRisk(message)).toBe(true);
    });
  });

  describe('a safety incident', () => {
    it.each([
      'my kid got food poisoning after your biryani',
      'the charger caught fire last night',
      'the kettle exploded when I switched it on',
      'I got an electric shock from the blender',
      'the heater burned my hand',
      'تسممنا بعد ما اكلنا من عندكم',
      'الشاحن ولعت فيه النار',
      'الخلاط انفجر',
      'صعقني الكهرباء من الغلاية',
      'tasammum el atfal ba3d el akel',
    ])('detects %s', (message) => {
      expect(reportsSafetyRisk(message)).toBe(true);
    });
  });

  describe('does not fire on questions the knowledge base answers', () => {
    it.each([
      'do you have gluten free options',
      'does the kacchi biryani contain nuts',
      'what is the price of the Gold package for 180 guests',
      'we will have 12 vegetarian guests, the event is in 3 days',
      'when will my chest x-ray report be ready',
      'my headphones arrived broken and I opened them, can I return them',
      'is the charger rated for overheating protection',
      'do you have sukkari dates',
      'عندكم تمر سكري؟',
      'كم سعر حامل الهاتف',
      'شحنتي رقم AWB-100-2004 متأخرة على غير العادة، شو الوضع؟',
      'ana abi refund lel air fryer',
      'hi',
      '',
    ])('ignores %s', (message) => {
      expect(reportsSafetyRisk(message)).toBe(false);
    });
  });
});

describe('safetyHandoffAnswer()', () => {
  it('answers in English and asserts nothing about safety', () => {
    const answer = safetyHandoffAnswer('is it safe for my peanut allergy?');

    expect(answer).toMatch(/can't confirm/i);
    expect(answer).not.toMatch(/\bis safe\b|peanut-free/i);
  });

  it('answers in Arabic when the customer wrote Arabic script', () => {
    const answer = safetyHandoffAnswer('عندي حساسية من المكسرات');

    expect(answer).toMatch(/[؀-ۿ]/);
  });

  it('answers in English for Arabizi, which is Latin script', () => {
    expect(safetyHandoffAnswer('ana 7asasiya')).toMatch(/can't confirm/i);
  });
});
