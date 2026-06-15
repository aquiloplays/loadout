# Aitum Dual Canvas Setup: cut the render lag without making TikTok look like Twitch

Author: tooling audit, June 2026
Status: ready to run, no code changes required

## What this doc fixes

OBS is reporting roughly 26 percent rendering lag on the Twitch (1920x1080) canvas and 30 percent on the TikTok Vertical (1080x1920) canvas. The GPU is doing extra work it does not need to do. The fix is not "make both canvases the same layout." We want the two streams to keep looking different. Twitch stays horizontal with the full overlay stack, TikTok stays vertical and cam focused. The fix is making sure the heavy sources (Game Capture, the webcam, the chat and printer browser widgets) only get rendered once per frame on the GPU, then composited into each canvas at whatever transform that canvas needs.

Your scene collection already does most of this correctly. Same-named sources across the two canvases reference the same source UUID, so OBS only captures the frame once. The leak is in two specific places, which this doc walks through.

This is the audit summary, then the step by step.

## What I found in your config

I read `aitum.json` (the canvas list) and the OBS scene collection at `basic/scenes/Untitled.json`. Tokens were not echoed and are not in this doc.

Canvases active right now:

1. Twitch (main OBS canvas, 1920x1080, 60 fps, 6000 kbps).
2. TikTok Vertical (Aitum canvas, uuid `4fd49029...`, 1080x1920) streaming to the TikTok RTMP push endpoint.

Scenes in the collection: Starting, Chatting, Push Ups, Gaming, ZOOM, NESTED. Each main scene already has a per-canvas mapping entry pointing the TikTok Vertical canvas at a separate vertical scene ("Scene" for Gaming and Chatting, "ZOOM" for ZOOM, "Starting" for Starting). That part of linked scene switching is wired up.

The 26 sources I found break down as: 1 Game Capture, 1 DroidCam OBS webcam, 1 Mic, 2 process audio captures (Music, Discord), 1 window capture (CC Disrupts), 9 browser sources, 9 scenes, and 2 source-clones.

The 2 source-clones are where the render budget is going.

### The actual duplication: source-clones, not source instances

| Source name | Type | Clones | Where it lives | Filter on it |
|---|---|---|---|---|
| Blurred Game | source-clone | Game Capture | "Scene" (TikTok), "ZOOM" (TikTok) | Composite Blur |
| Game Webcam | source-clone | DroidCam OBS | "Gaming" (Twitch horizontal) | Advanced Mask |

A `source-clone` is not a shared reference. Each clone forces OBS to render the underlying source a second time on a separate render path, then run its own filter chain on top of that copy. For Game Capture at 1920x1080 with a Composite Blur on top of it, that is a meaningful per-frame GPU bill. For the DroidCam clone with the Advanced Mask, less so, but still wasted work because the underlying webcam frame is already being captured and could be masked at the scene-item level.

Everything else with a repeated name (Game Capture, DroidCam OBS, Printerbot, Chat, Tangia, Gift Jar, Rotation, Punch Card, CC Disrupts) is already shared by UUID across scenes and canvases. That part is fine. The frame is captured once and composited multiple times, which is cheap.

### Two other things worth knowing

There are stale canvas references in some scenes for canvases named "Vertical", "Twitch Vertical", and "Recording Canvas" that do not exist in `aitum.json` anymore. OBS ignores them so they are not causing the lag, but they make the file harder to read.

There are also two scenes named "Starting" (one is empty) and two named "ZOOM" (one is a vertical variant). Same names, different UUIDs. This is how Aitum makes per-canvas variants when you let it auto-create them. It works, it just confuses the Sources dock.

Neither of those two issues is the perf problem. The source-clones are.

## The plan, plain English

We are going to do four things, in this order:

