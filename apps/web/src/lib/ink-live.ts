import { createClient } from "@/lib/supabase/client";

/**
 * Subscribes to the signed-in account's ink page-head writes.
 * Handlers only receive a change ping; callers re-fetch the signed preview URL.
 */
export function subscribeToInkPageHeads(input: {
  ownerId: string;
  onChange: () => void;
}): () => void {
  if (!input.ownerId) return () => {};
  try {
    const client = createClient();
    const channel = client
      .channel(`ink-page-heads:${input.ownerId}`)
      .on(
        // supabase-js postgres_changes typing is generic over generated DB types.
        "postgres_changes" as never,
        {
          event: "*",
          schema: "public",
          table: "ink_page_heads",
          filter: `owner_id=eq.${input.ownerId}`,
        } as never,
        () => input.onChange(),
      )
      .subscribe();
    return () => {
      void client.removeChannel(channel);
    };
  } catch {
    // Realtime is optional; foreground polling still keeps previews fresh.
    return () => {};
  }
}
