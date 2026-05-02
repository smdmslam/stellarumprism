// Auth module - refactor victim
// BEFORE: function was called getUser
// AFTER: renamed to fetchUserById

const db = {
  users: {
    find: async (id: string) => ({ id, name: 'Demo User' })
  }
};

export async function fetchUserById(id: string) {
  return db.users.find(id);
}

export async function authenticate(token: string) {
  // Simulate auth check
  if (!token) throw new Error('No token provided');
  return { userId: '1', role: 'admin' };
}
