import { z } from "zod";
import { ApiError, failure, json, requireUser } from "@/lib/supabase/api";
import { inkTarget } from "@/lib/ink-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const coordinateSpace = z.object({ version: z.literal(1), space: z.literal("pdf-crop-box") }).strict();

/** Returns only current page heads and short-lived preview URLs for the owner. */
export async function GET(
  request: Request,
  context: { params: Promise<{ sourceId: string; versionId: string }> },
) {
  try {
    const { supabase, user } = await requireUser(request);
    const { sourceId, versionId } = await inkTarget(context);
    const { data: document, error: documentError } = await supabase
      .from("ink_documents")
      .select("ink_document_id, page_count, updated_at")
      .eq("owner_id", user.id)
      .eq("source_id", sourceId)
      .eq("version_id", versionId)
      .is("deleted_at", null)
      .maybeSingle();
    if (documentError) throw documentError;
    if (!document)
      return json({ inkDocumentId: null, sourceId, versionId, pageCount: 0, pages: [] });

    const { data: heads, error: headsError } = await supabase
      .from("ink_page_heads")
      .select("page_index, head_revision_id, head_generation, updated_at, deleted_at")
      .eq("owner_id", user.id)
      .eq("ink_document_id", document.ink_document_id)
      .order("page_index");
    if (headsError) throw headsError;
    const revisionIds = (heads ?? [])
      .map((head) => head.head_revision_id)
      .filter((id): id is string => typeof id === "string");
    const revisions = revisionIds.length
      ? await supabase
          .from("ink_page_revisions")
          .select(
            "revision_id, page_index, preview_storage_path, drawing_storage_path, coordinate_space, pencilkit_content_version, created_at",
          )
          .eq("owner_id", user.id)
          .eq("ink_document_id", document.ink_document_id)
          .in("revision_id", revisionIds)
      : { data: [], error: null };
    if (revisions.error) throw revisions.error;
    const byRevision = new Map((revisions.data ?? []).map((revision) => [revision.revision_id, revision]));
    const pages = [];
    for (const head of heads ?? []) {
      const revision = head.head_revision_id ? byRevision.get(head.head_revision_id) : undefined;
      const page: Record<string, unknown> = {
        pageIndex: head.page_index,
        headRevisionId: head.head_revision_id,
        headGeneration: head.head_generation,
        updatedAt: head.updated_at,
        deleted: !!head.deleted_at,
      };
      if (revision && !head.deleted_at) {
        const parsedSpace = coordinateSpace.safeParse(revision.coordinate_space);
        if (!parsedSpace.success) throw new ApiError(503, "INK_UNAVAILABLE", "笔迹坐标版本无法读取。");
        const signed = await supabase.storage.from("ink").createSignedUrl(revision.preview_storage_path, 600);
        if (signed.error || !signed.data?.signedUrl) throw signed.error ?? new Error("signed url unavailable");
        page.previewDownloadUrl = signed.data.signedUrl;
        page.coordinateSpace = parsedSpace.data;
        page.pencilKitContentVersion = revision.pencilkit_content_version;
      }
      pages.push(page);
    }
    return json({
      inkDocumentId: document.ink_document_id,
      sourceId,
      versionId,
      pageCount: document.page_count,
      pages,
      updatedAt: document.updated_at,
    });
  } catch (error) {
    return failure(error);
  }
}
