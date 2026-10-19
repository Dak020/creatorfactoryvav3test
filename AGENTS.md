<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

Telegram webhook registration must derive the stable project host from the active preview or runtime project ID, so remixes do not keep calling the source project.

Keep Telegram clip-intake validation and callback encoding in a browser-safe shared utility so webhook behavior can be tested independently of server-only integrations.
