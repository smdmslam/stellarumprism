import { initializeApp, type FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getAuth, type Auth } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
let db: Firestore | null = null;
let auth: Auth | null = null;

try {
  app = initializeApp(firebaseConfig);
} catch (err) {
  console.warn(
    "[firebase] initializeApp failed — usage sync disabled:",
    err,
  );
}

if (app) {
  try {
    db = getFirestore(app);
    auth = getAuth(app);
  } catch (err) {
    console.warn("[firebase] Firestore/Auth failed — usage sync disabled:", err);
    db = null;
    auth = null;
  }
}

export { db, auth };
export default app;
