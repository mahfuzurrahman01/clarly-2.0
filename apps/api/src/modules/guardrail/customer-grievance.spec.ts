import { reportsCustomerGrievance } from './customer-grievance';

describe('reportsCustomerGrievance()', () => {
  describe('F27: the four Gulf Arabic grievance shapes, every dialect', () => {
    it.each([
      ['khaleeji, not as pictured', 'اللون مختلف عن الصور'],
      ['khaleeji, wrong item', 'وصلني مكسور، هذا غلط'],
      ['khaleeji, never arrived', 'من اسبوعين استنى ما وصل'],
      ['khaleeji, money back', 'ابي فلوسي رجعوهم، هذا مو طلبي'],
      ['egyptian, wrong item', 'وصلني مكسور ده غلط'],
      ['egyptian, never arrived', 'من اتنين استنى ما وصل'],
      ['egyptian, money back', 'عايز فلوسي ترجع ده مش طلبي'],
      ['levantine, wrong item', 'وصلني مكسور هيدا غلط'],
      ['levantine, never arrived', 'من أسبوعين عم استنى ما وصل'],
      ['levantine, money back', 'بدنا فلوسنا ترجع هيدا مش طلبنا'],
      ['arabizi, not as pictured', 'al-lawn ghayr 3an al-suwar'],
      ['arabizi, wrong item', 'waynsali ma3sur ya rb hadha ghalt'],
      ['arabizi, never arrived', 'min usbu3ayn astanna ma wasal'],
      ['arabizi, money back', 'abii flusi rudduhum hadha mashrooti'],
    ])('detects %s', (_label, message) => {
      expect(reportsCustomerGrievance(message)).toBe(true);
    });
  });

  describe('the same four shapes in English — the rule is not dialect-specific policy', () => {
    it.each([
      'this is not what I ordered',
      'I want my money back',
      'I have been waiting two weeks and it still has not arrived',
      'the colour is different from the photos',
    ])('detects %s', (message) => {
      expect(reportsCustomerGrievance(message)).toBe(true);
    });
  });

  describe('PRECISION: a calm question about a problem is not a grievance', () => {
    it.each([
      // tone-escalation#9 and refund-policy#4 — both expect `resolve`.
      ['the item I got is defective, what are my options'],
      ['my headphones arrived broken and I opened them, can I return them'],
      ['hi, my delivery seems to be running late, could you check?'],
      ['it arrived like this, what do I do?'],
      // The dialect corpora's own non-complaint cases.
      ['اقدر ارجعه لو ما عجبني؟'],
      ['بقدر رجعه لو ما عجبني؟'],
      ['ارجعه لو معجبنيش؟'],
      ['aqdar aruddha law ma 3jbatni?'],
      ['كيف اتبع طلبي؟'],
      ['how long until I get my money back'],
      ['how many days do I have to return something'],
    ])('ignores %s', (message) => {
      expect(reportsCustomerGrievance(message)).toBe(false);
    });
  });

  it('is a net, not a classifier: distress phrased outside the four shapes is left to L0 and the answer-side net', () => {
    expect(
      reportsCustomerGrievance(
        'ei order ta niye ami khub birokto, tomader service kharap',
      ),
    ).toBe(false);
  });
});
