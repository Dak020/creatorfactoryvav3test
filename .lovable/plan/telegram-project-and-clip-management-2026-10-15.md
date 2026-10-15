# Telegram project and clip management

## Outcome
Let a linked Telegram user create projects, send video clips into a selected project, and assign the same DNA role, category, and hook placement used in the web app.

## First implementation pass
1. Add `/newproject` plus natural-language project creation, using the existing project schema and verified link ownership.
2. Accept Telegram video/document uploads, validate type and size, store them in the existing private media bucket, and create the matching media asset record.
3. Guide the user through project selection and the app's current DNA role, category, and placement choices with inline buttons; allow skipping optional tags.
4. Keep the current render and VA commands unchanged; add clear upload/creation confirmations and recoverable errors.

## Validation
Check exact schema/defaults and current app category choices, test callback lengths and ownership checks, verify the app build, and review the webhook path for failure cleanup and secret safety. Avoid adding tables or new dependencies unless existing schema cannot support the flow.

## Technical details
- Make changes in the current TanStack public Telegram webhook and its Telegram helper/VA modules.
- Use the existing `media` bucket and `media_assets` fields; clean up stored files if the asset record cannot be created.
- Bound file sizes to Telegram download limits and an explicit safe maximum; reject unsupported files with a helpful Telegram reply.