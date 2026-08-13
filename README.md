# TouchFree Fluid Body — webcam body tracking drives a WebGL fluid simulation

A person walks up and their whole upper body stirs glowing smoke: **webcam
motion capture** from [TouchFree](https://bigskyinteractive.com) driving
Pavel Dobryakov's celebrated **WebGL fluid simulation** — no touch, no
wearables, no code changes needed to retune it. This is a shipping TouchFree
content page, published whole as the reference for building **2D
body-landmark web apps** on TouchFree's data stream.

## How it works

```
webcam
  → TouchFree (MediaPipe body tracking, solved and smoothed on the sender)
  → body_state over WebSocket: 2D landmark positions, ~30 Hz
      payload.keypoints = [[x_px, y_px, z_rel, visibility] × 33]
      COCO-17 order in the first 17 (0 nose, 5/6 shoulders, 9/10 wrists,
      11/12 hips …), mirrored pixel space, sized by frame_w / frame_h
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

## The fastest way to build your own: hand it to your AI

Give your AI assistant this repo and one sentence:

> Read `README.md`, `fluid_config.json` and `body_pointers.js`, then build
> me a web page where body landmarks from TouchFree drive <my effect>.

`body_pointers.js` is a complete, documented reference for consuming the 2D
stream: connecting, the keypoint contract, visibility gating, drop/teleport
handling, and frame-rate-independent smoothing — every landmark-consuming
page needs the same mechanics, whatever it paints.

## Running it

Serve this folder from a TouchFree machine (it ships as a TouchFree content
page) or any static server on the same origin as the TouchFree WebSocket
(`ws://<host>:8080/ws`), and open `index.html`. The page shows "step into
view" until a body is tracked. Bench tuning without editing files:
`?vel=1500&curl=40&gravity=-8&emit=ring` — URL parameters override the JSON.

## Files

| File | Role |
|---|---|
| `index.html` | Page shell; hides the tuning GUI for kiosk use |
| `body_pointers.js` | TouchFree integration: WebSocket, landmark pointers, particle emission |
| `fluid_config.json` | Every setting: landmarks, particles, simulation dials |
| `script.js` | The WebGL fluid simulation (upstream, promo material removed, otherwise untouched) |
| `dat.gui.min.js`, `LDR_LLL1_0.png` | Upstream's GUI library and dithering texture |

## Also from TouchFree

Driving **rigged 3D characters** (Mixamo, VRM, VMC protocol) instead of 2D
effects: see
[touchfree-receiver-kit](https://github.com/BigSkyInteractive/touchfree-receiver-kit).

## Keywords

WebGL fluid simulation · body tracking · webcam motion capture · MediaPipe ·
interactive installation · kiosk experience · particle effects · COCO
keypoints · markerless mocap · digital signage · touchless interactive

## License

MIT — see [LICENSE](LICENSE). The fluid simulation is
[Pavel Dobryakov's WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)
(MIT, 2017), included with his promo material removed and the simulation
itself untouched; the TouchFree integration and configuration are Big Sky
Interactive's additions under the same license.
