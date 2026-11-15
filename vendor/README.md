# Vendored assets

## qrcode-generator 1.4.4

- File: `qrcode.min.js`
- Upstream: https://github.com/kazuhikoarase/qrcode-generator
- Package: https://www.npmjs.com/package/qrcode-generator/v/1.4.4
- Downloaded from: https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js
- License: MIT
- SHA-256: `bb2365e4902f4f84852cf4025e6f6a60325a682aeafa43fb63b7fc8f098d1ef2`
- Size: 20,768 bytes

The file is vendored so the storefront has no runtime CDN dependency and no build step. It exposes the global `qrcode(typeNumber, errorCorrectionLevel)` factory used by `store.js` to render order QR codes as inline SVG.

Copyright (c) Kazuhiko Arase. Distributed under the MIT License. See the upstream repository for the full license text.
