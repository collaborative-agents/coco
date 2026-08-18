## `desktop`

The Electron + React shell that hosts Coco's avatar, chat, and onboarding UI. It spawns the Python backend services (`sensing` and `proactive_tutor`) as child processes and communicates with them over local HTTP.

### Folder structure

```
desktop/
├── src/
│   ├── main/                          # Electron main process
│   │   ├── main.ts                    # Window lifecycle, IPC handlers, service orchestration
│   │   ├── preload.ts                 # contextBridge — exposes a typed IPC API to the renderer
│   │   ├── activity-store.ts          # Persists activity history to JSONL on disk
│   │   ├── menu.ts                    # macOS menu bar and global shortcuts
│   │   ├── util.ts                    # Dev/prod URL resolver (resolveHtmlPath)
│   │   └── services/
│   │       ├── manager.ts             # Spawns and manages Python child processes
│   │       ├── observation-stream.ts  # SSE client that streams observations from sensing
│   │       └── config.json            # Service definitions (ports, commands, env vars)
│   │
│   ├── renderer/                      # React 19 UI
│   │   ├── index.tsx                  # Entry — routes to views based on ?view= query param
│   │   ├── App.tsx                    # Default view: pet avatar + observation bubbles
│   │   └── components/
│   │       ├── OnboardingView.tsx     # First-run setup (mode selection, AI tools, custom prompt)
│   │       ├── SessionChatView.tsx    # Full tutor chat panel
│   │       ├── SessionSetupView.tsx   # Task label + struggle-detection interval picker
│   │       ├── NotificationView.tsx   # Session start/end prompts
│   │       ├── ObservationBubble.tsx  # Tiered status bubbles on the avatar
│   │       ├── PetSprite.tsx          # Animated avatar sprite with mood states
│   │       ├── observation-types.ts   # Shared types, status-to-mood mapping, AI tool catalog
│   │       └── activity-rollup.ts    # Activity panel analytics helpers
│   │
│   └── __tests__/                     # Jest + Testing Library tests
│
├── .erb/                              # Electron React Boilerplate tooling
│   ├── configs/                       # Webpack configs (main, renderer, preload, DLL)
│   └── scripts/                       # Build helpers (Python bundling and service copy)
│
├── assets/                            # App icons and pet sprite images
└── release/
    ├── app/                           # electron-builder app directory (prod entry point)
    └── build/                         # Packaged installers (DMG, NSIS, AppImage)
```

### Multi-window design

A single React bundle is loaded into several `BrowserWindow` instances, each routed by the `?view=` query parameter:

| Window | `?view=` | Purpose |
|---|---|---|
| **Avatar** | _(default)_ | Transparent, always-on-top pet sprite with observation bubbles |
| **Onboarding** | `onboarding` | First-run configuration wizard |
| **Chat** | `session` | Full tutor conversation panel |
| **Session Setup** | `session-setup` | Task label and check-in interval |
| **Notification** | `notification` | Session prompts and system warnings |

### Observation bubbles

The avatar surfaces observations from the sensing service in three tiers:

- **Tier 1** (`progress`, `observing`) — informational phrase only, no action needed
- **Tier 2** (`stuck`, `mistake`, `inefficient`, `ai_struggle`, `discernment_opportunity`) — actionable, with a one-click "Help me with this" button
- **Tier 3** (tutor guidance) — full suggestion preview with a link to open the chat panel

### How the main process orchestrates everything

1. On first launch, collects separate sensing and tutor provider/model settings;
   credentials are stored in a plaintext configuration file protected with
   owner-only permissions (`chmod 600`) in Electron's user-data directory
2. Checks whether onboarding is complete; if not, opens the onboarding window
3. `ServiceManager` spawns the Python backends (`sensing :8080`, `tutor :8081`)
   with role-specific credentials; development `.env` remains supported
4. An SSE client (`ObservationStream`) connects to `sensing` and forwards observation events to the avatar renderer via IPC
5. When a Tier-2 bubble appears, the main process precomputes a tutor suggestion in the background so the response is instant when clicked
6. Chat messages flow through `sensing/observe` (screen context) → `tutor/events` (guidance) → renderer

### Scripts

| Command | What it does |
|---|---|
| `npm start` | Dev mode — webpack-dev-server on `:1212` + Electron with hot reload |
| `npm run build` | Production webpack build (main + renderer) |
| `npm run build:services` | Bundle both Python executables into one shared `service-dist/coco-services/` runtime |
| `npm run package` | Full production build + electron-builder (DMG / NSIS / AppImage) |
| `npm test` | Run Jest unit tests |

### Signed macOS releases

macOS packaging requires a valid `Developer ID Application` identity and fails
instead of producing an unsigned app. On a local build Mac, install the
certificate and its private key in the login keychain, then verify it with:

```bash
security find-identity -v -p codesigning
```

For notarization, create an Apple app-specific password and provide the
credentials only in the packaging shell or CI secret store:

```bash
export APPLE_ID="your-apple-account@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TXPTCX3TMU"

npm run package
```

Electron-builder automatically selects the installed `Developer ID
Application` identity. If a build Mac has multiple matching identities, set
`CSC_NAME` to a qualifier such as `Yijia Shao (TXPTCX3TMU)`; do not include the
`Developer ID Application:` prefix.

Do not put the certificate, private key, or notarization credentials in the
repository or application `.env`. Electron-builder signs with Hardened Runtime,
submits the app through Apple notary service, and staples the accepted ticket.
After packaging, verify each generated `.app` with:

```bash
codesign --verify --deep --strict --verbose=2 "release/build/mac-arm64/coco.app"
spctl --assess --verbose --type exec "release/build/mac-arm64/coco.app"
xcrun stapler validate "release/build/mac-arm64/coco.app"
```

The output directory can be `release/build/mac` for an x64 build.

Development runs store their profile and authentication state in
`~/Library/Application Support/coco-development`; packaged builds use
`~/Library/Application Support/coco`. To test the first-launch flow repeatedly,
point one development run at a fresh temporary directory:

```bash
export COCO_TEST_DATA="$(mktemp -d /tmp/coco-model-test.XXXXXX)"
COCO_DESKTOP_USER_DATA_DIR="$COCO_TEST_DATA" npm start
```
