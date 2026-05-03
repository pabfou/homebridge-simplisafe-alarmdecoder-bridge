# homebridge-simplisafe-alarmdecoder-bridge

A [Homebridge](https://homebridge.io) platform plugin that bidirectionally bridges a [SimpliSafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) HomeKit security system and an [AlarmDecoder](https://www.alarmdecoder.com)/Honeywell Vista 20P alarm panel.

Works with **both** main-bridge and child-bridge plugin configurations.

## How It Works

Both the `homebridge-simplisafe3` plugin and a `homebridge-alarmdecoder-platform` plugin must already be running in the same Homebridge instance. Each exposes a `SecuritySystem` accessory in HomeKit.

This bridge plugin connects to **homebridge-config-ui-x** (the standard Homebridge web UI) over HTTP + Socket.IO. The UI server sees every accessory across every child bridge, so this plugin can observe and update both the SimpliSafe and AlarmDecoder `SecuritySystem` characteristics regardless of how those plugins are bridged.

| Direction | Trigger | Action |
|---|---|---|
| **SimpliSafe → AlarmDecoder** | `SecuritySystemCurrentState` changes on the SimpliSafe accessory | POSTs a keypress to the AlarmDecoder webapp REST API |
| **AlarmDecoder → SimpliSafe** | `SecuritySystemCurrentState` changes on the AlarmDecoder accessory | Updates the SimpliSafe characteristic via the UI API |

State changes are only forwarded when the two accessories are out of sync, preventing feedback loops.

### State Mapping (SimpliSafe → AlarmDecoder keypresses)

| HomeKit State | Value | Keys Sent |
|---|---|---|
| Stay Arm | 0 | `alarm_code` + `3` |
| Away Arm | 1 | `alarm_code` + `2` |
| Night Arm | 2 | `alarm_code` + `3` |
| Disarmed | 3 | `alarm_code` + `1` |
| Alarm Triggered | 4 | *(no action)* |

---

## Requirements

- [Homebridge](https://homebridge.io) v1.8.0 or later
- Node.js v18.15.0 or later
- [`homebridge-config-ui-x`](https://github.com/homebridge/homebridge-config-ui-x) installed and reachable from the plugin (the default Homebridge web UI — almost certainly already installed)
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
      "simplisafe_name": "Home Alarm",
      "ad_accessory_name": "Vista Panel",
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
| `simplisafe_name` | string | yes | — | Exact display name of the SimpliSafe3 `SecuritySystem` accessory in HomeKit |
| `ad_accessory_name` | string | yes | — | Exact display name of the AlarmDecoder `SecuritySystem` accessory in HomeKit |
| `alarm_code` | string | yes | — | Your alarm panel PIN code |
| `ad_host` | string | yes | — | IP address or hostname of the AlarmDecoder webapp |
| `ad_port` | integer | yes | `5000` | TCP port of the AlarmDecoder webapp |
| `ad_api_key` | string | yes | — | API key from the AlarmDecoder web interface |
| `hb_ui_url` | string | yes | `http://localhost:8581` | Base URL of homebridge-config-ui-x |
| `hb_ui_username` | string | yes | — | Username of the dedicated UI user created above |
| `hb_ui_password` | string | yes | — | Password of that user |

> **Finding accessory names**: `simplisafe_name` and `ad_accessory_name` must exactly match the **service names** the Homebridge UI uses for those accessories (typically the same as the Home app display name). If a name is wrong, the plugin logs all available accessory names on startup so you can correct it.

### Getting Your AlarmDecoder API Key

1. Open the AlarmDecoder webapp in your browser
2. Go to **Settings → API**
3. Copy the API key shown there

---

## Troubleshooting

**"Homebridge UI login failed (401 …)"** — `hb_ui_username` or `hb_ui_password` is wrong, or the user doesn't have admin role.

**"Homebridge UI login failed (ECONNREFUSED …)"** — The UI isn't running at `hb_ui_url`. Verify the URL and port (default `http://localhost:8581`).

**"SimpliSafe accessory not found"** / **"AlarmDecoder accessory not found"** — The display name doesn't match. The log lists all available accessory names — copy one of those into the config.

**"Failed to reach AlarmDecoder"** — Verify `ad_host`, `ad_port`, and that the AlarmDecoder webapp is running and reachable from the Homebridge host.

**"AlarmDecoder API responded 401"** — The `ad_api_key` is incorrect.

---

## License

MIT © pabfou
