'use strict';

const { io } = require('socket.io-client');

const PLUGIN_NAME = 'homebridge-simplisafe-alarmdecoder-bridge';
const PLATFORM_NAME = 'SimpliSafeAlarmDecoderBridge';

// How often to re-emit get-accessories until both are discovered.
const DISCOVERY_POLL_MS = 8_000;
// Log the full seen-names list after this many ms without discovery.
const DISCOVERY_WARN_MS = 60_000;

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
    this.config = config || {};
    this.api = api;

    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenTimer = null;

    this.socket = null;

    this.ssUniqueId = null;
    this.adUniqueId = null;
    this.ssLastValue = null;
    this.adLastValue = null;

    this._discoveryComplete = false;
    this._discoveryInterval = null;
    this._discoveryWarnTimer = null;
    // Collect every serviceName seen during discovery for diagnostics.
    this._seenNames = new Set();

    if (!this._validateConfig()) return;

    this.api.on('didFinishLaunching', async () => {
      try {
        await this._init();
      } catch (err) {
        this.log.error(`Bridge initialization failed: ${err.message}`);
        if (err.stack) this.log.error(err.stack);
      }
    });

    this.api.on('shutdown', () => this._shutdown());
  }

  // Required by Homebridge platform contract; this plugin registers no accessories of its own.
  configureAccessory() {}

  _validateConfig() {
    const required = [
      'simplisafe_name',
      'ad_accessory_name',
      'alarm_code',
      'ad_host',
      'ad_port',
      'ad_api_key',
      'hb_ui_username',
      'hb_ui_password',
    ];
    const missing = required.filter(k => !this.config[k]);
    if (missing.length) {
      this.log.error(`Missing required config fields: ${missing.join(', ')}`);
      return false;
    }
    if (!this.config.hb_ui_url) this.config.hb_ui_url = 'http://localhost:8581';
    this.config.hb_ui_url = this.config.hb_ui_url.replace(/\/+$/, '');
    return true;
  }

  async _init() {
    // Give the UI plugin time to fully come up.
    await new Promise(r => setTimeout(r, 5000));

    await this._login();
    this._scheduleTokenRefresh();

    // Socket-first: connect and discover organically via accessories-data events.
    this._connectSocket();
    this._startDiscoveryPoller();
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async _login() {
    const url = `${this.config.hb_ui_url}/api/auth/login`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.config.hb_ui_username,
        password: this.config.hb_ui_password,
      }),
    });

    if (!response.ok) {
      throw new Error(`Homebridge UI login failed (${response.status} ${response.statusText}). Check hb_ui_url, hb_ui_username, hb_ui_password.`);
    }

    const data = await response.json();
    this.token = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
    this.log.info('Authenticated to Homebridge UI');
  }

  async _refreshToken() {
    try {
      const url = `${this.config.hb_ui_url}/api/auth/refresh`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (response.ok) {
        const data = await response.json();
        this.token = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
        this.log.debug('Homebridge UI token refreshed');
        this._reconnectSocket();
      } else {
        this.log.warn(`Token refresh returned ${response.status}; falling back to full re-login`);
        await this._login();
        this._reconnectSocket();
      }
    } catch (err) {
      this.log.warn(`Token refresh error: ${err.message}; falling back to full re-login`);
      try {
        await this._login();
        this._reconnectSocket();
      } catch (loginErr) {
        this.log.error(`Re-login failed: ${loginErr.message}`);
      }
    }
    this._scheduleTokenRefresh();
  }

  _scheduleTokenRefresh() {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    const remaining = this.tokenExpiresAt - Date.now();
    const delay = Math.max(60_000, Math.floor(remaining * 0.8));
    this.tokenTimer = setTimeout(() => this._refreshToken(), delay);
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  _startDiscoveryPoller() {
    // Emit get-accessories every DISCOVERY_POLL_MS until both accessories are found.
    this._discoveryInterval = setInterval(() => {
      if (this._discoveryComplete) {
        clearInterval(this._discoveryInterval);
        this._discoveryInterval = null;
        if (this._discoveryWarnTimer) {
          clearTimeout(this._discoveryWarnTimer);
          this._discoveryWarnTimer = null;
        }
        return;
      }
      if (this.socket?.connected) {
        this.log.debug('Polling for accessories via socket...');
        this.socket.emit('get-accessories');
      }
    }, DISCOVERY_POLL_MS);

    // After DISCOVERY_WARN_MS, log a detailed warning with everything seen so far.
    this._discoveryWarnTimer = setTimeout(() => {
      if (this._discoveryComplete) return;
      const seen = this._seenNames.size
        ? [...this._seenNames].map(n => `"${n}"`).join(', ')
        : '(nothing yet — socket may not have connected)';
      if (!this.ssUniqueId) {
        this.log.error(
          `SimpliSafe accessory "${this.config.simplisafe_name}" not found after ${DISCOVERY_WARN_MS / 1000}s. ` +
          `Service names seen so far: ${seen}`
        );
      }
      if (!this.adUniqueId) {
        this.log.error(
          `AlarmDecoder accessory "${this.config.ad_accessory_name}" not found after ${DISCOVERY_WARN_MS / 1000}s. ` +
          `Service names seen so far: ${seen}`
        );
      }
      this.log.error(
        'Tip: the names above must match the "Service Name" shown in the Homebridge UI → ' +
        'Accessories tab (not the child bridge name). Update simplisafe_name / ad_accessory_name in config.'
      );
    }, DISCOVERY_WARN_MS);
  }

  // ── Socket ────────────────────────────────────────────────────────────────

  _connectSocket() {
    if (this.socket) {
      try { this.socket.disconnect(); } catch (_) {}
    }

    const url = `${this.config.hb_ui_url}/accessories`;
    this.socket = io(url, {
      query: { token: this.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 2000,
    });

    this.socket.on('connect', () => {
      this.log.info('Connected to Homebridge UI socket');
      this.socket.emit('get-accessories');
    });

    this.socket.on('disconnect', (reason) => {
      this.log.warn(`Homebridge UI socket disconnected: ${reason}`);
    });

    this.socket.on('connect_error', (err) => {
      this.log.error(`Homebridge UI socket connect error: ${err.message}`);
    });

    this.socket.on('accessories-data', (data) => {
      try {
        this._handleAccessoriesData(data);
      } catch (err) {
        this.log.error(`Error handling accessories-data: ${err.message}`);
      }
    });

    this.socket.on('accessory-control-failure', (msg) => {
      this.log.error(`accessory-control-failure: ${msg}`);
    });
  }

  _reconnectSocket() {
    if (!this.socket) return;
    try { this.socket.disconnect(); } catch (_) {}
    this._connectSocket();
  }

  // ── Accessory data handler (discovery + monitoring) ───────────────────────

  _handleAccessoriesData(data) {
    // Server sends either a single object (per-characteristic update) or an array (full refresh).
    const accessories = Array.isArray(data) ? data : [data];

    for (const acc of accessories) {
      if (!acc || !acc.uniqueId) continue;

      const svcName = acc.serviceName ?? '';
      if (svcName) this._seenNames.add(svcName);

      // ── Discovery phase ──────────────────────────────────────────────────
      if (!this._discoveryComplete) {
        if (!this.ssUniqueId && svcName === this.config.simplisafe_name) {
          if (acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
            this.ssUniqueId = acc.uniqueId;
            this.ssLastValue = acc.values?.SecuritySystemCurrentState ?? null;
            this.log.info(
              `Found SS "${this.config.simplisafe_name}" ` +
              `(state: ${this._stateLabel(this.ssLastValue)}, uniqueId: ${acc.uniqueId.slice(0, 12)}...)`
            );
          }
        }

        if (!this.adUniqueId && svcName === this.config.ad_accessory_name) {
          if (acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
            this.adUniqueId = acc.uniqueId;
            this.adLastValue = acc.values?.SecuritySystemCurrentState ?? null;
            this.log.info(
              `Found AD "${this.config.ad_accessory_name}" ` +
              `(state: ${this._stateLabel(this.adLastValue)}, uniqueId: ${acc.uniqueId.slice(0, 12)}...)`
            );
          }
        }

        if (this.ssUniqueId && this.adUniqueId) {
          this._discoveryComplete = true;
          this.log.info('Both accessories discovered — bridge is active');
        }

        // During discovery, log every unique service name at INFO so the user
        // can immediately see what names are available without needing debug mode.
        if (!this._discoveryComplete) {
          this.log.info(`[discovery] Saw accessory: "${svcName}" (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
        }
      }

      // ── Monitoring phase (only once discovered) ──────────────────────────
      if (!this._discoveryComplete) continue;

      if (acc.uniqueId === this.ssUniqueId) {
        const newValue = acc.values?.SecuritySystemCurrentState;
        if (newValue !== undefined && newValue !== this.ssLastValue) {
          const oldValue = this.ssLastValue;
          this.ssLastValue = newValue;
          this._handleSSChange(oldValue, newValue);
        }
      } else if (acc.uniqueId === this.adUniqueId) {
        const newValue = acc.values?.SecuritySystemCurrentState;
        if (newValue !== undefined && newValue !== this.adLastValue) {
          const oldValue = this.adLastValue;
          this.adLastValue = newValue;
          this._handleADChange(oldValue, newValue);
        }
      }
    }
  }

  // ── State bridging ────────────────────────────────────────────────────────

  // SimpliSafe → AlarmDecoder
  _handleSSChange(oldValue, newValue) {
    if (this.adLastValue === newValue) {
      this.log.debug(`SS → ${this._stateLabel(newValue)}; AD already there — skipping`);
      return;
    }
    const label = this._stateLabel(newValue);
    this.log.info(`SS state changed: ${this._stateLabel(oldValue)} → ${label}`);
    const keys = this._stateToKeys(newValue);
    if (keys !== null) this._sendToAlarmDecoder(keys, label);
  }

  // AlarmDecoder → SimpliSafe
  async _handleADChange(oldValue, newValue) {
    if (this.ssLastValue === newValue) {
      this.log.debug(`AD → ${this._stateLabel(newValue)}; SS already there — skipping`);
      return;
    }
    this.log.info(`AD state changed: ${this._stateLabel(oldValue)} → ${this._stateLabel(newValue)} — updating SimpliSafe`);

    try {
      const url = `${this.config.hb_ui_url}/api/accessories/${this.ssUniqueId}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          characteristicType: 'SecuritySystemCurrentState',
          value: newValue,
        }),
      });
      if (!response.ok) {
        this.log.error(`Failed to update SS state: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      this.log.error(`Error updating SS state: ${err.message}`);
    }
  }

  _stateToKeys(state) {
    const code = this.config.alarm_code;
    switch (state) {
      case 0: return code + '3'; // STAY_ARM
      case 1: return code + '2'; // AWAY_ARM
      case 2: return code + '3'; // NIGHT_ARM
      case 3: return code + '1'; // DISARMED
      case 4: return null;       // ALARM_TRIGGERED — no action
      default: return null;
    }
  }

  _stateLabel(value) {
    return STATE_NAMES[value] ?? String(value);
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

  _shutdown() {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    if (this._discoveryInterval) clearInterval(this._discoveryInterval);
    if (this._discoveryWarnTimer) clearTimeout(this._discoveryWarnTimer);
    if (this.socket) {
      try { this.socket.disconnect(); } catch (_) {}
    }
  }
}
