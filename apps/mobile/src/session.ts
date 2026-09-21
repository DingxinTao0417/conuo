import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { Platform } from "react-native";
import { createChunkedStorage } from "./core/secure-storage";
import { validateApiUrl } from "./core/api";
import { createSessionFence } from "./core/session-fence";

export const apiUrl =
  process.env.EXPO_PUBLIC_API_URL?.trim() || "https://conuo-staging.vercel.app";
let client: SupabaseClient | null = null;
const fenceKey = "conuo.native.session-fence";
const sessionFence = createSessionFence({
  getItem: () => SecureStore.getItemAsync(fenceKey),
  setItem: (value) =>
    SecureStore.setItemAsync(fenceKey, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  removeItem: () => SecureStore.deleteItemAsync(fenceKey),
});
export function getSessionFence() {
  return sessionFence;
}
export function getAuthClient() {
  if (client) return client;
  // Web export is a labelled design preview, not an alternative browser auth client.
  if (Platform.OS === "web") return null;
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (
    !url ||
    !key ||
    url.includes("your-staging-project") ||
    key.startsWith("your-")
  )
    return null;
  validateApiUrl(apiUrl);
  validateApiUrl(url);
  const storage = createChunkedStorage(
    {
      getItem: (key) => SecureStore.getItemAsync(key),
      setItem: (key, value) =>
        SecureStore.setItemAsync(key, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      removeItem: (key) => SecureStore.deleteItemAsync(key),
    },
    Crypto.randomUUID,
  );
  client = createClient(url, key, {
    auth: {
      storage,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
