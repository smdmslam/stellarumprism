// HTTP route handler - for runtime probe demo
import { unused, alsoUnused } from '../utils';  // ❌ Unused imports
import { fetchUserById } from '../auth';

export async function handleUser(req: Request) {
  const userId = req.params?.id || '1';
  const user = await fetchUserById(userId);
  return Response.json(user);
}

export async function handleHealth() {
  return Response.json({ status: 'healthy' });
}
