# Psalm101

A privacy-first, 100% on-device Chromium browser extension that filters explicit and suggestive images and
video frames before they appear.

- **Zero external servers:** every image and video frame is evaluated locally in your browser using WebGPU,
  WebNN, or multi-threaded WebAssembly — nothing leaves your device.
- **No flash before filtering:** images stay hidden (preserving page layout) until approved, and readable
  videos play through a short pre-buffered overlay with synchronized delayed audio.
- **Four filtering levels:** *Very strict*, *Strict*, *Moderate*, and *Relaxed* — changing levels re-evaluates
  open pages instantly without reloading.
- **Video toggle & parent lock:** turn video filtering off on slower computers, lock settings with a local
  parent password, or enforce policies via browser enterprise/MDM configuration (`managed_schema.json`).

## On-device model & licensing

| Component | License |
|---|---|
| Extension source code | Apache-2.0 |
| Classifier backbone (`models/accurate.fp16.onnx`, fine-tuned from Google `SigLIP2-B/16 @256`) | Apache-2.0 |
| Runtime (`vendor/`, ONNX Runtime Web `1.30.0`) | MIT |

Full third-party notices live in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt).

## Install (Chrome, Brave, Edge, Arc)

1. Download and unzip the latest release ZIP from **GitHub Releases** (or install from the Chrome Web Store
   once published).
2. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
3. Enable **Developer mode**, click **Load unpacked**, and select the unzipped folder.
4. Pin **Psalm101** to the toolbar and pick your filtering level.

## How it covers web pages

| Media type | How Psalm101 handles it |
|---|---|
| `<img>`, `srcset` / `<picture>`, lazy-loaded, `data:` / `blob:`, cross-origin SVGs, `<iframe>` | Hidden before paint until classified on-device |
| `<video>` (same-origin, CORS, MSE such as YouTube) | Pre-buffered ~0.4 s behind live (adapting up to 1.4 s on slower hardware); frames checked ~5×/sec and shown only when bracketing checks are clean. Can be toggled off via **Filter video**. |
| CSS `background-image` | Checked by URL as elements scroll into view; flagged backgrounds are cleared |
| `<canvas>`, cross-origin unreadable `<video>`, unverified CSS backgrounds | Checked via visible-tab capture backstop only when such candidates exist on screen |
| DRM video (e.g. Netflix) | Not readable by browser extensions; use the streaming service's own parental controls |

## Privacy & Chrome Web Store documentation

- **Privacy Policy:** [docs/privacy.html](docs/privacy.html)
- **Chrome Web Store Permission Justifications & Reviewer Notes:** [docs/cws-justifications.md](docs/cws-justifications.md)
