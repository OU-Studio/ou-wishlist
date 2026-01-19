import prisma from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * Extracts the submission id from the draft order note
 * Expected line: "Submission ID: <id>"
 */
function extractSubmissionId(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const m = note.match(/Submission ID:\s*([a-z0-9]+)/i);
  return m?.[1] ?? null;
}

function toDraftOrderGid(id: unknown): string | null {
  // Webhook payload usually uses numeric REST ids
  if (typeof id === "number") return `gid://shopify/DraftOrder/${id}`;
  if (typeof id === "string" && id.trim()) {
    // if already gid, keep it; if numeric string, convert
    if (id.startsWith("gid://")) return id;
    if (/^\d+$/.test(id)) return `gid://shopify/DraftOrder/${id}`;
  }
  return null;
}

export async function action({ request }: { request: Request }) {
  // Verifies HMAC + parses payload
  const { topic, shop, payload } = await authenticate.webhook(request);

  // We only care about draft order create/update
  const t = String(topic || "");
  const isDraftCreate = t === "DRAFT_ORDERS_CREATE" || t === "draft_orders/create";
  const isDraftUpdate = t === "DRAFT_ORDERS_UPDATE" || t === "draft_orders/update";

  if (!isDraftCreate && !isDraftUpdate) {
    return new Response("ok", { status: 200 });
  }

  // payload shape depends on webhook version; draft orders have "note" and "id"
  const note = (payload as any)?.note;
  const submissionId = extractSubmissionId(note);

  if (!submissionId) {
    // nothing to attach
    return new Response("ok", { status: 200 });
  }

  const draftOrderGid = toDraftOrderGid((payload as any)?.id);

  // Update our submission record with the DraftOrder ID
  // (Don’t fail webhook if record missing)
  try {
    await prisma.wishlistSubmission.update({
      where: { id: submissionId },
      data: {
        draftOrderId: draftOrderGid,
        status: "created",
      },
    });
  } catch {
    // ignore (e.g. submission not found)
  }

  return new Response("ok", { status: 200 });
}
