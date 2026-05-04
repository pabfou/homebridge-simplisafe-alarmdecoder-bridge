# Zone 41 Setup — AlarmDecoder + SafeWatch Pro 3000

## Part 1 — AlarmDecoder Webapp

**Step 1: Enable Expander 5**
1. Go to **Settings → Setup**
2. Find the **EXP** section and check **Expander 5** (covers zones 41–48)
3. Click **Save**

**Step 2: Add zone 41**
1. Go to the **Zones** tab → click **New Zone**
2. Fill in:
   - **Zone ID**: `41`
   - **Name**: `SimpliSafe Alarm Trigger`
3. Click **Save**

---

## Part 2 — SafeWatch Pro 3000 Keypad

1. Enter programming mode: `[installer code]` + `800`
2. Open zone programming: `*56`
3. Enter zone number: `41` → press `*`
4. Press `*` to pass the summary screen
5. Zone type → press `*` *(choose one — see options below)*
6. Partition: `1` → press `*`
7. Report code: `01` → press `*`
8. Hardwire type: `1` → press `*` *(NC)*
9. Response time: `1` → press `*` *(350 ms)*
10. Input type: `2` → press `*` *(auxiliary wired)*
11. Zone label: `0` → press `*` *(skip)*
12. Exit zone programming: `00` → press `*`
13. Exit programming mode: `*99`

### Zone Type Options (step 5)

| Type | Code | Behavior |
|---|---|---|
| Entry/Exit 1 | `01` | Entry delay applies before siren sounds — time to enter your code first *(recommended)* |
| 24-hour audible | `07` | Siren fires immediately, no delay, regardless of arm state |

---

## Part 3 — Plugin Config

Add `ad_trigger_zone` to your Homebridge config and restart Homebridge:

```json
{
  "platform": "SimpliSafeAlarmDecoderBridge",
  "ad_trigger_zone": 41
}
```