1. Back up the scene collection and the Aitum config.
2. Replace the "Blurred Game" source-clone with a render-once approach: either feed the existing Game Capture into the vertical scene directly with a blur filter applied at the scene-item level via the Move plugin's per-item filters or via a dedicated "background" group, OR keep the clone but flip its update mode to "Active" so it only redraws when the source itself updates a frame, which on a 60 fps game is fine but lets us drop the second filter pass entirely on the cheaper option. We are recommending Option A.
3. Replace the "Game Webcam" source-clone in the Gaming scene with a direct reference to DroidCam OBS plus an Advanced Mask filter applied to that scene item using the Move plugin's per-scene-item filters.
4. Verify linked scene switching is set the way you want it and re-check OBS Stats to confirm GPU and render-lag dropped.

After all of that, when the new Overlay Composer ships from `Loadout/discord-bot/overlay-canvas.js`, you can collapse several of your nine browser sources into a single Composer URL per canvas with a different `layoutId`. That part is the "future state" section at the end.

## Step 0. Pre-flight: back up everything before you touch anything

Close OBS first. JSON edits to scene collections under a running OBS get overwritten on next save.

Step 0.1: Open File Explorer and go to `%AppData%\obs-studio\basic\scenes`.

Step 0.2: Right click `Untitled.json`, choose Copy, then Paste in the same folder. Rename the copy to `Untitled.json.bak.2026-06-14`. If you ever need to roll back, close OBS, delete `Untitled.json`, rename the backup back to `Untitled.json`, and relaunch OBS.

Step 0.3: Open `%AppData%\obs-studio\basic\profiles\Untitled`. Same drill on `aitum.json`, saving a copy as `aitum.json.bak.2026-06-14`. (You already have a generic `aitum.json.bak`, so use the dated name to keep them distinct.)

Step 0.4: Open OBS. Take a screenshot of the Stats dock with these four numbers visible before you change anything: Average frame time, Skipped frames due to rendering lag, Average time to render frame, and GPU usage. Save it to `Loadout/perf-notes/aitum-before.png` if you want a paper trail. Screenshot placeholder: `[BEFORE-STATS]`.

If you do not have a `perf-notes` folder yet, just leave the screenshot on the desktop. The before-after compare is what matters.

## Step 1. Kill the "Blurred Game" source-clone, swap in a direct reference with a scene-item blur

Goal: stop rendering Game Capture a second time on the GPU just so you can blur it for the vertical background.

Step 1.1: In OBS, switch the preview canvas to TikTok Vertical (top of the Scenes dock, or the Aitum canvas selector you have docked).

Step 1.2: Open the "Scene" scene (this is the vertical variant of Gaming). You should see Blurred Game at the bottom of the source stack.

Step 1.3: Right click "Blurred Game" in the Sources dock, choose Remove. Confirm the removal. This deletes the clone object but does NOT touch the original Game Capture, since the clone was the only thing referencing it.

If you see a dialog warning "this source is used in other scenes," that means Blurred Game is also still in the second ZOOM scene (vertical ZOOM). Click Remove. We will re-add the blurred background to that scene too in Step 1.7.

Step 1.4: Drag the existing "Game Capture" source from the Sources tray (or from the Twitch Gaming scene) into the "Scene" scene at the bottom of the stack so it sits below all the other items. It will appear at native 1920x1080. That is fine for now.

