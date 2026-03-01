# Transcriptor Implementation Manifest

## Current Task Scope
- Add robust upscale preset system based on instruction files.
- Built-in presets must be available by default with high-quality baseline instructions.
- User can create up to 3 custom presets via popup (name + system instruction).
- Custom presets appear in preset menu and can be deleted (X button behavior).
- Upscale pipeline must output only improved transcript text (no quotes/comments/markdown).
- Preserve source language in upscale output.

## UX/Behavior Requirements
- Overlay status flow: Recording (red) -> Transcribing (blue) -> Upscaling (purple) -> Done/Paste.
- Queue behavior must remain deterministic for multiple recordings with/without upscale.
- If upscale enabled, insertion/paste must use final upscaled text only.
- Add third dropdown in overlay quick settings for upscale preset.
- Keep quick settings open/close non-intrusive (no extra window popups).

## Main UI Requirements
- Color semantics:
  - Auto Transcribe toggle active state: blue.
  - Upscale toggle active state: purple.
  - Dropdown subtle tint by domain (provider/model blue tint, upscale purple tint).
- Record view should keep three vertical blocks: Live, Result, Upscale.
- Add copy button in Result block and Upscale block.
- Slightly increase main app window width for better 3-column layout.

## Technical Deliverables
- Backend:
  - Preset file storage and CRUD endpoints.
  - Upscale endpoint by preset ID.
- Frontend:
  - Preset loader/creator/deleter with modal popup.
  - Persist selected preset in user config.
  - Integrate upscale step before final paste/save.
- Overlay:
  - Add upscale status/visual and third quick-settings dropdown.

