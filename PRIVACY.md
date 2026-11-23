# Psalm101 Privacy Policy

*Last updated: November 23, 2026*

**Short version:** Psalm101 runs 100% locally inside your browser. No images, video frames, screenshots, URLs, browsing history, analytics, or telemetry are ever sent to any external server.

## 1. Data Accessed Locally

To perform its single purpose — filtering explicit and suggestive visual content before it is displayed — Psalm101 transiently processes the following data **exclusively in local browser memory**:

- **Page images and CSS background images:** Pixels or image files on web pages you visit are decoded and evaluated locally by the bundled on-device machine learning model (SigLIP2-B/16 via ONNX Runtime Web).
- **Video frames (when "Filter video" is enabled):** Frames sampled from playing `<video>` elements are classified locally in memory and immediately discarded after display.
- **Visible-tab captures (backstop only):** Strictly when a page contains unreadable `<canvas>`, cross-origin `<video>`, or unverified CSS background candidates, the extension uses `chrome.tabs.captureVisibleTab` to crop and classify only those candidate regions locally in memory, then discards the capture immediately.
- **Active tab title and URL (user-initiated diagnostics only):** Read only when you explicitly click **Copy** under *Page diagnostics* in Settings to copy recent local image-check events to your clipboard.

## 2. Zero Data Transmission & No Tracking

- Psalm101 operates completely offline after installation — the ML model weights and ONNX runtime are bundled inside the extension package.
- The extension never transmits images, video frames, screenshots, URLs, browsing history, or usage analytics to the developer or any third party.
- The extension fetches image URLs only from the websites you are already visiting when cross-origin canvas restrictions prevent reading pixels directly from the page.
- Psalm101 contains no ads, no trackers, no analytics, and no remotely hosted code.

## 3. Local Storage

Only minimal configuration is saved in `chrome.storage.local` (and optional admin policy read from `chrome.storage.managed`):

- Filtering strictness level (`0`–`3`)
- Video filtering toggle (`true`/`false`)
- Optional parent-lock password stored solely as a salted SHA-256 hash (plus a 5-minute unlock expiry in `chrome.storage.session`)

Classification probabilities are cached in volatile RAM only (up to 5,000 URLs, never written to disk) and cleared when the browser or service worker stops.

## 4. Chrome Web Store Limited Use Compliance

Psalm101 adheres strictly to the Chrome Web Store User Data Policy and Limited Use requirements. Accessed page content is used solely to provide real-time on-device visual filtering and is never sold, shared, or used for advertising, profiling, or creditworthiness.

## 5. Open Source & Contact

Full source code is available at <https://github.com/benpbolton/psalm101-extension>. For questions or reports, please open an issue on GitHub.
