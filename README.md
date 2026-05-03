# homebridge-simplisafe-alarmdecoder-bridge

A [Homebridge](https://homebridge.io) platform plugin that bidirectionally bridges a [SimpliSafe3](https://github.com/homebridge-simplisafe3/homebridge-simplisafe3) HomeKit security system and an [AlarmDecoder](https://www.alarmdecoder.com)/Honeywell Vista 20P alarm panel.

## How It Works

Both the `homebridge-simplisafe3` plugin and a `homebridge-alarmdecoder-platform` plugin must already be running in the same Homebridge instance. Each exposes a `SecuritySystem` accessory in HomeKit.

This bridge plugin subscribes to characteristic change events on both accessories:

| Direction | Trigger | Action |
|---|---|---|
| **SimpliSafe → AlarmDecoder** | `SecuritySystemCurrentState` changes on the SimpliSafe accessory | POSTs a keypress to the AlarmDecoder webapp REST API |
| **AlarmDecoder → SimpliSafe** | `SecuritySystemCurrentState` changes on the AlarmDecoder accessory | Updates the SimpliSafe characteristic to match |

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
      "ad_api_key": "your-alarmdecoder-api-key"
    }
  ]
}
```

Or use the **Homebridge UI** — the plugin includes a full configuration schema with field descriptions.

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

> **Finding accessory names**: The `simplisafe_name` and `ad_accessory_name` values must exactly match the **display names** shown in the Home app and in your Homebridge accessory list. Check the Homebridge log on startup — if a name is not found, the plugin logs all available accessory names.

### Getting Your AlarmDecoder API Key

1. Open the AlarmDecoder webapp in your browser
2. Go to **Settings → API**
3. Copy the API key shown there

---

## Troubleshooting

**"Accessory not found"** — The `simplisafe_name` or `ad_accessory_name` value doesn't match exactly. Check the Homebridge log; when a name is missing the plugin prints all available accessory names.

**"Failed to reach AlarmDecoder"** — Verify `ad_host`, `ad_port`, and that the AlarmDecoder webapp is running and reachable from the Homebridge host.

**"AlarmDecoder API responded 401"** — The `ad_api_key` is incorrect.

---

## License

MIT © pabfou
