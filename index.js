'use strict';

const PLUGIN_NAME = 'homebridge-simplisafe-alarmdecoder-bridge';
const PLATFORM_NAME = 'SimpliSafeAlarmDecoderBridge';

const STATE_NAMES = {
  0: 'STAY_ARM',
  1: 'AWAY_ARM',
  2: 'NIGHT_ARM',
  3: 'DISARMED',
  4: 'ALARM_TRIGGERED',
};

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SimpliSafeAlarmDecoderBridgePlatform);
};

class SimpliSafeAlarmDecoderBridgePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    this.ssChar = null;
    this.adChar = null;

    if (!this._validateConfig()) return;

    this.api.on('didFinishLaunching', () => this._didFinishLaunching());
  }

  // Required by Homebridge platform contract; this plugin registers no accessories of its own.
  configureAccessory() {}

  _validateConfig() {
    const required = ['simplisafe_name', 'ad_accessory_name', 'alarm_code', 'ad_host', 'ad_port', 'ad_api_key'];
    const missing = required.filter(k => !this.config[k]);
    if (missing.length) {
      this.log.error(`Missing required config fields: ${missing.join(', ')}`);
      return false;
    }
    return true;
  }

  async _didFinishLaunching() {
    // Give all platform plugins time to register their accessories with the bridge.
    await new Promise(resolve => setTimeout(resolve, 1000));

    const { simplisafe_name, ad_accessory_name } = this.config;
    const all = this.api._bridge.bridgedAccessories || [];

    const ssAcc = all.find(a => a.displayName === simplisafe_name);
    const adAcc = all.find(a => a.displayName === ad_accessory_name);

    if (!ssAcc || !adAcc) {
      const names = all.map(a => `"${a.displayName}"`).join(', ');
      if (!ssAcc) this.log.error(`SimpliSafe accessory "${simplisafe_name}" not found. Available: ${names}`);
      if (!adAcc) this.log.error(`AlarmDecoder accessory "${ad_accessory_name}" not found. Available: ${names}`);
      return;
    }

    const { Service, Characteristic } = this.api.hap;
    const ssService = ssAcc.services.find(s => s.UUID === Service.SecuritySystem.UUID);
    const adService = adAcc.services.find(s => s.UUID === Service.SecuritySystem.UUID);

    if (!ssService) {
      this.log.error(`No SecuritySystem service on SimpliSafe accessory "${simplisafe_name}"`);
      return;
    }
    if (!adService) {
      this.log.error(`No SecuritySystem service on AlarmDecoder accessory "${ad_accessory_name}"`);
      return;
    }

    this.ssChar = ssService.getCharacteristic(Characteristic.SecuritySystemCurrentState);
    this.adChar = adService.getCharacteristic(Characteristic.SecuritySystemCurrentState);

    this._subscribeForward();
    this._subscribeReverse();

    this.log.info(
      `Bridging "${simplisafe_name}" ↔ "${ad_accessory_name}" via AlarmDecoder at ` +
      `${this.config.ad_host}:${this.config.ad_port}`
    );
  }

  // SimpliSafe → AlarmDecoder
  _subscribeForward() {
    this.ssChar.on('change', ({ oldValue, newValue }) => {
      if (this.adChar.value === newValue) return;
      const label = STATE_NAMES[newValue] ?? newValue;
      this.log.info(`SS state changed: ${STATE_NAMES[oldValue] ?? oldValue} → ${label}`);
      const keys = this._stateToKeys(newValue);
      if (keys !== null) this._sendToAlarmDecoder(keys, label);
    });
  }

  // AlarmDecoder → SimpliSafe
  _subscribeReverse() {
    this.adChar.on('change', ({ oldValue, newValue }) => {
      if (this.ssChar.value === newValue) return;
      this.log.info(
        `AD state changed: ${STATE_NAMES[oldValue] ?? oldValue} → ${STATE_NAMES[newValue] ?? newValue} — updating SimpliSafe`
      );
      this.ssChar.updateValue(newValue);
    });
  }

  _stateToKeys(state) {
    const { alarm_code } = this.config;
    switch (state) {
      case 0: return alarm_code + '3'; // STAY_ARM
      case 1: return alarm_code + '2'; // AWAY_ARM
      case 2: return alarm_code + '3'; // NIGHT_ARM
      case 3: return alarm_code + '1'; // DISARMED
      case 4: return null;             // ALARM_TRIGGERED — no action
      default: return null;
    }
  }

  async _sendToAlarmDecoder(keys, stateLabel) {
    const { ad_host, ad_port, ad_api_key } = this.config;
    const url = `http://${ad_host}:${ad_port}/api/v1/alarmdecoder/send`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': ad_api_key,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ keys }),
      });

      if (response.ok) {
        this.log.info(`AlarmDecoder keypress sent for ${stateLabel}`);
      } else {
        this.log.error(`AlarmDecoder API responded ${response.status} ${response.statusText} for ${stateLabel}`);
      }
    } catch (err) {
      this.log.error(`Failed to reach AlarmDecoder at ${url}: ${err.message}`);
    }
  }
}
