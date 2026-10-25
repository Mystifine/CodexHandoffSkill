# Roblox UI handoffs

Read this with the "UI work" section of SKILL.md when a task builds Roblox UI. It adds the Roblox-specific brief content, verification method and Studio pitfalls.

## Brief additions
- **Breakpoints:** desktop 1280x720, landscape phone 844x390, portrait phone 375x667. Mobile HUDs must clear the Roblox topbar (`ScreenInsets.TopbarSafeInsets` is the safe strip beside it), the thumbstick (bottom left) and the jump button (bottom right).
- **Build into a container:** the module builds under a caller-sized GuiObject (or the named controller's ScreenGui) and relayouts when its AbsoluteSize changes. That lets it render at every breakpoint without Play.
- **Touch targets:** at least 44 px. If the project scales UI with a UIScale (for example 0.85 on phones), size controls in logical points so they still reach 44 px at the phone scale; buttons with a pressed-lip effect lose the lip height from the hit face.
- **Verification line for the brief:** "Mount in a temporary `StarterGui` ScreenGui in Edit, render each breakpoint and key state, run `references/roblox-ui-audit.luau` (or the project's copy) on each with 0 issues, take a screenshot of each for the contact sheet, then remove the mount and leave Studio in Edit."

## Rendering and auditing in Studio (MCP)
- `screen_capture` in Edit shows `StarterGui` contents but not `CoreGui`. Mount under a temporary StarterGui ScreenGui and remove it afterwards; StarterGui is often user-owned, so never leave anything behind.
- The audit (`references/roblox-ui-audit.luau`): send its source followed by your own lines to `execute_luau`, e.g. `local root = Audit.mount(Vector2.new(844, 390))`, build the UI into `root`, `return Audit.run(root)`, and finally `Audit.cleanup()`. In Client Play: `Audit.run(game.Players.LocalPlayer.PlayerGui.<Gui>, { ignore = { "<full-bleed backdrop>" } })`. It reports text that doesn't fit, text that extends past its parent, small touch targets, and anything outside the root. It cannot judge taste.
- `require` caches per ModuleScript instance. To test freshly synced code (e.g. Rojo), clone the ModuleScript (or its folder), require the clone, and destroy it.
- `execute_luau` gets its own module instances: requiring a running game's service from the command context returns a fresh, empty copy. To change live server state in Play, insert a real `Script` whose source does the work.
- Studio's device emulator cannot be switched from scripts, and injected mouse clicks don't reach buttons while touch is emulated. For phone-size checks, render into a phone-sized container instead, or ask the user to toggle the emulator and tap.

## Pitfalls
- **Studio in the background stops rendering 3D:** the world and every ViewportFrame show blank while the GUI still draws. Keep Studio in the foreground during UI work and reviews; blank portraits are an environment problem, not a code bug.
- **UIGridLayout children ignore `Rotation`:** rotate a child inside each grid cell, or place items manually.
- **`TextFits` only measures text against its own label:** a label wider than its parent (ribbons, stamps, chips) still passes. The audit's `textOutsideParent` check catches it.
- **A UIScale on a ScreenGui changes AbsoluteSize:** compute layouts in logical points (`AbsoluteSize / scale`).
- **Luau can't assign to a cast:** `(x :: T).Prop = v` is a parse error; use a local.
