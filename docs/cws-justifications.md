# Chrome Web Store Submission & Permission Justifications

Ready-to-paste text for the **Chrome Web Store Developer Dashboard** (`v0.3.1`).

---

## Public URLs

- **Privacy Policy URL:** `https://benpbolton.github.io/psalm101-extension/privacy.html`
- **Homepage URL:** `https://benpbolton.github.io/psalm101-extension/`
- **Source Repository:** `https://github.com/benpbolton/psalm101-extension`

---

## Store Listing Description

> Psalm101 filters explicit and suggestive images and video frames on web pages before they appear — 100% locally on your device.
>
> **Private by design**
> Every check runs directly inside your browser using an on-device neural network (WebGPU, WebNN, or WebAssembly). No images, video frames, URLs, or browsing history are ever sent to external servers.
>
> **Key features**
> - **Hidden before paint:** Images remain invisible (while preserving page layout) until checked locally, preventing unwanted flashes.
> - **Buffered video filtering:** Playing videos are pre-buffered behind a short synchronized delay and checked continuously, with a one-click **Filter video** switch for slower computers.
> - **Four instant strictness levels:** Choose *Very strict*, *Strict*, *Moderate*, or *Relaxed*. Changing levels re-evaluates already-checked images immediately without refreshing the page.
> - **Parent password & browser policy:** Lock settings with a local password or deploy centrally via Chrome / ChromeOS enterprise managed policy (`managed_schema.json`).
> - **Open source:** Full source code and third-party notices (Apache-2.0 / MIT) are publicly auditable on GitHub.

---

## Privacy Practices Tab

### 1. Single Purpose Description

> Filters explicit and suggestive images and video frames on web pages locally on the user's device before they are displayed.

### 2. Permission Justifications

- **`storage`**
  > Persists the user's selected filtering level (0–3), video-filtering toggle, and optional salted SHA-256 parent-lock password hash locally in `chrome.storage.local`, stores temporary unlock expiry in `chrome.storage.session`, and reads optional administrator/parental policy overrides from `chrome.storage.managed`.

- **`offscreen`**
  > Hosts the local ONNX Runtime Web inference engine (`engine.html` / `engine.js`) with WebGPU, WebNN, and WebAssembly support to classify images and video frames entirely on-device. Manifest V3 service workers cannot access WebGPU/DOM APIs (`OffscreenCanvas` / WebGPU device adapters) required to run the bundled neural network locally.

- **`<all_urls>` host permissions**
  > Required so the extension can filter images and video frames across any website the user visits: (1) injecting `content.js`/`content.css` at `document_start` to hold images hidden before paint, (2) fetching cross-origin image bytes locally when canvas readback is blocked by CORS, (3) calling `chrome.tabs.captureVisibleTab` strictly when a page has unreadable `<canvas>`, cross-origin `<video>`, or unverified CSS background candidates on screen, and (4) reading the active tab title/URL only if the user manually clicks "Copy" under Page Diagnostics in Settings.

### 3. Remote Code Declaration

- **Are you using remote code?** → **No, I am not using remote code.**
- **Reviewer note (CSP & bundled ML assets):**
  > All JavaScript, WebAssembly (`vendor/ort-wasm-simd-threaded.asyncify.wasm`), and ONNX model weights (`models/accurate.fp16.onnx`, fine-tuned from Apache-2.0 Google SigLIP2-B/16) are bundled directly inside the extension ZIP. The `'wasm-unsafe-eval'` CSP directive is used exclusively to instantiate the bundled MIT-licensed ONNX Runtime Web `.wasm` module as a CPU fallback on devices without WebGPU/WebNN. The extension makes zero calls to developer servers, third-party APIs, or localhost services.

### 4. Data Use Disclosures & Certifications

- **User data accessed:** Check **Website content** *(images, video frames, and visible-tab candidate crops analyzed transiently in local memory to decide whether to hide explicit/suggestive visuals; never stored on disk or transmitted off-device)*.
- **Certifications (check all 3):**
  - [x] I do not sell or transfer user data to third parties, outside of the approved use cases.
  - [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - [x] I do not use or transfer user data to determine creditworthiness or for lending purposes.

---

## Testing Instructions for CWS Reviewers

> 1. Install the extension and open any web page containing images (e.g., a news or shopping site) or a video (e.g., YouTube).
> 2. Open the toolbar popup to see the live `On device` indicator, adjust the 4-level protection slider (*Very strict* → *Relaxed*) to watch open pages re-evaluate immediately without reloading, and toggle **Filter video** off/on.
> 3. Click **Details** to inspect the local hardware backend (WebGPU/WebNN/WASM), run the local speed test, or set/test the optional Parent password lock.
> 4. Open DevTools Network tab on the service worker and offscreen document (`engine.html`) to verify zero external telemetry or API requests are made.
