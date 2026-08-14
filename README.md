# TouchFree Fluid Body — webcam body tracking drives a WebGL fluid simulation

A person walks up and their whole upper body stirs glowing smoke: **touchless
body tracking** from [TouchFree](https://bigskyinteractive.com) driving
Pavel Dobryakov's celebrated **WebGL fluid simulation** — no touch, no
wearables, no code changes needed to retune it. This is a shipping TouchFree
content page, published whole as the reference for building **body-landmark
web apps** on TouchFree's data stream.

## How it works

```
webcam
  → TouchFree device (tracks the body, selects one person, smooths, broadcasts)
  → body_state over WebSocket (JSON)
      2D screen landmarks + 3D metric landmarks + solved bone rotations
  → body_pointers.js: each configured landmark becomes a fluid "pointer"
      laying particle trails along its motion
  → script.js: the WebGL fluid simulation (upstream, MIT)
```

Every knob lives in **[`fluid_config.json`](fluid_config.json)** — which
landmarks paint (color, force, dye per body point), the particle behavior
(trail or expanding-ring emission, velocity, smoothing), and the simulation
dials (gravity, vorticity curl, splat radius, dissipation, bloom). The
`_doc` fields inside explain every unit. Retuning the whole experience is
editing one JSON file.

## The data stream

Connect to the TouchFree WebSocket and filter for one message type — that is
the whole integration:

```js
var ws = new WebSocket('ws://<touchfree-host>:8080/ws');
ws.onmessage = function (ev) {
  var msg = JSON.parse(ev.data);
  if (msg.type === 'body_state') usePayload(msg.payload);
};
```

`body_state` arrives at the tracker's cadence (up to ~30 Hz). Your page
renders at 60; interpolate toward the newest sample each frame rather than
drawing the samples raw — `body_pointers.js` shows the mechanics.

One message carries three layers of the same body, so a page can use as much
or as little as it needs:

### 1. 2D screen landmarks — what this page uses

```
payload.frame_w, payload.frame_h   camera frame size in pixels
payload.keypoints                  [[x_px, y_px, z_rel, visibility] × 33]
```

- **Mirrored screen space**: coordinates align with a mirrored on-screen
  view of the person, which is what an installation in front of the user
  wants. Normalize with `x_px / frame_w`, `y_px / frame_h`.
- **33 landmarks, fixed order.** The first 17 are the COCO-17 set, frozen:
  `0 nose, 1/2 eyes, 3/4 ears, 5/6 shoulders, 7/8 elbows, 9/10 wrists,
  11/12 hips, 13/14 knees, 15/16 ankles`. Then
  `17–20 eye corners, 21/22 mouth, 23/24 pinky, 25/26 index, 27/28 thumb,
  29/30 heels, 31/32 foot tips`.
- **An entry may be `null`**: the camera could not see that landmark, so no
  position is claimed for it. The index is kept so numbering holds — guard
  before reading an entry, and treat null as "drop this pointer", never
  "keep painting at the old spot".
- **`visibility` is a 0..1 confidence** per landmark. Gate on it (this page
  uses 0.5) so a half-seen limb doesn't smear garbage across the screen.
- **`z_rel` is relative depth** — unitless, origin near the hips, smaller is
  closer to the camera. Good for cheap depth cues without going to layer 2.
- `payload.keypoints` is an **empty list** when no person is selected.

### 2. 3D metric landmarks — same wire, ready when you want depth

```
payload.pose3d.keypoints_m     [[x, y, z] × 33] in metres
payload.pose3d.distance_m      distance of the person from the camera
payload.pose3d.rotation_deg    [x, y, z] body orientation in degrees
payload.pose3d.reproj_error_px fit quality — large means trust it less
```

`keypoints_m` is a true 3D body in a Unity-style frame: **+x the body's own
right, +y up, +z the way the body faces, in metres**. Same 33 indices, same
`null` rule. This is how you build effects that react to a hand pushing
toward the screen, a person leaning in, or real distances between body
parts — the 2D layer cannot separate "moved left" from "turned".

### 3. Solved bone rotations — for rigged characters

`payload.bones` carries finished **Unity Humanoid bone rotations**
(`HumanBodyBones` names, local quaternions `[x, y, z, w]`, deltas from the
**VRM 1.0 T-pose** — the **VMC protocol's** own vocabulary), frozen as wire
schema **`tf-bones-1`**. Driving a Mixamo / glTF / VRM character with them
is its own project:
[touchfree-receiver-kit](https://github.com/BigSkyInteractive/touchfree-receiver-kit)
has the translation module, the full contract, and a complete demo. (Avatar
software that speaks the standard VMC protocol can instead receive the same
bones over OSC/UDP directly from TouchFree.)

This fluid page uses layer 1 only. A natural upgrade — stronger splats when
a hand drives toward the screen — is layer 2's `z`, and it is already
arriving in every message.

## The settings panel

Press **G** on the page for the tuning panel: every simulation dial, a
checkbox for each of the 33 landmarks, and a **Save** button that writes the
current values back into `fluid_config.json` (Save needs the page to be
served by a TouchFree device; on a plain static host, edit the JSON
directly). URL parameters still override for quick experiments:
`?vel=1500&curl=40&gravity=-8&emit=ring`.

## The fastest way to build your own: hand it to your AI

Give your AI assistant this repo and one sentence:

> Read `README.md`, `fluid_config.json` and `body_pointers.js`, then build
> me a web page where body landmarks from TouchFree drive <my effect>.

`body_pointers.js` is a complete, documented reference for consuming the
stream: connecting, the keypoint contract, visibility gating, drop/teleport
handling, and frame-rate-independent smoothing — every landmark-consuming
page needs the same mechanics, whatever it paints.

## Running it

Serve this folder from a TouchFree machine (it ships as a TouchFree content
page) or any static server on the same origin as the TouchFree WebSocket
(`ws://<host>:8080/ws`), and open `index.html`. The page shows "step into
view" until a body is tracked.

## Files

| File | Role |
|---|---|
| `index.html` | Page shell; panel styling; hides the tuning GUI until G |
| `body_pointers.js` | TouchFree integration: WebSocket, landmark pointers, particle emission, settings panel extras |
| `fluid_config.json` | Every setting: landmarks, particles, simulation dials |
| `script.js` | The WebGL fluid simulation (upstream, promo material removed, otherwise untouched) |
| `dat.gui.min.js`, `LDR_LLL1_0.png` | Upstream's GUI library and dithering texture |

## Also from TouchFree

Driving **rigged 3D characters** (Mixamo, VRM, VMC protocol) instead of 2D
effects: see
[touchfree-receiver-kit](https://github.com/BigSkyInteractive/touchfree-receiver-kit).

## Keywords

WebGL fluid simulation · body tracking · webcam motion capture · VMC
protocol · interactive installation · kiosk experience · particle effects ·
COCO keypoints · 3D body landmarks · markerless mocap · digital signage ·
touchless interactive

## License

MIT — see [LICENSE](LICENSE). The fluid simulation is
[Pavel Dobryakov's WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)
(MIT, 2017), included with his promo material removed and the simulation
itself untouched; the TouchFree integration and configuration are Big Sky
Interactive's additions under the same license.
