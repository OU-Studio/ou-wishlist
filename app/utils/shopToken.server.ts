// app/utils/shopToken.server.ts
import prisma from "../db.server";

const SKEW_MS = 2 * 60 * 1000;

type OfflineSession = {
  id: string;
  shop: string;
  accessToken: string | null;
  expires: Date | null;
  refreshToken: string | null;
  refreshTokenExpires: Date | null;
};

async function refreshOffline(shop: string, refreshToken: string) {
  const body = new URLSearchParams({
    client_id: process.env.SHOPIFY_API_KEY!,
    client_secret: process.env.SHOPIFY_API_SECRET!,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Refresh failed (${res.status}): ${text}`);

  const json = JSON.parse(text) as {
    access_token: string;
    expires_in: number;
    refresh_token: string;
    refresh_token_expires_in: number;
  };

  const now = Date.now();
  const expires = new Date(now + json.expires_in * 1000);
  const refreshTokenExpires = new Date(now + json.refresh_token_expires_in * 1000);

  // Find the offline row and update it (refresh token rotates)
  const id = `offline_${shop}`; // adjust if your ids differ
  await prisma.session.update({
    where: { id },
    data: {
      accessToken: json.access_token,
      expires,
      refreshToken: json.refresh_token,
      refreshTokenExpires,
    },
  });

  return json.access_token;
}

export async function getAdminAccessToken(shop: string) {
  const s = await prisma.session.findFirst({
    where: { shop, isOnline: false },
    select: {
      id: true,
      shop: true,
      accessToken: true,
      expires: true,
      refreshToken: true,
      refreshTokenExpires: true,
    },
  }) as OfflineSession | null;

  if (!s?.accessToken) return null;

  const now = Date.now();
  const exp = s.expires?.getTime?.() ?? 0;

  // If we have a refresh token, keep the access token valid
  if (s.refreshToken) {
    if (!exp || exp - now <= SKEW_MS) {
      return await refreshOffline(shop, s.refreshToken);
    }
    return s.accessToken;
  }

  // No refresh token: token must still be valid
  if (exp && exp <= now) return null;
  return s.accessToken;
}
