import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Is TikTok's own posting API configured for this workspace? */
export const socialStatusFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { tiktokConfigured } = await import("@/lib/social/tiktok.server");
    return { configured: tiktokConfigured() };
  });

/** Connected TikTok accounts for the signed-in user, straight from our table. */
export const listSocialAccountsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("social_accounts")
      .select(
        "id, account_handle, display_name, avatar_url, status, profile_identifier, created_at",
      )
      .eq("platform", "tiktok")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { accounts: data ?? [] };
  });

/**
 * Starts a direct TikTok connect: returns TikTok's own authorize URL plus a
 * one-time state value. The browser opens the URL in a popup and must send
 * the same state back to `completeTikTokConnectFn` — that round trip is the
 * CSRF guard, since the popup is same-origin and can hold it in memory/
 * sessionStorage between the two calls.
 */
export const startTikTokConnectFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { authorizeUrl, tiktokRedirectUri } = await import("@/lib/social/tiktok.server");
    const { randomUUID } = await import("node:crypto");
    const state = randomUUID();
    const redirectUri = await tiktokRedirectUri();
    const connectUrl = authorizeUrl(redirectUri, state);
    return { connectUrl, state, redirectUri };
  });

/**
 * Exchanges the code TikTok's callback received for tokens, fetches the
 * account's profile, and upserts it into `social_accounts` with
 * `driver: "tiktok"`. Called from the popup once it lands on our callback
 * route, so it still runs with the signed-in user's session.
 */
export const completeTikTokConnectFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { code: string }) => input)
  .handler(async ({ data, context }) => {
    const { exchangeCode, fetchProfile, tiktokRedirectUri } = await import("@/lib/social/tiktok.server");

    const redirectUri = await tiktokRedirectUri();
    const tokens = await exchangeCode(data.code, redirectUri);
    console.log("[TikTok OAuth] Granted scopes:", tokens.scope);
    if (!tokens.openId || !tokens.accessToken || !tokens.refreshToken) {
      throw new Error("TikTok did not return a complete set of tokens.");
    }
    const profile = await fetchProfile(tokens.accessToken);

    const { error } = await context.supabase.from("social_accounts").upsert(
      {
        user_id: context.userId,
        platform: "tiktok",
        driver: "tiktok",
        profile_identifier: tokens.openId,
        open_id: tokens.openId,
        account_handle: profile.username ?? tokens.openId,
        display_name: profile.displayName,
        avatar_url: profile.avatarUrl,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_expires_at: tokens.expiresAt,
        scopes: tokens.scope,
        status: "connected",
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform,profile_identifier" },
    );
    if (error) throw new Error(error.message);

    return { ok: true, handle: profile.username ?? tokens.openId };
  });

/**
 * Refreshes profile info (handle, display name, avatar) for every directly-
 * connected TikTok account, using each account's stored refresh token.
 * Marks an account as needing reconnection if TikTok rejects it outright.
 */
export const syncSocialAccountsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("social_accounts")
      .select("id, driver, access_token, refresh_token")
      .eq("platform", "tiktok")
      .eq("driver", "tiktok");
    if (error) throw new Error(error.message);

    const { refreshTokens, fetchProfile } = await import("@/lib/social/tiktok.server");

    let synced = 0;
    for (const row of rows ?? []) {
      if (!row.refresh_token) continue;
      try {
        const tokens = await refreshTokens(row.refresh_token);
        const profile = await fetchProfile(tokens.accessToken);
        const { error: updErr } = await context.supabase
          .from("social_accounts")
          .update({
            account_handle: profile.username ?? row.id,
            display_name: profile.displayName,
            avatar_url: profile.avatarUrl,
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken,
            token_expires_at: tokens.expiresAt,
            scopes: tokens.scope,
            status: "connected",
            last_synced_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        if (!updErr) synced++;
      } catch (e) {
        console.error("[tiktok] refresh/sync failed for account", row.id, e);
        await context.supabase
          .from("social_accounts")
          .update({ status: "needs_reconnect" })
          .eq("id", row.id);
      }
    }
    return { synced };
  });

/** Removes the account here. TikTok has no confirmed v2 revoke endpoint, so this is local-only. */
export const disconnectSocialAccountFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("social_accounts")
      .select("id")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("Account not found.");

    await context.supabase.from("social_accounts").delete().eq("id", row.id);
    return { ok: true };
  });
