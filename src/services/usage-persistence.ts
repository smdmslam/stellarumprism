import { doc, collection, addDoc, serverTimestamp, runTransaction } from "firebase/firestore";
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
}

const MARGIN_MULTIPLIER = 20.0;

/**
 * Syncs a local usage event to Firestore.
 */
export async function syncUsageToFirestore(event: UsageEvent): Promise<void> {
  const user = auth.currentUser;
  const uid = user?.uid || "guest-user";
  const period = event.timestamp.slice(0, 7); // YYYY-MM

  try {
    await runTransaction(db, async (transaction) => {
      // 1. Record the granular event
      const eventRef = collection(db, "usage");
      const eventDoc = {
        ...event,
        uid,
        period,
        markup_cost_usd: event.estimated_cost_usd * MARGIN_MULTIPLIER,
        synced_at: serverTimestamp(),
      };
      
      // Since we can't use addDoc inside a transaction for a new doc ID 
      // without knowing the ID, we'll use a specific ID if we want, 
      // but usually we just want to update the profile too.
      // For now, let's just push the record and update the profile.
      
      // 2. Update user profile totals (Lifetime and Balance)
      const profileRef = doc(db, "users", uid);
      // Note: In a real app, balance deduction should happen on the backend (Cloud Functions)
      // to prevent client-side manipulation. For now, we'll mirror the logic.
    });

    // Outside transaction for simplicity in v1
    await addDoc(collection(db, "usage"), {
      ...event,
      uid,
      period,
      markup_cost_usd: event.estimated_cost_usd * MARGIN_MULTIPLIER,
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
