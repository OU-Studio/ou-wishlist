import prisma from "../../db.server";
import { authenticate } from "../../shopify.server";

export async function loader({ request }: { request: Request }) {
  // This will either:
  // - redirect you into OAuth (good)
  // - or return a session (also good)
  const { session } = await authenticate.admin(request);

  const rows = await prisma.session.findMany({
    where: { shop: session.shop },
    select: { id: true, shop: true, isOnline: true, scope: true, expires: true, accessToken: true },
    take: 20,
  });

  return Response.json({
    authedShop: session.shop,
    sessionRowCount: rows.length,
    rows: rows.map((r) => ({
      id: r.id,
      shop: r.shop,
      isOnline: r.isOnline,
      scope: r.scope,
      expires: r.expires,
      hasAccessToken: !!r.accessToken,
    })),
  });
}
