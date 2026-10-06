import { matchService, normaliseServiceName } from './booking-catalog.service';

const SERVICES = [
  { id: 'a', name: 'Teeth Cleaning' },
  { id: 'b', name: 'Whitening' },
  { id: 'c', name: 'تنظيف الأسنان' },
  { id: 'd', name: 'Consultation' },
  { id: 'e', name: 'Video Consultation' },
];

describe('normaliseServiceName', () => {
  it('folds case, spacing and Arabic tatweel', () => {
    expect(normaliseServiceName('  Teeth   CLEANING ')).toBe('teeth cleaning');
    expect(normaliseServiceName('تنظـــيف')).toBe('تنظيف');
  });
});

describe('matchService', () => {
  it('matches exactly, ignoring case', () => {
    expect(matchService(SERVICES, 'whitening')?.id).toBe('b');
  });
  it('matches by id', () => {
    expect(matchService(SERVICES, 'c')?.id).toBe('c');
  });
  it('matches a unique partial name either way round', () => {
    expect(matchService(SERVICES, 'cleaning')?.id).toBe('a');
    expect(matchService(SERVICES, 'I want a teeth cleaning please')?.id).toBe(
      'a',
    );
  });
  it('matches Arabic names', () => {
    expect(matchService(SERVICES, 'تنظيف')?.id).toBe('c');
  });
  // "Consultation" is the exact name of d and part of e: exact wins.
  it('prefers an exact match over a partial one', () => {
    expect(matchService(SERVICES, 'consultation')?.id).toBe('d');
  });
  // Two partial matches is ambiguous: the agent must ask, not pick.
  it('returns null when a partial name fits two services', () => {
    expect(matchService(SERVICES, 'consult')).toBeNull();
  });
  it('returns null for nothing or blank', () => {
    expect(matchService(SERVICES, 'massage')).toBeNull();
    expect(matchService(SERVICES, '   ')).toBeNull();
  });
});
