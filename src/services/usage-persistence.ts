import { collection, addDoc, serverTimestamp } from "firebase/firestore";
import { db, auth } from "./firebase";
import { listen } from "@tauri-apps/api/event";

export interface UsageEvent {
  event_id: string;
  timestamp: string;
  request_id?: string;
  chat_id: string;
  workspace_id: string;
  mode: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  duration_ms: number;
  success: boolean;
  cancelled: boolean;
  estimated_cost_usd: number;
  markup_cost_usd: number;
}

/**
 * Syncs a local usage event to Firestore.
 */
export async function syncUsageToFirestore(event: UsageEvent): Promise<void> {
  if (!db || !auth) return;
  const user = auth.currentUser;
  const uid = user?.uid || "guest-user";
  const period = event.timestamp.slice(0, 7); // YYYY-MM

  try {
    // Record the granular event
    await addDoc(collection(db, "usage"), {
      ...event,
      uid,
      period,
      synced_at: serverTimestamp(),
    });
  } catch (error) {
    console.error("Failed to sync usage to Firestore:", error);
  }
}

/**
 * Initializes the usage listener to catch events from the Rust backend.
 */
export async function initUsageSync(): Promise<void> {
  await listen<UsageEvent>("usage-event", (event) => {
    console.log("[usage-sync] Caught event from Rust:", event.payload);
    void syncUsageToFirestore(event.payload);
  });
  console.log("[usage-sync] Listener initialized.");
}