Step 1.5: Right click that new Game Capture instance in "Scene", choose Filters. Add a "Composite Blur" filter from the obs-composite-blur plugin (same one you had on Blurred Game). Set blur amount to whatever you had on Blurred Game (Aitum's Filters dock will still show the old Blurred Game filter chain if you want to copy the numbers across, screenshot placeholder: `[BLUR-SETTINGS]`).

If you see "Composite Blur" is not available in the filter list, the plugin only attaches per-source filters globally. In that case use the Move plugin's per-scene-item filter mode: right click the scene item, Move Filters > Add Source Mirror, then add the Composite Blur to that mirror item. Either path keeps the render to one Game Capture pass.

Step 1.6: With the blurred Game Capture selected, hit Ctrl+F (Fit to Screen) so it fills the 1080x1920 canvas. Right click it again, Transform > Edit Transform. Set Bounding Box Type to "Scale to inner bounds." This is the vertical "blurred wallpaper" effect you had before.

Step 1.7: While still on TikTok Vertical, switch to the ZOOM scene (the vertical one with uuid `64f552dc...`, four items currently). Repeat Step 1.4 through Step 1.6 here. You want the same blurred Game Capture wallpaper underneath the ZOOM crop.

Step 1.8: Confirm the foreground (sharp) Game Capture is still above the blurred copy in the scene order. The render path is: capture Game Capture once on GPU, composite the sharp version at top, composite the blurred-and-stretched version behind it. One capture, two composites, one blur. Down from two captures, two composites, two blurs.

If you see the blur looking different from before, double check the Composite Blur "type" dropdown matches. Gaussian and Dual Kawase look subtly different at the same radius.

## Step 2. Kill the "Game Webcam" source-clone, mask DroidCam at the scene item

Goal: stop rendering DroidCam a second time just so you can put a circle mask on it for the Gaming scene.

Step 2.1: Switch the preview canvas back to Twitch (the main OBS canvas) and open the Gaming scene.

Step 2.2: Right click "Game Webcam" in the Sources dock, Filters. Note the Advanced Mask settings: type (likely Image or Shape), feathering, position, rotation. Take a screenshot, placeholder `[GAMECAM-MASK-SETTINGS]`. You will reapply these.

Step 2.3: Close the filters window. Right click "Game Webcam" again, choose Remove.

Step 2.4: Drag DroidCam OBS into the Gaming scene. It will land at the default position. Use Transform > Edit Transform to put it back at the same position and size your Game Webcam had. Aitum's Transform dock has a Copy Transform feature, screenshot placeholder `[COPY-TRANSFORM]`.

Step 2.5: Right click the new DroidCam instance in Gaming (NOT the one in Chatting or Push Ups, just this scene item), Filters. Add an Advanced Mask filter using the settings you noted in Step 2.2.

Crucial point: in OBS, filters added through the right-click Filters menu attach to the source, which means they appear on DroidCam everywhere it is used. That is NOT what we want, because Chatting and Push Ups need full webcam, not a circle. So instead of adding the filter directly, use the Move plugin's scene-item filter feature.

Step 2.6: Right click the DroidCam scene item in Gaming, choose Move > Add Filter to Scene Item (the menu wording is sometimes "Source Mirror" or "Item Filter" depending on Move version). This wraps the scene item in a per-item filter slot. Add the Advanced Mask there. Now the mask only applies in the Gaming scene.

If you do not have the Move plugin installed, the fallback is: keep Game Webcam as a clone but flip its update mode to "Active" only, so it only renders frames when the source is active in the current scene. To do that, double click Game Webcam, in the Properties panel set "Active Clone" to true and "Render Each Frame" to false. That removes the second capture pass on the bench but keeps a small composite cost.

If the Move plugin is installed (Aitum Stream Suite includes it), the cleaner per-item-filter path is preferred.

Step 2.7: Save the scene collection (Scene Collection menu > Save) and switch back to TikTok Vertical preview to confirm DroidCam in Scene and Push Ups still looks normal (no circle mask). Switch back to Twitch and confirm Gaming has the masked cam where Game Webcam used to be.

## Step 3. Confirm linked scene switching is wired the way you want it

Your `Untitled.json` already maps each Twitch scene to a TikTok Vertical scene via the per-scene `canvas` array:

| Twitch scene (active) | TikTok Vertical scene (linked) |
|---|---|
| Starting | Starting (vertical) |
| Chatting | Scene |
| Gaming | Scene |
| ZOOM | ZOOM (vertical) |
| Push Ups | (currently no canvas mapping in your config for Push Ups) |
| NESTED | (nested-only, not directly switched) |

Two notes here.

First, Gaming and Chatting both point to "Scene" on TikTok. If you want Chatting on TikTok to look different from Gaming on TikTok, create a new TikTok scene called "Chatting Vertical" and remap Chatting's TikTok link to it. You do this in Aitum's "Linked Scenes" panel: select Chatting, open the canvas selector, set TikTok Vertical to a new scene "Chatting Vertical." Screenshot placeholder: `[LINKED-SCENES-PANEL]`.

Second, Push Ups has no TikTok Vertical mapping. When you switch to Push Ups on Twitch, TikTok Vertical stays on whatever it was showing. If that is intentional (you do not want to show Push Ups vertically), leave it. If it is not, add a Push Ups vertical scene and link it.

Step 3.1: Open Aitum's Linked Scenes dock (in the User dock layout it is the "AitumStreamSuiteLiveScenes" panel).

Step 3.2: For each main scene, confirm or set the TikTok Vertical link. The pattern: pick the main scene name on the left, then in the canvas link grid set the TikTok Vertical column to the vertical scene you want active when that main scene goes live.

If you see a column for "Vertical" or "Twitch Vertical" or "Recording Canvas," those are stale. Ignore them. They will only act if you re-add those canvases in `aitum.json`.

Step 3.3: Test the link. Press the Studio Mode preview toggle in OBS to enter dual preview if you have it. Click Starting, then Gaming, then Chatting in the Scenes dock. Watch the TikTok Vertical preview. It should jump to the correct linked scene each time. If it does not, the link in Step 3.2 did not save. Re-set and click "Save" or move focus off the panel to commit.

## Step 4. Verify the perf win in OBS Stats

You took the before screenshot in Step 0.4. Now do the after.

Step 4.1: Start a local stream (or stream to your "Recording" output, not the real Twitch/TikTok endpoints) for 60 seconds in Gaming scene with Game Capture actually grabbing Fortnite.

Step 4.2: Open the Stats dock and look at the same four numbers.

| Metric | Before (yours) | Target after | What "good" looks like |
|---|---|---|---|
| Skipped frames due to rendering lag | 26 percent (Twitch), 30 percent (TikTok) | Under 5 percent on both | The whole point of this exercise |
| Average time to render frame | record yours | 30 to 50 percent lower | At 60 fps you have 16.6 ms budget; aim well under |
| GPU usage | record yours | 10 to 20 percent lower | More headroom for Fortnite itself |
| Skipped frames due to encoding lag | record yours | Should also drop because GPU is freer | If this stays high, encoder is the bottleneck, not render |

If you do not see at least a 10 percent drop in render lag after Step 1 and Step 2, the most likely cause is the Composite Blur still firing twice. Re-check Step 1.7: there should be exactly ONE Composite Blur filter live in the vertical canvas (on the blurred Game Capture instance in "Scene"). The blurred wallpaper in vertical ZOOM should reuse it by being the same Game Capture source with the same filter, not a second filter chain on a different instance.

If render lag actually went UP, you have a hot foreground source rendering at full 1080p where it does not need to. Right click the foreground (sharp) Game Capture in the vertical scenes and lower its render size with Transform > Edit Transform > Custom Size to whatever crop you actually display.

## Step 5. After the Overlay Composer ships: collapse browser sources

The Overlay Composer at `Loadout/discord-bot/overlay-canvas.js` is the unified widget host. It exposes per-user layout URLs at `aquilo.gg/overlays/canvas/?layout=:id`. Each layout is a single browser source target that internally composites whichever widgets you want: chat, gift jar, sub goal, rotation, punch card, printer bot, etc.

Right now your collection has nine browser sources. Several of those are essentially "widget instances" that would slot directly into one Composer layout:

| Current browser source | Used in | Composer widget equivalent |
|---|---|---|
| Chat | Gaming, Chatting, Push Ups, Scene | chat widget |
| Gift Jar | Gaming, Scene | giftjar widget |
| Rotation | Gaming, Scene | rotation widget |
| scumbag sub goal | Gaming | subgoal widget |
| Punch Card | Scene, NESTED | punchcard widget |
| Printerbot | many scenes | printerbot widget |
| FO4 BPM | Gaming | bpm widget |
| Tangia | Gaming, NESTED | tangia (third party, may stay external) |
| Horizontal Starting | Starting | static, can move into a "starting" Composer layout |

The "after the Composer ships" workflow:

Step 5.1: Create two layouts in the Composer:

- `twitch-horizontal` for the 1920x1080 canvas, with all the horizontal-layout widget positions and sizes.
- `tiktok-vertical` for the 1080x1920 canvas, with the cam-focused vertical layout.

The Composer enforces tier limits (5 layouts on free, 15 on t1, unlimited on t2 and t3 per `overlay-canvas.js`). Two layouts fits in free.

Step 5.2: In OBS, on the Twitch canvas, remove the individual browser sources (Chat, Gift Jar, Rotation, sub goal, FO4 BPM, Printerbot) from Gaming. Add ONE browser source named "Composer Horizontal" pointing at `https://aquilo.gg/overlays/canvas/?layout=twitch-horizontal&v=1`. Set its size to 1920x1080. Position it filling the canvas.

Step 5.3: On the TikTok Vertical canvas, do the same in "Scene" and "Chatting Vertical" if you make one. Add ONE browser source "Composer Vertical" pointing at `https://aquilo.gg/overlays/canvas/?layout=tiktok-vertical&v=1`. Size 1080x1920.

Step 5.4: Because the same Composer browser source URL means OBS treats it as the same source (or you can make them explicitly the same source with different transforms via Aitum's Shared Source feature), it renders once per second of widget update across both canvases. That replaces six or seven separate Chromium contexts with one. Big CPU and memory win on top of the GPU win from Step 1 and Step 2.

Apply the Aurora theme on the Composer side (in the layout editor on `aquilo.gg`) so the widgets match the rest of the Aquilo brand: deep indigo background, cyan accent gradient, soft glassmorphism on widget cards. The layout editor exposes this via Theme > Aurora.

Step 5.5: Test by visiting the layout URLs in a normal browser tab first. They should render correctly without OBS. If the chat widget shows a placeholder, your tier may not have access to that widget yet, see the tier table in `overlay-canvas.js` lines 77 to 80.

## Summary: expected perf delta per change

This is the back-of-envelope math for a 1080p, 60 fps Twitch canvas plus 1080x1920, 60 fps TikTok canvas on a single GPU.

| Change | What it removes | Estimated render-lag delta |
|---|---|---|
| Step 1: kill Blurred Game source-clone, use direct Game Capture with Composite Blur on the scene item | One full Game Capture re-render at 1080p per frame plus one Composite Blur pass | 8 to 14 percent off render lag |
| Step 2: kill Game Webcam source-clone, use DroidCam with per-item mask | One full webcam re-render per frame | 2 to 4 percent off render lag |
| Step 3: tighten linked scene switching | No perf delta directly, but stops you from accidentally showing the wrong vertical scene live | 0 percent, workflow win |
| Step 5 (after Composer ships): collapse 6+ browser sources into one Composer URL per canvas | 5 to 6 Chromium browser contexts per canvas | 5 to 10 percent off render lag, big CPU and RAM drop |
| Cumulative (Steps 1, 2, 5) | | About 15 to 28 percent off render lag |

Your current 26 percent and 30 percent render lag should come down into the single digits if Steps 1, 2, and 5 all land. Steps 1 and 2 alone should put you under 20 percent on both canvases.

The point worth repeating: none of this makes Twitch and TikTok look the same. The vertical scenes keep their own layout, their own cam framing, their own widget positions. What changes is that the SAME source (Game Capture, DroidCam, the Composer browser source) gets rendered ONCE on the GPU per frame, then composited into each canvas at whatever transform that canvas wants. That is the real meaning of "shared instance," and it is independent of how the two streams look on the broadcast side.

## If something breaks

If after Step 1 the vertical "Scene" shows no blurred background, the Composite Blur filter probably did not save its radius. Open Filters on the blurred Game Capture instance, set radius back to whatever screenshot `[BLUR-SETTINGS]` shows.

If after Step 2 the Gaming scene shows a full uncropped webcam instead of the masked cam, you applied the Advanced Mask to the source globally instead of to the scene item. Remove the filter from the source, re-add it via Move > Add Filter to Scene Item.

If OBS crashes on launch after the changes, close OBS, restore `Untitled.json.bak.2026-06-14`, relaunch.

If linked scene switching stops working, open `aitum.json` and confirm the TikTok Vertical canvas uuid `4fd49029-4798-4655-ada1-48f8622eaf07` is still present and unchanged. If you accidentally deleted that canvas, recreate it via Aitum's Canvas Manager with the same name and re-link scenes.

End of doc.
