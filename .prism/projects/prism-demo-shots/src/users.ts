// User types - demonstrates type mismatch
export interface User {
  id: number;        // ← number
  name: string;
  email: string;
  role: 'admin' | 'user';
}

// Bug: id is string here but User expects number
export function createUser(data: { id: string; name: string }): User {
  return {
    ...data,
    id: data.id,  // ❌ Type mismatch - string assigned to number
    email: 'unknown@example.com',
    role: 'user'
  } as User;
}

export function validateUser(user: User): boolean {
  return user.id > 0 && user.name.length > 0;
}
