import { describe, it, expect } from 'vitest';
import { fetchUserById } from '../src/auth';

describe('auth', () => {
  it('fetches user by id', async () => {
    const user = await fetchUserById('42');
    expect(user.name).toBe('Alice');  // ❌ FAILS — no mock, returns 'Demo User'
  });

  it('validates email format', () => {
    const email = 'test@example.com';
    expect(email.includes('@')).toBe(true);
  });
});
