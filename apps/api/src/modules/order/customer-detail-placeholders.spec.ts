import {
  findMissingCustomerDetails,
  isAddressGroundedIn,
  isBareCountry,
  isFabricatedPhone,
  isPlaceholderValue,
} from './customer-detail-placeholders';

describe('isPlaceholderValue', () => {
  it.each([
    'Customer',
    ' customer ',
    'CLIENT',
    'N/A',
    'n.a.',
    'na',
    'none',
    'Unknown',
    'Not provided',
    'not provided yet',
    'Not given yet.',
    'TBD',
    'to be confirmed',
    'To be determined',
    'pending',
    'same',
    'same as above',
    '-',
    '---',
    '?',
    '...',
    'غير معروف',
    'غير متوفر',
    'لا يوجد',
    'لا يوجد.',
    'سيتم التحديد',
    'سيتم التحديد لاحقا',
    'سيتم التحديد لاحقاً',
    'العميل',
    'زبون',
    'مجهول',
    'ghair maroof',
    'mish maaroof',
    'mafi',
    'lissa',
    'zaboon',
    // Cycle 3: the model pasted an instruction to the customer into the field.
    'Please provide your delivery address',
    'please provide your address.',
    'Kindly share your full name',
    'Enter your phone number',
    'What is your address?',
    'your address here',
    'Delivery address',
    'Customer address',
    'يرجى تزويدنا بالعنوان',
    'من فضلك ارسل عنوانك',
    'الرجاء ادخال رقم جوالك',
    'العنوان',
    'رقم الجوال',
    'ersel 3enwanak',
  ])('flags %p as a placeholder', (value) => {
    expect(isPlaceholderValue(value)).toBe(true);
  });

  it.each([
    'Aisha',
    'Mohammed Al-Customer',
    'Customer Care Street, Riyadh',
    'Near the big mosque, Riyadh',
    'حي النخيل، شارع الملك فهد، الرياض',
    'عائشة',
    'Unknown Street 5, Dubai',
    'Sam Pending',
    'Ahmed',
    'Provide Street, Riyadh',
    'Near Your Home Furniture, Olaya Street',
    'جدة حي الروضة',
    'بريدة',
    'Riyadh Al Yasmin',
    '12 Tahlia Street, Riyadh',
  ])('keeps the real value %p', (value) => {
    expect(isPlaceholderValue(value)).toBe(false);
  });
});

describe('findMissingCustomerDetails', () => {
  const good = {
    customerName: 'Aisha',
    customerPhone: '+966 50 123 4567',
    shippingAddress: 'Near the big mosque, Riyadh',
  };

  it('returns nothing for real details, including Arabic-Indic digits', () => {
    expect(findMissingCustomerDetails(good)).toEqual([]);
    expect(
      findMissingCustomerDetails({ ...good, customerPhone: '٠٥٠١٢٣٤٥٦٧٩' }),
    ).toEqual([]);
  });

  it('names every placeholder field', () => {
    expect(
      findMissingCustomerDetails({
        customerName: 'Customer',
        customerPhone: 'N/A',
        shippingAddress: 'Not provided yet',
      }),
    ).toEqual(['customerName', 'customerPhone', 'shippingAddress']);
  });

  it('rejects a phone without enough digits', () => {
    expect(
      findMissingCustomerDetails({ ...good, customerPhone: 'call me' }),
    ).toEqual(['customerPhone']);
  });
});

describe('isBareCountry', () => {
  it.each([
    'Saudi Arabia',
    'saudi arabia.',
    'KSA',
    'Kingdom of Saudi Arabia',
    'UAE',
    'United Arab Emirates',
    'Kuwait',
    'المملكة العربية السعودية',
    'السعودية',
    'الإمارات',
    'الإمارات العربية المتحدة',
    'الكويت',
  ])('treats %p as a country, not an address', (value) => {
    expect(isBareCountry(value)).toBe(true);
  });

  it.each([
    'Riyadh, Saudi Arabia',
    '12 King Fahd Road, Riyadh, KSA',
    'الرياض، حي العليا، السعودية',
    // A bare city is a legitimate (if thin) delivery address for a Gulf
    // customer: the commerce-journey corpus expects an order for "بريدة".
    'بريدة',
    'Riyadh',
  ])('does not flag %p', (value) => {
    expect(isBareCountry(value)).toBe(false);
  });
});

describe('isFabricatedPhone', () => {
  it.each([
    '0500000000',
    '+966 500000000',
    '0000000000',
    '1111111111',
    '123456789',
    '0123456789',
    '1234567890',
    '٠٥٠٠٠٠٠٠٠٠',
  ])('flags %p as invented', (value) => {
    expect(isFabricatedPhone(value)).toBe(true);
  });

  it.each([
    '+966500000001',
    '+971500000003',
    '+966501110014',
    '+966 50 123 4567',
    '٠٥٠١٢٣٤٥٦٧٩',
    '0551234598',
  ])('keeps the real-looking number %p', (value) => {
    expect(isFabricatedPhone(value)).toBe(false);
  });
});

describe('findMissingCustomerDetails — cycle 3 fillers', () => {
  const good = {
    customerName: 'Aisha',
    customerPhone: '+966501110014',
    shippingAddress: '12 Tahlia Street, Riyadh',
  };

  it('rejects an instruction phrase as the address', () => {
    expect(
      findMissingCustomerDetails({
        ...good,
        shippingAddress: 'Please provide your delivery address',
      }),
    ).toEqual(['shippingAddress']);
  });

  it('rejects a bare country as the address', () => {
    expect(
      findMissingCustomerDetails({
        ...good,
        shippingAddress: 'المملكة العربية السعودية',
      }),
    ).toEqual(['shippingAddress']);
  });

  it('rejects a fabricated phone even though it has enough digits', () => {
    expect(
      findMissingCustomerDetails({ ...good, customerPhone: '0500000000' }),
    ).toEqual(['customerPhone']);
  });

  it('still accepts the details the commerce corpora use', () => {
    expect(
      findMissingCustomerDetails({
        customerName: 'Ahmed Al-Otaibi',
        customerPhone: '+966500000001',
        shippingAddress: 'بريدة',
      }),
    ).toEqual([]);
  });
});

describe('isAddressGroundedIn', () => {
  it('rejects a city the customer never said (the model invented "الرياض")', () => {
    expect(
      isAddressGroundedIn(
        'الرياض',
        'أبغى وحدة، اسمي فهد العتيبي، جوالي +966501110002',
      ),
    ).toBe(false);
  });

  it('accepts an address the customer gave in an earlier message', () => {
    expect(
      isAddressGroundedIn(
        'شارع الأمير سلطان، جدة',
        'العنوان: شارع الأمير سلطان، جدة',
      ),
    ).toBe(true);
  });

  it('accepts a bare city when the customer typed it', () => {
    expect(isAddressGroundedIn('بريدة', 'ابغى اطلب، التوصيل بريدة')).toBe(true);
  });

  it('is insensitive to punctuation, case and the Arabic definite article', () => {
    expect(
      isAddressGroundedIn(
        'Riyadh, Al-Yasmin',
        'address Riyadh Al Yasmin please',
      ),
    ).toBe(true);
    expect(isAddressGroundedIn('الرياض', 'التوصيل رياض حي النخيل')).toBe(true);
  });

  it('tolerates a few filler words the model adds around a real address', () => {
    expect(
      isAddressGroundedIn(
        'Riyadh Al Yasmin, Saudi Arabia',
        'address Riyadh Al Yasmin',
      ),
    ).toBe(true);
  });
});
