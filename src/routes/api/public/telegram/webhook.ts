import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual, randomUUID } from "crypto";
import { tg, sendText, answerCallback, botToken, botKey, webhookSecret, BOT_USERNAME } from "@/lib/telegram/bot.server";
import { handleTelegramConversationalMessage } from "@/lib/telegram/va-agent.server";
import { HOOK_PLACEMENTS, MEDIA_CATEGORIES } from "@/lib/constants";
import {
  clipProjectCallback,
  clipTagCallback,
  expandTelegramId,
  isDnaRole,
  isHookPlacement,
  isMediaCategory,
  isSupportedTelegramVideo,
  MAX_TELEGRAM_VIDEO_BYTES,
} from "@/lib/telegram/clip-intake";

function esc(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function deleteMessage(chatId: number, messageId: number) {
  try {
    await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (err) {
    console.error("deleteMessage error:", err);
  }
}

async function editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: unknown) {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    };
    if (replyMarkup) body["reply_markup"] = replyMarkup;
    await tg("editMessageText", body);
  } catch (err) {
    console.error("editMessageText error:", err);
  }
}

function buildStyleSelectKeyboard(projectId: string) {
  return {
    inline_keyboard: [
      [
        { text: "⚡ Single Clip Cut", callback_data: `st:s:${projectId}` },
        { text: "🧬 Clip DNA (Multi-Cut)", callback_data: `st:d:${projectId}` },
      ],
      [{ text: "❌ Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function buildDurationKeyboard(projectId: string, style: "s" | "d") {
  return {
    inline_keyboard: [
      [
        { text: "6s", callback_data: `dur:${style}:6:${projectId}` },
        { text: "8s (Default)", callback_data: `dur:${style}:8:${projectId}` },
      ],
      [
        { text: "10s", callback_data: `dur:${style}:10:${projectId}` },
        { text: "15s", callback_data: `dur:${style}:15:${projectId}` },
      ],
      [{ text: "« Back to Style", callback_data: `step_proj:${projectId}` }],
      [{ text: "❌ Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function buildBatchSelectKeyboard(projectId: string, style: "s" | "d", duration: number) {
  return {
    inline_keyboard: [
      [
        { text: "1x Single", callback_data: `bat:${style}:${duration}:1:${projectId}` },
        { text: "3x Variants", callback_data: `bat:${style}:${duration}:3:${projectId}` },
        { text: "5x Variants", callback_data: `bat:${style}:${duration}:5:${projectId}` },
      ],
      [{ text: "« Back to Duration", callback_data: `st:${style}:${projectId}` }],
      [{ text: "❌ Cancel", callback_data: "cancel_wizard" }],
    ],
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _supabase: any = null;
function db() {
  if (!_supabase) {
    const key = process.env["SUPABASE_SERVICE_ROLE_KEY"] || process.env["SUPABASE_PUBLISHABLE_KEY"]!;
    _supabase = createClient(process.env["SUPABASE_URL"]!, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _supabase;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatCmd(cmd: string, data: any): string {
  if (cmd === "status") {
    return [
      "<b>📊 Status</b>",
      `Projects: ${data?.projects ?? 0}`,
      `Clips: ${data?.clips ?? 0}`,
      `Videos made: ${data?.videos ?? 0}`,
      `Posts scheduled: ${data?.scheduled ?? 0}`,
      `Published: ${data?.published ?? 0}`,
      `Failed posts: ${data?.failed ?? 0}`,
    ].join("\n");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[];
  if (!rows.length) return "Nothing here yet.";
  if (cmd === "clips")
    return (
      "<b>🎬 Latest clips</b>\n" +
      rows
        .map(
          (r) =>
            `• ${esc(r.filename)} — ${Number(r.duration ?? 0).toFixed(1)}s · ${esc(r.dna_role ?? "no role")}`,
        )
        .join("\n")
    );
  if (cmd === "trends")
    return (
      "<b>🔥 Trending sounds</b>\n" +
      rows
        .map((r, i) => `${i + 1}. ${esc(r.title)}${r.author ? ` — ${esc(r.author)}` : ""}`)
        .join("\n")
    );
  return (
    "<b>🗓 Upcoming posts</b>\n" +
    rows
      .map(
        (r) =>
          `• ${new Date(r.scheduled_for).toUTCString().slice(0, 22)} UTC — ${esc(r.status)}`,
      )
      .join("\n")
  );
}

export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const token = botToken();
          const expectedSecret = webhookSecret(token);
          const actualSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
          if (!safeEqual(actualSecret, expectedSecret)) {
            return new Response("Unauthorized", { status: 401 });
          }
          const key = botKey(token);

          const update = await request.json();

          // 1. Handle Messages (Text, Slash commands, Video/Document uploads)
          if (update.message) {
            const msg = update.message;
            const chatId = msg.chat?.id;
            const text = (msg.text || msg.caption || "").trim();

            if (!chatId) return Response.json({ ok: true });

            if (text.startsWith("/start")) {
              const code = (text.split(" ")[1] || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);

              if (!code) {
                await sendText(
                  chatId,
                  `👋 <b>Welcome to Creative Factory Bot!</b>\n\nTo link your account, open Settings in the web app and click Connect Telegram.`,
                );
                return Response.json({ ok: true });
              }

              const { data: ok, error } = await db().rpc("telegram_link", {
                _code: code,
                _chat_id: chatId,
                _key: key,
              });
              await sendText(
                chatId,
                !error && ok
                  ? `✅ <b>Connected! I'm your Creative Factory VA.</b>\n\n` +
                    `You can now:\n` +
                    `• Drop any video file here to upload clips & tag DNA\n` +
                    `• Type /newproject [Name] to create projects\n` +
                    `• Type /render to start creating videos\n` +
                    `• Or just chat with me naturally!`
                  : `❌ That link expired. Open Settings in the app and tap Connect Telegram again.`,
              );
              return Response.json({ ok: true });
            }

            // Auth verification for all bot operations
            const { data: link } = await db()
              .from("telegram_links")
              .select("user_id")
              .eq("chat_id", chatId)
              .maybeSingle();

            if (!link?.user_id) {
              await sendText(
                chatId,
                `👋 <b>Welcome!</b> To manage projects, upload clips, and render videos, connect your account first from Settings → Integrations in the web app.`,
              );
              return Response.json({ ok: true });
            }

            const userId = link.user_id;

            // ----------------------------------------------------
            // A. Video / Document Upload Processing
            // ----------------------------------------------------
            const videoPayload =
              msg.video ||
              (msg.document &&
              isSupportedTelegramVideo(msg.document.file_name || "", msg.document.mime_type || "")
                ? msg.document
                : null);

            if (msg.document && !videoPayload) {
              await sendText(chatId, "📎 Please send an MP4 or MOV video clip. Other document types aren't supported.");
              return Response.json({ ok: true });
            }

            if (videoPayload) {
              const fileSize = videoPayload.file_size || 0;
              if (fileSize > MAX_TELEGRAM_VIDEO_BYTES) {
                await sendText(
                  chatId,
                  `⚠️ <b>File too large:</b> Telegram Bot API limits direct uploads to 20MB. Please compress your clip or upload via the web app Media library.`,
                );
                return Response.json({ ok: true });
              }

              await sendText(chatId, `⏳ <b>Receiving video clip...</b> Uploading to your Creative Factory storage.`);

              let storagePath: string | null = null;
              let storageUploaded = false;
              let assetCreated = false;
              try {
                // 1. Get File Path from Telegram
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const fileInfo: any = await tg("getFile", { file_id: videoPayload.file_id });
                if (!fileInfo?.file_path) {
                  throw new Error("Could not retrieve file path from Telegram.");
                }

                // 2. Download File buffer
                const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
                const fileRes = await fetch(fileUrl);
                if (!fileRes.ok) {
                  throw new Error(`Failed to download clip: HTTP ${fileRes.status}`);
                }
                const arrayBuf = await fileRes.arrayBuffer();
                if (arrayBuf.byteLength === 0 || arrayBuf.byteLength > MAX_TELEGRAM_VIDEO_BYTES) {
                  throw new Error("The downloaded clip is empty or exceeds Telegram's 20 MB upload limit.");
                }
                const buffer = Buffer.from(arrayBuf);

                // 3. Upload to Supabase Storage Bucket ('media')
                const assetId = randomUUID();
                const origName =
                  msg.document?.file_name ||
                  (fileInfo.file_path.toLowerCase().endsWith(".mov") ? `clip_${Date.now()}.mov` : `clip_${Date.now()}.mp4`);
                const extension = origName.match(/\.(mp4|m4v|mov|qt)$/i)?.[1]?.toLowerCase() || "mp4";
                storagePath = `${userId}/${assetId}.${extension}`;

                const { error: uploadErr } = await db().storage
                  .from("media")
                  .upload(storagePath, buffer, {
                    contentType: msg.document?.mime_type || "video/mp4",
                    upsert: false,
                  });

                if (uploadErr) {
                  throw new Error(`Storage upload failed: ${uploadErr.message}`);
                }
                storageUploaded = true;

                // 4. Create base media asset record
                const duration = Number(videoPayload.duration) || 0;
                const width = Number(videoPayload.width) || 1080;
                const height = Number(videoPayload.height) || 1920;

                const { data: newAsset, error: assetErr } = await db()
                  .from("media_assets")
                  .insert({
                    id: assetId,
                    user_id: userId,
                    storage_path: storagePath,
                    filename: origName,
                    duration,
                    width,
                    height,
                    size_bytes: fileSize,
                    category: "Other",
                    hook_placement: "top",
                    dna_role: null,
                    tags: ["telegram-upload"],
                    allowed_speeds: [1, 1.5, 2],
                  })
                  .select("id")
                  .single();

                if (assetErr || !newAsset) {
                  await db().storage.from("media").remove([storagePath]);
                  storageUploaded = false;
                  throw new Error(`Database record creation failed: ${assetErr?.message}`);
                }
                assetCreated = true;

                // 5. Select Project to assign
                const { data: userProjects } = await db()
                  .from("projects")
                  .select("id, name")
                  .eq("user_id", userId)
                  .order("created_at", { ascending: false })
                  .limit(6);

                if (!userProjects || userProjects.length === 0) {
                  await sendText(
                    chatId,
                    `🎬 <b>Clip uploaded.</b> Create a project with /newproject, or keep this clip unassigned while we set its tags.`,
                    buildClipDnaKeyboard(assetId),
                  );
                  return Response.json({ ok: true });
                }

                if (userProjects.length === 1) {
                  // Auto-assign to the only project and proceed directly to DNA Role wizard
                  const singleProj = userProjects[0];
                  const { error: assignError } = await db()
                    .from("media_assets")
                    .update({ project_id: singleProj.id })
                    .eq("id", assetId)
                    .eq("user_id", userId);
                  if (assignError) throw new Error(`Project assignment failed: ${assignError.message}`);

                  await sendText(
                    chatId,
                    `🎬 <b>Clip saved to "${esc(singleProj.name)}".</b> What role should it play in Clip DNA?`,
                    buildClipDnaKeyboard(assetId),
                  );
                  return Response.json({ ok: true });
                }

                // Multiple projects -> Ask user to choose project first
                const projKeyboard = {
                  inline_keyboard: [
                    ...userProjects.map((p: { id: string; name: string }) => [
                      { text: `📁 ${p.name.slice(0, 45)}`, callback_data: clipProjectCallback(assetId, p.id) },
                    ]),
                    [{ text: "📁 Keep Unassigned", callback_data: clipProjectCallback(assetId, "skip") }],
                  ],
                };

                await sendText(
                  chatId,
                  `🎬 <b>Clip Received!</b> Which project should this clip belong to?`,
                  projKeyboard,
                );
                return Response.json({ ok: true });
              } catch (upErr: any) {
                console.error("Video intake error:", upErr);
                if (storageUploaded && !assetCreated && storagePath) {
                  const { error: cleanupError } = await db().storage.from("media").remove([storagePath]);
                  if (cleanupError) console.error("Telegram clip cleanup failed:", cleanupError.message);
                }
                await sendText(
                  chatId,
                  `❌ <b>Upload failed:</b> ${esc(upErr?.message || "Could not process video")}`,
                );
                return Response.json({ ok: true });
              }
            }

            // ----------------------------------------------------
            // B. Slash Commands
            // ----------------------------------------------------
            const simple = text.toLowerCase().replace(/^\//, "").replace(/@.*$/, "");

            if (simple.startsWith("newproject ") || simple.startsWith("new ")) {
              const projName = text.replace(/^\/(newproject|new)\s+/i, "").trim();
              if (!projName) {
                await sendText(chatId, `Usage: <code>/newproject [Project Name]</code>\nExample: <code>/newproject Glow Serum Drops</code>`);
                return Response.json({ ok: true });
              }

              const { data: newProj, error: pErr } = await db()
                .from("projects")
                .insert({
                  user_id: userId,
                  name: projName,
                  platform: "tiktok",
                  content_style: "ugc",
                  status: "active",
                  videos_to_generate: 10,
                })
                .select("id, name")
                .single();

              if (pErr || !newProj) {
                await sendText(chatId, `❌ Could not create project: ${esc(pErr?.message || "Unknown error")}`);
                return Response.json({ ok: true });
              }

              const keyboard = {
                inline_keyboard: [
                  [{ text: "🎬 Start Render", callback_data: `step_proj:${newProj.id}` }],
                  [{ text: "📁 View Projects", callback_data: "cmd_projects" }],
                ],
              };

              await sendText(
                chatId,
                `✨ <b>Project Created!</b>\n\n` +
                  `• <b>Name:</b> ${esc(newProj.name)}\n` +
                  `• <b>Format:</b> 9:16 Vertical (TikTok/Reels)\n\n` +
                  `Send video clips here to add footage, or ask me: <i>"Write 5 viral hooks for ${esc(newProj.name)}"</i>`,
                keyboard,
              );
              return Response.json({ ok: true });
            }

            if (simple === "ping") {
              const startTransit = msg.date ? Math.max(0, Date.now() - msg.date * 1000) : 0;
              const dbStart = performance.now();
              await db().from("telegram_links").select("user_id").eq("chat_id", chatId).maybeSingle();
              const dbMs = Math.round(performance.now() - dbStart);

              let apiMs = 0;
              try {
                const apiStart = performance.now();
                await tg("getMe", {});
                apiMs = Math.round(performance.now() - apiStart);
              } catch (err) {
                console.error("tg getMe error:", err);
              }

              const statusLines = [
                "🏓 <b>Pong!</b> Connection is healthy & active.",
                "",
                `• <b>Telegram API Speed:</b> <b>${apiMs} ms</b>`,
                `• <b>Database Latency:</b> <b>${dbMs} ms</b>`,
                startTransit > 0 ? `• <b>Inbound Transit:</b> ~${startTransit} ms` : null,
                `• <b>Account Status:</b> ✅ Linked`,
                `• <b>Bot:</b> @${BOT_USERNAME}`,
                `• <b>Server Time:</b> ${new Date().toISOString().slice(11, 19)} UTC`,
              ]
                .filter(Boolean)
                .join("\n");

              await sendText(chatId, statusLines);
              return Response.json({ ok: true });
            }

            if (["status", "clips", "trends", "schedule"].includes(simple)) {
              const { data: res, error } = await db().rpc("telegram_command", {
                _chat_id: chatId,
                _key: key,
                _cmd: simple,
              });
              if (error || !res?.linked) {
                await sendText(chatId, `⚠️ Please connect your account first from Settings in the app.`);
              } else {
                await sendText(chatId, formatCmd(simple, res.data));
              }
              return Response.json({ ok: true });
            }

            if (text === "/render" || text === "/projects") {
              const { data: projects } = await db()
                .from("projects")
                .select("id, name")
                .eq("user_id", userId)
                .order("created_at", { ascending: false })
                .limit(8);

              if (!projects || projects.length === 0) {
                await sendText(
                  chatId,
                  `No projects found. Create one by typing:\n<code>/newproject [Project Name]</code>`,
                );
                return Response.json({ ok: true });
              }

              const keyboard = {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                inline_keyboard: projects.map((p: any) => [
                  { text: `📁 ${p.name}`, callback_data: `step_proj:${p.id}` },
                ]),
              };

              await sendText(chatId, `🎬 <b>Select a Project to Render:</b>`, keyboard);
              return Response.json({ ok: true });
            }

            if (text === "/help") {
              await sendText(
                chatId,
                `🤖 <b>Creative Factory Bot Commands:</b>\n\n` +
                  `• /newproject [Name] - Create a new video project\n` +
                  `• /render - Start the 4-step Render Wizard\n` +
                  `• /projects - List your active projects\n` +
                  `• /ping - Test connection speed\n` +
                  `• /status, /clips, /trends, /schedule\n\n` +
                  `📤 <b>Direct Upload:</b> Drop any video or document here to auto-save & tag DNA roles!\n\n` +
                  `💬 <i>Or talk naturally: "Create project Summer Drops", "Write hooks for perfume", or "Render 3 DNA clips for Perfume"</i>`,
              );
              return Response.json({ ok: true });
            }

            // Conversational AI VA for natural language requests
            await handleTelegramConversationalMessage({
              chatId,
              userId,
              text,
              supabase: db(),
            });

            return Response.json({ ok: true });
          }

          // ----------------------------------------------------
          // 2. Handle Inline Button Callbacks
          // ----------------------------------------------------
          if (update.callback_query) {
            const cb = update.callback_query;
            const callbackId = cb.id;
            const chatId = cb.message?.chat?.id;
            const messageId = cb.message?.message_id;
            const data = cb.data || "";

            if (!chatId || !messageId) {
              await answerCallback(callbackId);
              return Response.json({ ok: true });
            }

            // Cancel Wizard
            if (data === "cancel_wizard") {
              await answerCallback(callbackId, "Cancelled");
              await editMessageText(
                chatId,
                messageId,
                `❌ <i>Render wizard cancelled. Type /render to start again.</i>`,
              );
              return Response.json({ ok: true });
            }

            // Clip Tagging Step 1: Assign Project
            if (data.startsWith("cproj:")) {
              const [, encodedAssetId, encodedProjectId] = data.split(":");
              const assetId = expandTelegramId(encodedAssetId || "");
              const targetProjId = expandTelegramId(encodedProjectId || "");
              const { data: asset } = await db()
                .from("media_assets")
                .select("id")
                .eq("id", assetId)
                .eq("user_id", userId)
                .maybeSingle();
              if (!asset) {
                await answerCallback(callbackId, "This clip isn't linked to your account.");
                return Response.json({ ok: true });
              }

              if (targetProjId && targetProjId !== "skip") {
                const { data: project } = await db()
                  .from("projects")
                  .select("id")
                  .eq("id", targetProjId)
                  .eq("user_id", userId)
                  .maybeSingle();
                if (!project) {
                  await answerCallback(callbackId, "Choose one of your own projects.");
                  return Response.json({ ok: true });
                }
                const { error } = await db()
                  .from("media_assets")
                  .update({ project_id: targetProjId })
                  .eq("id", assetId)
                  .eq("user_id", userId);
                if (error) throw new Error(`Project assignment failed: ${error.message}`);
              }
              await answerCallback(callbackId);

              await editMessageText(
                chatId,
                messageId,
                `🧬 <b>Clip DNA role</b>\n\nWhere should this footage appear during a sequenced edit?`,
                buildClipDnaKeyboard(assetId),
              );
              return Response.json({ ok: true });
            }

            // Clip Tagging Step 2: Assign DNA Role
            if (data.startsWith("cdna:")) {
              const [, encodedAssetId, role] = data.split(":");
              const assetId = expandTelegramId(encodedAssetId || "");
              if (!isDnaRole(role || "")) {
                await answerCallback(callbackId, "That DNA choice isn't valid.");
                return Response.json({ ok: true });
              }
              const { data: asset } = await db()
                .from("media_assets")
                .select("id")
                .eq("id", assetId)
                .eq("user_id", userId)
                .maybeSingle();
              if (!asset) {
                await answerCallback(callbackId, "This clip isn't linked to your account.");
                return Response.json({ ok: true });
              }
              await answerCallback(callbackId);

              const roleValue = role === "none" ? null : role;
              const { error } = await db()
                .from("media_assets")
                .update({ dna_role: roleValue })
                .eq("id", assetId)
                .eq("user_id", userId);
              if (error) throw new Error(`DNA role update failed: ${error.message}`);

              const placementKeyboard = {
                inline_keyboard: MEDIA_CATEGORIES.map((category) => [
                  { text: category, callback_data: clipTagCallback("ccat", assetId, category) },
                ]),
              };

              await editMessageText(
                chatId,
                messageId,
                `🏷 <b>Clip category</b>\n\nChoose the same category used in the Media Library.`,
                placementKeyboard,
              );
              return Response.json({ ok: true });
            }

            if (data.startsWith("ccat:")) {
              const [, encodedAssetId, category] = data.split(":");
              const assetId = expandTelegramId(encodedAssetId || "");
              if (!isMediaCategory(category || "")) {
                await answerCallback(callbackId, "That category isn't valid.");
                return Response.json({ ok: true });
              }
              const { data: asset } = await db()
                .from("media_assets")
                .select("id")
                .eq("id", assetId)
                .eq("user_id", userId)
                .maybeSingle();
              if (!asset) {
                await answerCallback(callbackId, "This clip isn't linked to your account.");
                return Response.json({ ok: true });
              }
              await answerCallback(callbackId);
              const { error } = await db()
                .from("media_assets")
                .update({ category })
                .eq("id", assetId)
                .eq("user_id", userId);
              if (error) throw new Error(`Category update failed: ${error.message}`);

              const placementKeyboard = {
                inline_keyboard: [
                  ...HOOK_PLACEMENTS.map((placement) => [
                    { text: `${placement.label} — ${placement.hint}`, callback_data: clipTagCallback("cplc", assetId, placement.value) },
                  ]),
                  [{ text: "Skip", callback_data: clipTagCallback("cplc", assetId, "skip") }],
                ],
              };
              await editMessageText(chatId, messageId, `📌 <b>Hook text placement</b>\n\nChoose where on this clip hook text should sit.`, placementKeyboard);
              return Response.json({ ok: true });
            }

            // Clip Tagging Step 3: Assign Hook Placement & Finish
            if (data.startsWith("cplc:")) {
              const [, encodedAssetId, placement] = data.split(":");
              const assetId = expandTelegramId(encodedAssetId || "");
              if (placement !== "skip" && !isHookPlacement(placement || "")) {
                await answerCallback(callbackId, "That placement isn't valid.");
                return Response.json({ ok: true });
              }
              const { data: ownedAsset } = await db()
                .from("media_assets")
                .select("id")
                .eq("id", assetId)
                .eq("user_id", userId)
                .maybeSingle();
              if (!ownedAsset) {
                await answerCallback(callbackId, "This clip isn't linked to your account.");
                return Response.json({ ok: true });
              }
              await answerCallback(callbackId, "Clip saved!");

              if (placement !== "skip") {
                const { error } = await db()
                  .from("media_assets")
                  .update({ hook_placement: placement })
                  .eq("id", assetId)
                  .eq("user_id", userId);
                if (error) throw new Error(`Placement update failed: ${error.message}`);
              }

              const { data: asset } = await db()
                .from("media_assets")
                .select("project_id, filename, dna_role, category, hook_placement")
                .eq("id", assetId)
                .eq("user_id", userId)
                .maybeSingle();

              let projName = "Unassigned";
              let clipCount = 1;
              let dnaTaggedCount = 0;

              if (asset?.project_id) {
                const [pRes, allClipsRes] = await Promise.all([
                  db().from("projects").select("name").eq("id", asset.project_id).maybeSingle(),
                  db().from("media_assets").select("id, dna_role").eq("project_id", asset.project_id),
                ]);
                projName = pRes.data?.name || "Project";
                const allClips = allClipsRes.data || [];
                clipCount = allClips.length;
                dnaTaggedCount = allClips.filter((c: any) =>
                  ["start", "middle", "end"].includes(c.dna_role || ""),
                ).length;
              }

              await editMessageText(
                chatId,
                messageId,
                `✅ <b>Clip Tagged & Ready!</b>\n\n` +
                  `• <b>File:</b> ${esc(asset?.filename)}\n` +
                  `• <b>Project:</b> ${esc(projName)}\n` +
                  `• <b>DNA Role:</b> ${esc(asset?.dna_role ? asset.dna_role.toUpperCase() : "None")}\n` +
                  `• <b>Category:</b> ${esc(asset?.category || "Other")}\n` +
                  `• <b>Placement:</b> ${esc(asset?.hook_placement || "top")}\n\n` +
                  `📊 <b>Project Status:</b> ${clipCount} total clip(s) · ${dnaTaggedCount} DNA-tagged\n\n` +
                  `<i>Ready to render? Type /render to create a batch!</i>`,
              );
              return Response.json({ ok: true });
            }

            // Step 1: Choose Style
            if (data.startsWith("step_proj:") || data.startsWith("step_style:")) {
              const projectId = data.split(":")[1];
              await answerCallback(callbackId);

              const { data: project } = await db()
                .from("projects")
                .select("name")
                .eq("id", projectId)
                .maybeSingle();

              const projectName = project?.name || "Project";
              const keyboard = buildStyleSelectKeyboard(projectId);

              await editMessageText(
                chatId,
                messageId,
                `⚙️ <b>Step 1: Choose Style for ${esc(projectName)}</b>\n\n` +
                  `• <b>Single Clip Cut:</b> One hook paired with one best clip\n` +
                  `• <b>Clip DNA:</b> Multi-clip sequenced edit with speed ramps`,
                keyboard,
              );
              return Response.json({ ok: true });
            }

            // Step 2: Choose Duration
            if (data.startsWith("st:") || data.startsWith("step_dur:")) {
              const parts = data.split(":");
              const style = parts[1] === "d" ? "d" : "s";
              const projectId = parts[2];
              await answerCallback(callbackId);

              const keyboard = buildDurationKeyboard(projectId, style);
              await editMessageText(
                chatId,
                messageId,
                `⏱ <b>Step 2: Choose Target Duration</b>\n\n` +
                  `How long should each video be? (TikTok & Reels sweet spot is 8s)`,
                keyboard,
              );
              return Response.json({ ok: true });
            }

            // Step 3: Choose Batch Quantity
            if (data.startsWith("dur:") || data.startsWith("step_bat:")) {
              const parts = data.split(":");
              const style = parts[1] === "d" ? "d" : "s";
              const duration = parseInt(parts[2], 10) || 8;
              const projectId = parts[3];
              await answerCallback(callbackId);

              const keyboard = buildBatchSelectKeyboard(projectId, style, duration);
              await editMessageText(
                chatId,
                messageId,
                `📦 <b>Step 3: Choose Batch Quantity</b>\n\n` +
                  `Generate multiple unique variations with randomized hooks & speed ramping\n\n` +
                  (style === "d"
                    ? `<i>Note: For DNA batches, a style preview is sent here first. Once approved, the remaining batch renders automatically.</i>`
                    : `<i>Note: Single batches render all variants straight into your library.</i>`),
                keyboard,
              );
              return Response.json({ ok: true });
            }

            // Step 4: Choose Audio Soundtrack
            if (data.startsWith("bat:") || data.startsWith("step_aud:")) {
              const parts = data.split(":");
              const style = parts[1] === "d" ? "d" : "s";
              const duration = parseInt(parts[2], 10) || 8;
              const batch = parseInt(parts[3], 10) || 1;
              const projectId = parts[4];
              await answerCallback(callbackId);

              const { data: link } = await db()
                .from("telegram_links")
                .select("user_id")
                .eq("chat_id", chatId)
                .maybeSingle();

              let libraryTracks: { id: string; name: string }[] = [];
              if (link?.user_id) {
                const { data: tracks } = await db()
                  .from("trending_audios")
                  .select("id, title")
                  .or(`user_id.eq.${link.user_id},user_id.is.null`)
                  .order("created_at", { ascending: false })
                  .limit(3);
                libraryTracks = (tracks || []).map((t: { id: string; title: string }) => ({
                  id: t.id,
                  name: t.title,
                }));
              }

              const prefix = `aud:${style}:${duration}:${batch}:${projectId}`;
              const keyboard: { inline_keyboard: { text: string; callback_data: string }[][] } = {
                inline_keyboard: [
                  [{ text: "🎵 VA Trending Sound (Auto-pick)", callback_data: `${prefix}:tr` }],
                  [{ text: "🔇 Silent (No music)", callback_data: `${prefix}:si` }],
                  [{ text: "🗣 Original Clip Audio (Keep voice)", callback_data: `${prefix}:or` }],
                ],
              };

              for (const t of libraryTracks) {
                keyboard.inline_keyboard.push([
                  { text: `🎶 ${t.name.slice(0, 24)}`, callback_data: `${prefix}:lb_${t.id.slice(0, 8)}` },
                ]);
              }

              keyboard.inline_keyboard.push([
                { text: `« Back to Quantity`, callback_data: `dur:${style}:${duration}:${projectId}` },
              ]);
              keyboard.inline_keyboard.push([{ text: "❌ Cancel", callback_data: "cancel_wizard" }]);

              await editMessageText(
                chatId,
                messageId,
                `🎵 <b>Step 4: Select Soundtrack</b>\n\n` +
                  `Choose the audio layer for your ${duration}s ${style === "d" ? "Clip DNA" : "Single"} render:`,
                keyboard,
              );
              return Response.json({ ok: true });
            }

            // Execution Trigger
            if (data.startsWith("aud:")) {
              const parts = data.split(":");
              const style = parts[1] === "d" ? "d" : "s";
              const duration = parseInt(parts[2], 10) || 8;
              const batchTotal = parseInt(parts[3], 10) || 1;
              const projectId = parts[4];
              const audioChoice = parts[5];
              await answerCallback(callbackId, "Preparing render queue...");

              await deleteMessage(chatId, messageId);

              const { data: link } = await db()
                .from("telegram_links")
                .select("user_id")
                .eq("chat_id", chatId)
                .maybeSingle();

              if (!link?.user_id) {
                await sendText(chatId, "⚠️ User link not found. Please connect in Settings.");
                return Response.json({ ok: true });
              }

              const { data: project } = await db()
                .from("projects")
                .select("name")
                .eq("id", projectId)
                .maybeSingle();
              const projectName = project?.name || "Project";

              let withAudio = false;
              let soundtrackUrl: string | null = null;
              let audioLabel = "None";

              if (audioChoice === "or") {
                withAudio = true;
                audioLabel = "Original clip audio";
              } else if (audioChoice === "tr") {
                const { data: tr } = await db()
                  .from("trending_audios")
                  .select("id, title, audio_url")
                  .or(`user_id.eq.${link.user_id},user_id.is.null`)
                  .order("created_at", { ascending: false })
                  .limit(1)
                  .maybeSingle();

                if (tr && tr.audio_url) {
                  soundtrackUrl = tr.audio_url;
                  audioLabel = tr.title || "Trending audio";
                } else {
                  withAudio = true;
                  audioLabel = "Original clip audio (no trending sound found)";
                }
              } else if (audioChoice && audioChoice.startsWith("lb_")) {
                const trackIdPrefix = audioChoice.slice(3);
                const { data: tr } = await db()
                  .from("trending_audios")
                  .select("id, title, audio_url")
                  .or(`user_id.eq.${link.user_id},user_id.is.null`)
                  .ilike("id", `${trackIdPrefix}%`)
                  .limit(1)
                  .maybeSingle();

                if (tr && tr.audio_url) {
                  soundtrackUrl = tr.audio_url;
                  audioLabel = tr.title || "Library audio";
                }
              }

              const [hooksRes, clipsRes] = await Promise.all([
                db()
                  .from("hooks")
                  .select("id, text")
                  .eq("project_id", projectId)
                  .order("created_at", { ascending: false }),
                db()
                  .from("media_assets")
                  .select("id, filename, duration, storage_path, dna_role")
                  .eq("project_id", projectId),
              ]);

              const hooks = hooksRes.data || [];
              const clips = clipsRes.data || [];

              if (hooks.length === 0) {
                await sendText(
                  chatId,
                  `❌ Project "${esc(projectName)}" has no hooks. Add hooks in the web app or ask me: "Write 5 viral hooks for ${esc(projectName)}".`,
                );
                return Response.json({ ok: true });
              }

              const isDna = style === "d";

              if (isDna) {
                const tagged = clips.filter((c: { dna_role?: string | null }) =>
                  ["start", "middle", "end"].includes(c.dna_role || ""),
                );
                if (tagged.length < 2) {
                  await sendText(
                    chatId,
                    `❌ Project "${esc(projectName)}" needs at least 2 DNA-tagged clips (Start/Middle/End) for Clip DNA. Upload clips here to tag them.`,
                  );
                  return Response.json({ ok: true });
                }
              } else {
                if (clips.length === 0) {
                  await sendText(
                    chatId,
                    `❌ Project "${esc(projectName)}" has no media clips. Send video clips here to add them!`,
                  );
                  return Response.json({ ok: true });
                }
              }

              const chosenHook = hooks[0]!;
              const primaryClip = isDna
                ? clips.find((c: { dna_role?: string | null }) => c.dna_role === "start") || clips[0]!
                : clips[0]!;

              const { data: recipe, error: recErr } = await db()
                .from("video_recipes")
                .insert({
                  user_id: link.user_id,
                  project_id: projectId,
                  hook_id: chosenHook.id,
                  media_asset_id: primaryClip.id,
                  duration,
                  overlay_text: chosenHook.text,
                  overlay_position: "top",
                  font_size: 48,
                  background_color: isDna ? "#000000_dna" : "#00000000",
                  text_color: "#ffffff",
                  width: 1080,
                  height: 1920,
                })
                .select("id")
                .single();

              if (recErr || !recipe) {
                await sendText(chatId, `❌ Failed to create recipe: ${esc(recErr?.message || "Unknown error")}`);
                return Response.json({ ok: true });
              }

              const styleValue = isDna ? (batchTotal > 1 ? `dna:batch=${batchTotal}` : "dna") : "single";
              const { error: hintErr } = await db()
                .from("render_job_hints")
                .insert({
                  recipe_id: recipe.id,
                  user_id: link.user_id,
                  with_audio: withAudio,
                  soundtrack_url: soundtrackUrl,
                  audio_label: audioLabel,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  clip_ids: clips.map((c: any) => c.id),
                  style: styleValue,
                });
              if (hintErr) {
                console.error("render_job_hints insert failed", hintErr);
                await sendText(chatId, `❌ Failed to store render settings: ${esc(hintErr.message)}`);
                return Response.json({ ok: true });
              }

              const { data: job, error: jobErr } = await db()
                .from("render_jobs")
                .insert({
                  user_id: link.user_id,
                  project_id: projectId,
                  recipe_id: recipe.id,
                  status: "queued",
                  progress: 0,
                })
                .select("id")
                .single();

              if (jobErr || !job) {
                await sendText(chatId, `❌ Could not queue render: ${esc(jobErr?.message || "Unknown error")}`);
                return Response.json({ ok: true });
              }

              if (!isDna && batchTotal > 1) {
                for (let i = 1; i < batchTotal; i++) {
                  const nextHook = hooks[i % hooks.length] || chosenHook;
                  const nextClip = clips[i % clips.length] || primaryClip;
                  const { data: extraRec } = await db()
                    .from("video_recipes")
                    .insert({
                      user_id: link.user_id,
                      project_id: projectId,
                      hook_id: nextHook.id,
                      media_asset_id: nextClip.id,
                      duration,
                      overlay_text: nextHook.text,
                      overlay_position: i % 2 === 0 ? "top" : "middle",
                      font_size: 48,
                      background_color: "#00000000",
                      text_color: "#ffffff",
                      width: 1080,
                      height: 1920,
                    })
                    .select("id")
                    .single();

                  if (extraRec) {
                    await db()
                      .from("render_job_hints")
                      .insert({
                        recipe_id: extraRec.id,
                        user_id: link.user_id,
                        with_audio: withAudio,
                        soundtrack_url: soundtrackUrl,
                        audio_label: audioLabel,
                        clip_ids: [primaryClip.id],
                        style: "single",
                      });
                    await db().from("render_jobs").insert({
                      user_id: link.user_id,
                      project_id: projectId,
                      recipe_id: extraRec.id,
                      status: "queued",
                      progress: 0,
                    });
                  }
                }
              }

              const modeLabel = isDna ? "🧬 Clip DNA (Multi-clip)" : "⚡ Single Clip";
              await sendText(
                chatId,
                `🚀 <b>Render Queued for ${esc(projectName)}!</b>\n\n` +
                  `• <b>Mode:</b> ${modeLabel}\n` +
                  `• <b>Duration:</b> ${duration}s\n` +
                  `• <b>Batch:</b> ${batchTotal}x\n` +
                  `• <b>Sound:</b> ${esc(audioLabel)}\n` +
                  `• <b>Hook:</b> "${esc(chosenHook.text)}"\n\n` +
                  `<i>Keep your web app tab open — frames are rendering now!</i>`,
              );
              return Response.json({ ok: true });
            }

            // Approve Preview & Save Single
            if (data.startsWith("approve:")) {
              const jobId = data.split(":")[1];
              await answerCallback(callbackId, "Approved! Saving to library...");

              const { data: link } = await db()
                .from("telegram_links")
                .select("user_id")
                .eq("chat_id", chatId)
                .maybeSingle();
              if (!link?.user_id) return Response.json({ ok: true });

              const { data: job } = await db()
                .from("render_jobs")
                .select("*")
                .eq("id", jobId)
                .maybeSingle();
              if (!job || !job.output_url) {
                await sendText(chatId, "Job record not found.");
                return Response.json({ ok: true });
              }

              const { data: recipe } = await db()
                .from("video_recipes")
                .select("*")
                .eq("id", job.recipe_id)
                .maybeSingle();

              const thumbPath = job.output_url.replace(/\.[^/.]+$/, ".jpg");
              const { error: insErr } = await db()
                .from("generated_videos")
                .insert({
                  user_id: link.user_id,
                  project_id: job.project_id,
                  render_job_id: job.id,
                  recipe_id: job.recipe_id,
                  hook_id: recipe?.hook_id ?? null,
                  media_asset_id: recipe?.media_asset_id ?? null,
                  hook_text: recipe?.overlay_text ?? null,
                  output_url: job.output_url,
                  thumbnail_url: thumbPath,
                  duration: recipe?.duration ?? 8,
                  status: "completed",
                });

              if (insErr) {
                await sendText(chatId, `❌ Save failed: ${esc(insErr.message)}`);
                return Response.json({ ok: true });
              }

              await db()
                .from("render_jobs")
                .update({ status: "completed", completed_at: new Date().toISOString() })
                .eq("id", job.id);

              await sendText(
                chatId,
                `✅ <b>Video Approved & Saved!</b>\n\nYour video is now in your project library and ready to schedule.`,
              );
              return Response.json({ ok: true });
            }

            // Approve DNA Style Preview & Spawn Batch
            if (data.startsWith("apprv_b:")) {
              const jobId = data.split(":")[1];
              await answerCallback(callbackId, "Style approved! Generating batch...");

              const { data: link } = await db()
                .from("telegram_links")
                .select("user_id")
                .eq("chat_id", chatId)
                .maybeSingle();
              if (!link?.user_id) return Response.json({ ok: true });

              const { data: job } = await db()
                .from("render_jobs")
                .select("*")
                .eq("id", jobId)
                .maybeSingle();
              if (!job || !job.output_url) {
                await sendText(chatId, "Job record not found.");
                return Response.json({ ok: true });
              }

              const { data: recipe } = await db()
                .from("video_recipes")
                .select("*")
                .eq("id", job.recipe_id)
                .maybeSingle();
              await db()
                .from("render_jobs")
                .update({ status: "completed", completed_at: new Date().toISOString() })
                .eq("id", job.id);

              const { data: hint } = await db()
                .from("render_job_hints")
                .select("*")
                .eq("recipe_id", job.recipe_id)
                .maybeSingle();
              let batchTotal = 3;
              if (hint?.style && hint.style.includes("batch=")) {
                const match = hint.style.match(/batch=(\d+)/);
                if (match) batchTotal = parseInt(match[1], 10);
              }
              const remaining = Math.max(1, batchTotal);

              const [hooksRes, clipsRes] = await Promise.all([
                db()
                  .from("hooks")
                  .select("id, text")
                  .eq("project_id", job.project_id)
                  .order("created_at", { ascending: false }),
                db()
                  .from("media_assets")
                  .select("id, dna_role")
                  .eq("project_id", job.project_id)
                  .in("dna_role", ["start", "middle", "end"]),
              ]);

              const hooks = hooksRes.data || [];
              const clips = clipsRes.data || [];

              for (let i = 0; i < remaining; i++) {
                const hook = hooks[(i + 1) % hooks.length] || hooks[0] || { id: null, text: recipe?.overlay_text ?? "" };
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const openerClip = clips.find((c: any) => c.dna_role === "start") || clips[0] || { id: recipe?.media_asset_id };

                const { data: newRecipe } = await db()
                  .from("video_recipes")
                  .insert({
                    user_id: link.user_id,
                    project_id: job.project_id,
                    hook_id: hook.id,
                    media_asset_id: openerClip.id,
                    duration: recipe?.duration ?? 8,
                    overlay_text: hook.text,
                    overlay_position: i % 2 === 0 ? "top" : "middle",
                    font_size: 48,
                    background_color: "#000000_dna",
                    text_color: "#ffffff",
                    width: 1080,
                    height: 1920,
                  })
                  .select("id")
                  .single();

                if (newRecipe) {
                  await db()
                    .from("render_job_hints")
                    .insert({
                      recipe_id: newRecipe.id,
                      user_id: link.user_id,
                      with_audio: hint?.with_audio ?? false,
                      soundtrack_url: hint?.soundtrack_url ?? null,
                      audio_label: hint?.audio_label ?? "Same audio",
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      clip_ids: clips.map((c: any) => c.id),
                      style: "dna:auto",
                    });

                  await db().from("render_jobs").insert({
                    user_id: link.user_id,
                    project_id: job.project_id,
                    recipe_id: newRecipe.id,
                    status: "queued",
                    progress: 0,
                  });
                }
              }

              await sendText(
                chatId,
                `🚀 <b>Style Approved!</b>\n\nStyle locked in — <b>${remaining} new DNA variants</b> are now rendering!`,
              );
              return Response.json({ ok: true });
            }

            // Re-roll preview
            if (data.startsWith("reroll:")) {
              const jobId = data.split(":")[1];
              await answerCallback(callbackId, "Re-rolling a new combination...");
              const { data: link } = await db()
                .from("telegram_links")
                .select("user_id")
                .eq("chat_id", chatId)
                .maybeSingle();
              const { data: job } = await db().from("render_jobs").select("*").eq("id", jobId).maybeSingle();
              if (!link?.user_id || !job || job.user_id !== link.user_id) {
                await sendText(chatId, "Preview not found.");
                return Response.json({ ok: true });
              }
              await db().from("render_jobs").update({ status: "cancelled" }).eq("id", job.id);
              await db().from("render_jobs").insert({
                user_id: link.user_id,
                project_id: job.project_id,
                recipe_id: job.recipe_id,
                status: "queued",
                progress: 0,
              });
              await sendText(
                chatId,
                "🔄 <b>Re-rolling!</b> A new cut is rendering — keep the app open. The new preview will arrive here.",
              );
              return Response.json({ ok: true });
            }

            // Discard Preview
            if (data.startsWith("discard:")) {
              const jobId = data.split(":")[1];
              await answerCallback(callbackId, "Discarded");
              await db().from("render_jobs").update({ status: "cancelled" }).eq("id", jobId);
              await sendText(chatId, "🗑 Preview discarded. Type /render to start a new batch.");
              return Response.json({ ok: true });
            }

            await answerCallback(callbackId);
            return Response.json({ ok: true });
          }

          return Response.json({ ok: true });
        } catch (error) {
          console.error("Telegram webhook processing failed:", error);
          return Response.json({ ok: false }, { status: 500 });
        }
      },
    },
  },
});
