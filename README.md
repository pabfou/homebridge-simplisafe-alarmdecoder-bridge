# homebridge-simplisafe-alarmdecoder-bridge

A [Homebridge](https://homebridge.io) platform plugin that bidirectionally bridges a [SimpliSafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) HomeKit security system and an [AlarmDecoder](https://www.alarmdecoder.com)/Honeywell Vista 20P alarm panel.

Works with **both** main-bridge and child-bridge plugin configurations.

## How It Works

Both the `homebridge-simplisafe3` plugin and a `homebridge-alarmdecoder-platform` plugin must already be running in the same Homebridge instance. Each exposes a `SecuritySystem` accessory in HomeKit.

This bridge plugin connects to **homebridge-config-ui-x** (the standard Homebridge web UI) over HTTP + Socket.IO. The UI server sees every accessory across every child bridge, so this plugin can observe and update both the SimpliSafe and AlarmDecoder `SecuritySystem` characteristics regardless of how those plugins are bridged.

| Direction | Trigger | Action |
|---|---|---|
| **SimpliSafe → AlarmDecoder** | `SecuritySystemTargetState` changes on the SimpliSafe accessory | POSTs a keypress sequence to the AlarmDecoder webapp REST API |
| **AlarmDecoder → SimpliSafe** | `SecuritySystemTargetState` (or `CurrentState`) changes on the AlarmDecoder accessory | Sets `SecuritySystemTargetState` on the SimpliSafe accessory via the Homebridge UI API |

State changes are only forwarded when the two accessories are out of sync, preventing feedback loops.

Both directions are near-instant when triggered from the Home app (socket push). A 3-second REST poll also runs as a fallback to catch any events the socket misses (e.g. physical keypad presses).

### State Mapping (SimpliSafe → AlarmDecoder keypresses)

| HomeKit State | Value | Keys Sent |
|---|---|---|
| Stay Arm | 0 | `alarm_code` + `3` |
| Away Arm | 1 | `alarm_code` + `2` |
| Night Arm | 2 | `alarm_code` + `3` |
| Disarmed | 3 | `alarm_code` + `1` |
| Alarm Triggered | 4 | *(no action)* |

### Zone Trigger (SS Alarm → AlarmDecoder Zone Fault)

When `ad_trigger_zone` is set, the bridge will **fault** a configurable emulated zone on the AlarmDecoder whenever SimpliSafe enters Alarm Triggered state, and **restore** it when SimpliSafe is disarmed. This causes the Vista panel to react to a SimpliSafe alarm as if a physical zone had tripped.

This is a three-step setup: find an available zone → program it in the panel → add it to the plugin config.

#### How it works

The Vista panel only responds to software zone faults for zones that belong to a zone expander. The AlarmDecoder emulates these expanders in software — no physical hardware needed. Zones 1–8 are hardwired; zones 9–48 can be emulated.

#### Step 1 — Find an available zone number

1. Open the AlarmDecoder webapp → **Settings → Setup → EXP section**. Note which expanders are enabled (e.g. Expander 4 = zones 33–40).
2. Open the **Zones** tab to see which zone numbers are already in use.
3. Pick any zone number that falls in an enabled expander's range **and** does not appear in the Zones list. That is your `ad_trigger_zone`.

| Expander | Zone range |
|---|---|
| 1 | 9 – 16 |
| 2 | 17 – 24 |
| 3 | 25 – 32 |
| 4 | 33 – 40 |
| 5 | 41 – 48 |

> If no expanders are enabled yet, go to **Settings → Setup → EXP**, enable expander 1, then pick any zone from 9–16.

> Zones outside 9–48 (e.g. RF zones) cannot be faulted via the AlarmDecoder zone API.

#### Step 2 — Program the zone in the SafeWatch Pro 3000 / Vista 20P

The Vista panel must be told that the emulated zone exists and what to do when it faults.

1. **Enter programming mode**: at the keypad, type your installer code + `800`
2. **Open zone programming**: type `*56`
3. **Enter the zone number** (e.g. `39`), then press `*`
4. Press `*` to pass the summary screen
5. **Zone type**: enter `07` (24-hour audible — triggers siren + report at all times), then press `*`
6. **Partition**: enter `1` (or your partition number), then press `*`
7. **Report code**: enter `01`, then press `*`
8. **Hardwire type**: enter `1` (NC — normally closed), then press `*`
9. **Response time**: enter `1` (350 ms), then press `*`
10. **Input type**: enter `2` (auxiliary wired), then press `*`
11. **Zone label**: enter `0` to skip, then press `*`
12. **Exit zone programming**: enter `00`, then press `*`
13. **Exit programming mode**: type `*99`

> Zone type `07` (24-hour audible) triggers the siren and sends a central station report regardless of armed state. Use `06` for a silent central-station-only report.

#### Step 3 — Add `ad_trigger_zone` to the plugin config

```json
{
  "platform": "SimpliSafeAlarmDecoderBridge",
  "ad_trigger_zone": 39
}
```

If `ad_trigger_zone` is omitted the feature is disabled and the plugin behaves exactly as before.

---

## Requirements

- [Homebridge](https://homebridge.io) v1.8.0 or later
- Node.js v18.15.0 or later
- [`homebridge-config-ui-x`](https://github.com/homebridge/homebridge-config-ui-x) installed (the default Homebridge web UI — almost certainly already present)
- [`homebridge-simplisafe3`](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) running in the same Homebridge instance
- A `homebridge-alarmdecoder-platform` plugin running in the same Homebridge instance
- [AlarmDecoder webapp](https://github.com/nutechsoftware/alarmdecoder-webapp) accessible on your network

---

## Installation

### Via Homebridge UI (recommended)

Search for **homebridge-simplisafe-alarmdecoder-bridge** in the Homebridge UI plugin search and click **Install**.

### Via npm

```bash
npm install -g homebridge-simplisafe-alarmdecoder-bridge
```

---

## One-Time Setup

This plugin authenticates to the Homebridge UI on your behalf. **Recommended:** create a dedicated UI user for this plugin instead of using your personal admin credentials.

1. Open the Homebridge UI → **Settings** → **User Accounts**
2. Click **Add New User**, set username (e.g. `bridge-plugin`), password, and **Admin** role
3. Save — you'll use these credentials in the plugin config below

---

## Configuration

Add a platform entry to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "SimpliSafeAlarmDecoderBridge",
      "name": "SimpliSafe AlarmDecoder Bridge",
      "simplisafe_name": "SimpliSafe 3",
      "ad_accessory_name": "ADT",
      "alarm_code": "1234",
      "ad_host": "192.168.1.100",
      "ad_port": 5000,
      "ad_api_key": "your-alarmdecoder-api-key",
      "hb_ui_url": "http://localhost:8581",
      "hb_ui_username": "bridge-plugin",
      "hb_ui_password": "your-ui-password"
    }
  ]
}
```

Or use the **Homebridge UI** — the plugin ships with a full configuration schema with field descriptions and password masking.

### Configuration Reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `platform` | string | yes | — | Must be `SimpliSafeAlarmDecoderBridge` |
| `name` | string | yes | — | Display name for this platform instance |
| `simplisafe_name` | string | yes | — | Exact service name of the SimpliSafe3 `SecuritySystem` accessory as shown in the Homebridge UI Accessories tab |
| `ad_accessory_name` | string | yes | — | Exact service name of the AlarmDecoder `SecuritySystem` accessory as shown in the Homebridge UI Accessories tab |
| `alarm_code` | string | yes | — | Your alarm panel PIN code |
| `ad_host` | string | yes | — | IP address of the AlarmDecoder webapp host (see note below) |
| `ad_port` | integer | yes | `5000` | TCP port of the AlarmDecoder webapp (default is `5000`) |
| `ad_api_key` | string | yes | — | API key from the AlarmDecoder web interface |
| `hb_ui_url` | string | no | `http://localhost:8581` | Base URL of homebridge-config-ui-x (see note below) |
| `hb_ui_username` | string | yes | — | Username of the dedicated UI user created above |
| `hb_ui_password` | string | yes | — | Password of that user |

> **Finding accessory names**: `simplisafe_name` and `ad_accessory_name` must exactly match the **service names** shown in the Homebridge UI → Accessories tab — not the child bridge name. On startup the plugin logs every accessory name it discovers, so if the name is wrong you can copy the correct one directly from the log.

> **Use IP addresses, not `.local` hostnames**: Homebridge runs on Linux, where `.local` mDNS hostnames (e.g. `alarmdecoder.local`) do not resolve without additional OS configuration. Use the device's IP address for `ad_host`. The same applies to `hb_ui_url` — keep it as `http://localhost:8581` (the default) since the plugin runs on the same machine as Homebridge.

### Getting Your AlarmDecoder API Key

1. Open the AlarmDecoder webapp in your browser
2. Go to **Settings → API**
3. Copy the API key shown there

---

## Troubleshooting

**"Homebridge UI not ready … retrying"** on every startup — The plugin retries login for up to 60 seconds while waiting for homebridge-config-ui-x to start. This is normal on a fresh boot. If it never succeeds, verify `hb_ui_url` is `http://localhost:8581` and that homebridge-config-ui-x is installed.

**"Homebridge UI login failed (401 …)"** — `hb_ui_username` or `hb_ui_password` is wrong, or the user doesn't have admin role.

**"SimpliSafe accessory not found"** / **"AlarmDecoder accessory not found"** — The name in config doesn't match. Check the Homebridge log for `[discovery] Saw accessory:` lines — those list every service name visible to the plugin. Copy the correct name into `simplisafe_name` or `ad_accessory_name`.

**"Failed to reach AlarmDecoder … (ECONNREFUSED)"** — Wrong port. Open `http://<ad_host>:<ad_port>` in your browser. If it doesn't load, try port `5000` (the default). Update `ad_port` accordingly.

**"Failed to reach AlarmDecoder … (ENOTFOUND)"** — The hostname can't be resolved. Replace `.local` hostnames with the device's IP address in `ad_host`.

**"AlarmDecoder API responded 401"** — The `ad_api_key` is incorrect. Retrieve it from the AlarmDecoder webapp under **Settings → API**.

**SS → AD works but AD → SS is slow** — The plugin polls state every 3 seconds as a fallback. If the Homebridge UI socket push is slow for your setup, the delay will be at most 3 seconds. This is normal.

---

## License

MIT © pabfou
