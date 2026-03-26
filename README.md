# FactCheck AI — Chrome Extension

Fact-check anything on the web by selecting an area with your mouse. Powered by Claude AI (vision + reasoning).

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select this folder (`factcheck-extension/`)
5. The extension icon will appear in your toolbar

## Setup

1. Click the extension icon
2. Click the ⚙ settings gear
3. Paste your Anthropic API key (`sk-ant-...`)
   - Get one at https://console.anthropic.com
4. Click **Save API Key**

## Usage

1. Click the extension icon on any webpage
2. Click **Select Area to Fact-Check**
3. The popup will close — draw a box around any text/content on the page
4. Click **✓ Fact-Check This** (or press Enter)
5. Results appear as a panel in the top-right corner of the page

## How it works

```
Click extension
    → popup.js injects activateSelector into the page
    → content.js draws the selection overlay
    → User draws a box and confirms
    → content.js sends coordinates to background.js
    → background.js captures the tab screenshot (captureVisibleTab)
    → Crops the image to the selected area (OffscreenCanvas)
    → Sends cropped image to Claude API (vision)
    → Claude identifies claims and fact-checks them
    → Result toast appears on the page
```

## Files

```
factcheck-extension/
├── manifest.json       Chrome Extension MV3 config
├── popup.html          Extension popup UI
├── popup.js            Popup logic, history, settings
├── content.js          Area selector + result toast
├── content.css         Overlay and toast styles
├── background.js       Service worker: capture + Claude API
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Troubleshooting

- **"Cannot run on this page"** — Chrome restricts extensions on `chrome://` URLs and the Chrome Web Store
- **"Invalid API key"** — Make sure your key starts with `sk-ant-` and has credits
- **"Rate limit reached"** — Wait 30 seconds and try again
- PDF pages may not support the content script; try HTML pages instead
