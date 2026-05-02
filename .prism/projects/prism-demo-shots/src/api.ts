// API client - has STALE CALLER to demonstrate incomplete refactor
import { getUser } from './auth';  // ❌ OLD NAME - This is the bug!

export async function handleRequest(req: Request) {
  const userId = '42';
  const user = await getUser(userId);  // ❌ BROKEN - getUser doesn't exist
  return Response.json(user);
}

export async function ping() {
  return { status: 'ok', timestamp: Date.now() };
}
