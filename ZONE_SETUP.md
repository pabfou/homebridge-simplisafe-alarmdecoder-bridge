# Zone Setup — AlarmDecoder + SafeWatch Pro 3000

Two zones are used:

| Zone | Purpose | Panel type | Triggered by |
|---|---|---|---|
| **41** | Delayed trigger | `01` Entry/Exit 1 — entry delay applies | Any sensor trip |
| **42** | Immediate trigger | `07` 24-hr audible — siren fires instantly | Panic button only |

Both zones are optional. You can configure just zone 41, just zone 42, or both.

> **Setup order matters:** the Vista panel must know a zone exists before the AlarmDecoder can fault it. Always follow the steps in order: panel first, then AD webapp, then plugin config.

---

## Part 1 — SafeWatch Pro 3000 Keypad

Program each zone in the Vista panel first. Repeat for zone 41 and zone 42.

1. Enter programming mode: `[installer code]` + `800`
2. Open zone programming: `*56`
3. Confirm: press `1` then `*` *(panel asks "set to confirm 0=no 1=yes")*
4. Enter zone number (`41` or `42`) → press `*`
5. Press `*` to pass the summary screen
6. Zone type → press `*` *(see table below)*
7. Partition: `1` → press `*`
8. Report code: `01` → press `*`
9. Hardwire type: `1` → press `*` *(NC)*
10. Response time: `1` → press `*` *(350 ms)*
11. Input type: `2` → press `*` *(auxiliary wired)*
12. Zone label: `0` → press `*` *(skip)*
13. Exit zone programming: `00` → press `*`
14. Repeat from step 4 for the other zone, then exit: `*99`

### Zone Type (step 5)

| Zone | Type code | Behavior |
|---|---|---|
| 41 — delayed | `01` | Entry delay applies — time to enter your code before siren sounds |
| 42 — immediate | `07` | Siren fires instantly, no delay, regardless of arm state |

---

## Part 2 — AlarmDecoder Webapp

**Step 1: Enable Expander 5**
1. Go to **Settings → Setup**
2. Find the **EXP** section and check **Expander 5** (covers zones 41–48)
3. Click **Save**

**Step 2: Add the zones**

Repeat for each zone you want to use:
1. Go to the **Zones** tab → click **New Zone**
2. Fill in:
   - **Zone ID**: `41` (delayed) and/or `42` (immediate)
   - **Name**: e.g. `SimpliSafe Delayed Trigger` / `SimpliSafe Panic Trigger`
3. Click **Save**

---

## Part 3 — Plugin Config

Add to your Homebridge config and restart Homebridge:

```json
{
  "platform": "SimpliSafeAlarmDecoderBridge",
  "ad_trigger_zone": 41,
  "ad_immediate_zone": 42
}
```

- `ad_trigger_zone` — faulted on any sensor-triggered alarm (entry delay)
- `ad_immediate_zone` — faulted on panic button only (immediate siren)
- Either field can be omitted to disable that zone
