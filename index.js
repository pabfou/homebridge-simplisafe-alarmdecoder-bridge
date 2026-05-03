'use strict';

const { io } = require('socket.io-client');

const PLUGIN_NAME = 'homebridge-simplisafe-alarmdecoder-bridge';
const PLATFORM_NAME = 'SimpliSafeAlarmDecoderBridge';

// How often to re-emit get-accessories until both are discovered.
const DISCOVERY_POLL_MS = 8_000;
// Log the full seen-names list after this many ms without discovery.
const DISCOVERY_WARN_MS = 60_000;
// How often to poll the REST API as a fallback to socket events.
const STATE_POLL_MS = 3_000;

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
    // SS: we track TargetState (fires immediately when user taps Home app).
    // AD: we track CurrentState (fires when panel confirms the state change).
    this.ssLastValue = null;
    this.adLastValue = null;

    this._discoveryComplete = false;
    this._discoveryInterval = null;
    this._discoveryWarnTimer = null;
    this._pollInterval = null;
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
    await new Promise(r => setTimeout(r, 5000));
    await this._login();
    this._scheduleTokenRefresh();
    this._connectSocket();
    this._startDiscoveryPoller();
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async _login() {
    const url = `${this.config.hb_ui_url}/api/auth/login`;
    const maxAttempts = 10;
    const retryDelay = 6000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.config.hb_ui_username,
            password: this.config.hb_ui_password,
          }),
        });
        if (!response.ok) {
          throw new Error(`Homebridge UI login failed (${response.status} ${response.statusText})`);
        }
        const data = await response.json();
        this.token = data.access_token;
        this.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
        this.log.info('Authenticated to Homebridge UI');
        return;
      } catch (err) {
        const cause = err.cause ? ` [${err.cause.code ?? err.cause.message}]` : '';
        if (attempt === 1) this.log.warn(`Connecting to Homebridge UI at: ${url}`);
        if (attempt === maxAttempts) throw err;
        this.log.warn(`Homebridge UI not ready (attempt ${attempt}/${maxAttempts}): ${err.message}${cause} — retrying in ${retryDelay / 1000}s...`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
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
      try { await this._login(); this._reconnectSocket(); } catch (e) {
        this.log.error(`Re-login failed: ${e.message}`);
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

  // ── REST helpers ──────────────────────────────────────────────────────────

  async _fetchAccessories() {
    const url = `${this.config.hb_ui_url}/api/accessories`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`Fetch accessories failed: ${response.status}`);
    return response.json();
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  _startDiscoveryPoller() {
    this._discoveryInterval = setInterval(() => {
      if (this._discoveryComplete) {
        clearInterval(this._discoveryInterval);
        this._discoveryInterval = null;
        return;
      }
      if (this.socket?.connected) {
        this.log.debug('Polling for accessories via socket...');
        this.socket.emit('get-accessories');
      }
    }, DISCOVERY_POLL_MS);

    this._discoveryWarnTimer = setTimeout(() => {
      if (this._discoveryComplete) return;
      const seen = this._seenNames.size
        ? [...this._seenNames].map(n => `"${n}"`).join(', ')
        : '(nothing yet)';
      if (!this.ssUniqueId) this.log.error(`SimpliSafe accessory "${this.config.simplisafe_name}" not found after ${DISCOVERY_WARN_MS / 1000}s. Seen: ${seen}`);
      if (!this.adUniqueId) this.log.error(`AlarmDecoder accessory "${this.config.ad_accessory_name}" not found after ${DISCOVERY_WARN_MS / 1000}s. Seen: ${seen}`);
    }, DISCOVERY_WARN_MS);
  }

  _onDiscoveryComplete() {
    this._discoveryComplete = true;
    if (this._discoveryInterval) { clearInterval(this._discoveryInterval); this._discoveryInterval = null; }
    if (this._discoveryWarnTimer) { clearTimeout(this._discoveryWarnTimer); this._discoveryWarnTimer = null; }
    this.log.info('Both accessories discovered — bridge is active');
    this.log.info(`SS "${this.config.simplisafe_name}" target=${this._stateLabel(this.ssLastValue)}, AD "${this.config.ad_accessory_name}" current=${this._stateLabel(this.adLastValue)}`);

    // Start REST polling as a fallback to socket events.
    this._pollInterval = setInterval(() => this._pollState(), STATE_POLL_MS);
  }

  // ── State polling (REST fallback) ─────────────────────────────────────────

  async _pollState() {
    if (!this._discoveryComplete) return;
    try {
      const accessories = await this._fetchAccessories();
      for (const acc of accessories) {
        if (!acc?.uniqueId) continue;
        // Use the same characteristic as socket monitoring.
        if (acc.uniqueId === this.ssUniqueId) {
          const v = acc.values?.SecuritySystemTargetState;
          this.log.debug(`SS poll: targetState=${v} (last=${this.ssLastValue})`);
          if (v !== undefined && v !== this.ssLastValue) {
            const old = this.ssLastValue; this.ssLastValue = v;
            this._handleSSChange(old, v);
          }
        } else if (acc.uniqueId === this.adUniqueId) {
          const target = acc.values?.SecuritySystemTargetState;
          const current = acc.values?.SecuritySystemCurrentState;
          this.log.debug(`AD poll: targetState=${target} currentState=${current} (last=${this.adLastValue})`);
          const v = (target !== undefined && target !== this.adLastValue) ? target
            : (current !== undefined && current !== this.adLastValue) ? current
            : undefined;
          if (v !== undefined) {
            const old = this.adLastValue; this.adLastValue = v;
            this._handleADChange(old, v);
          }
        }
      }
    } catch (err) {
      this.log.warn(`State poll error: ${err.message}`);
    }
  }

  // ── Socket ────────────────────────────────────────────────────────────────

  _connectSocket() {
    if (this.socket) { try { this.socket.disconnect(); } catch (_) {} }

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
      try { this._handleAccessoriesData(data); }
      catch (err) { this.log.error(`Error handling accessories-data: ${err.message}`); }
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
    const accessories = Array.isArray(data) ? data : [data];

    for (const acc of accessories) {
      if (!acc || !acc.uniqueId) continue;

      const svcName = acc.serviceName ?? '';
      if (svcName) this._seenNames.add(svcName);

      // ── Discovery ────────────────────────────────────────────────────────
      if (!this._discoveryComplete) {
        if (!this.ssUniqueId && svcName === this.config.simplisafe_name) {
          if (acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
            this.ssUniqueId = acc.uniqueId;
            // Track TargetState for SS (fires immediately on Home app tap).
            this.ssLastValue = acc.values?.SecuritySystemTargetState ?? acc.values?.SecuritySystemCurrentState ?? null;
            this.log.info(`Found SS "${svcName}" (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
          }
        }

        if (!this.adUniqueId && svcName === this.config.ad_accessory_name) {
          if (acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
            this.adUniqueId = acc.uniqueId;
            // Track CurrentState for AD (fires when panel confirms the change).
            this.adLastValue = acc.values?.SecuritySystemTargetState ?? acc.values?.SecuritySystemCurrentState ?? null;
            this.log.info(`Found AD "${svcName}" (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
          }
        }

        if (this.ssUniqueId && this.adUniqueId && !this._discoveryComplete) {
          this._onDiscoveryComplete();
        }

        if (!this._discoveryComplete) {
          this.log.info(`[discovery] Saw accessory: "${svcName}" (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
          continue;
        }
      }

      // ── Monitoring (SS: TargetState, AD: CurrentState) ───────────────────
      if (acc.uniqueId === this.ssUniqueId) {
        const v = acc.values?.SecuritySystemTargetState;
        this.log.debug(`SS socket: targetState=${v} (last=${this.ssLastValue})`);
        if (v !== undefined && v !== this.ssLastValue) {
          const old = this.ssLastValue; this.ssLastValue = v;
          this._handleSSChange(old, v);
        }

      } else if (acc.uniqueId === this.adUniqueId) {
        // Prefer TargetState (fires immediately on Home app tap);
        // fall back to CurrentState (fires after panel confirms, or on physical keypad).
        const target = acc.values?.SecuritySystemTargetState;
        const current = acc.values?.SecuritySystemCurrentState;
        this.log.debug(`AD socket: targetState=${target} currentState=${current} (last=${this.adLastValue})`);
        const v = (target !== undefined && target !== this.adLastValue) ? target
          : (current !== undefined && current !== this.adLastValue) ? current
          : undefined;
        if (v !== undefined) {
          const old = this.adLastValue; this.adLastValue = v;
          this._handleADChange(old, v);
        }
      }
    }
  }

  // ── State bridging ────────────────────────────────────────────────────────

  // SimpliSafe → AlarmDecoder (triggered by SS TargetState change)
  _handleSSChange(oldValue, newValue) {
    if (this.adLastValue === newValue) {
      this.log.debug(`SS → ${this._stateLabel(newValue)}; AD already there — skipping`);
      return;
    }
    const label = this._stateLabel(newValue);
    this.log.info(`SS target changed: ${this._stateLabel(oldValue)} → ${label} — sending to AlarmDecoder`);
    const keys = this._stateToKeys(newValue);
    if (keys !== null) this._sendToAlarmDecoder(keys, label);
  }

  // AlarmDecoder → SimpliSafe (triggered by AD CurrentState change)
  async _handleADChange(oldValue, newValue) {
    if (this.ssLastValue === newValue) {
      this.log.debug(`AD → ${this._stateLabel(newValue)}; SS already there — skipping`);
      return;
    }
    this.log.info(`AD current changed: ${this._stateLabel(oldValue)} → ${this._stateLabel(newValue)} — updating SimpliSafe`);

    // ALARM_TRIGGERED (4) has no writable TargetState equivalent — skip.
    if (newValue === 4) {
      this.log.debug('AD ALARM_TRIGGERED — no target-state update sent to SS');
      return;
    }

    try {
      const url = `${this.config.hb_ui_url}/api/accessories/${this.ssUniqueId}`;
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // SecuritySystemTargetState is the writable characteristic that triggers arm/disarm.
          characteristicType: 'SecuritySystemTargetState',
          value: newValue,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        this.log.error(`Failed to set SS target state: ${response.status} ${response.statusText} — ${body}`);
      } else {
        this.log.info(`SS target state set to ${this._stateLabel(newValue)}`);
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
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : '';
      this.log.error(`Failed to reach AlarmDecoder at ${url}: ${err.message}${cause}`);
      if (err.cause?.code === 'ENOTFOUND') {
        this.log.error('Tip: .local hostnames may not resolve on Linux. Try using the IP address for ad_host instead.');
      }
    }
  }

  _shutdown() {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    if (this._discoveryInterval) clearInterval(this._discoveryInterval);
    if (this._discoveryWarnTimer) clearTimeout(this._discoveryWarnTimer);
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this.socket) { try { this.socket.disconnect(); } catch (_) {} }
  }
}
