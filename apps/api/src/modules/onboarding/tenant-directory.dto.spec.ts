import { updateTenantProfileBodySchema } from './tenant-directory.dto';

describe('updateTenantProfileBodySchema', () => {
  it('accepts a partial update and upper-cases codes', () => {
    expect(
      updateTenantProfileBodySchema.parse({ country: 'sa', currency: 'sar' }),
    ).toEqual({ country: 'SA', currency: 'SAR' });
  });

  it('accepts null to clear country and currency', () => {
    expect(
      updateTenantProfileBodySchema.parse({ country: null, currency: null }),
    ).toEqual({ country: null, currency: null });
  });

  it('rejects an empty body', () => {
    expect(updateTenantProfileBodySchema.safeParse({}).success).toBe(false);
  });

  it.each([
    [{ country: 'SAU' }],
    [{ currency: 'RIYAL' }],
    [{ vertical: 'agency' }],
    [{ defaultLocale: 'fr' }],
    [{ name: '   ' }],
  ])('rejects %j', (body) => {
    expect(updateTenantProfileBodySchema.safeParse(body).success).toBe(false);
  });

  // `.strict()`: a tenant must not be able to smuggle `closedAt` or `id`
  // through the profile endpoint.
  it('rejects unknown fields', () => {
    expect(
      updateTenantProfileBodySchema.safeParse({ name: 'x', closedAt: null })
        .success,
    ).toBe(false);
  });
});
