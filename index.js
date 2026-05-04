'use strict';

const { io } = require('socket.io-client');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PLUGIN_NAME = 'homebridge-simplisafe-alarmdecoder-bridge';
const PLATFORM_NAME = 'SimpliSafeAlarmDecoderBridge';

const DISCOVERY_POLL_MS = 8_000;
const DISCOVERY_WARN_MS = 60_000;
const STATE_POLL_MS = 3_000;

const SS_API_BASE = 'https://api.simplisafe.com/v1';
const SS_WS_URL   = 'wss://socketlink.prd.aser.simplisafe.com';

// eventCid sets for arm/disarm/alarm events
const SS_STAY_CIDS   = new Set([3441, 3491]);
const SS_AWAY_CIDS   = new Set([3401, 3407, 3487, 3481]);
const SS_DISARM_CIDS = new Set([1400, 1406, 1407]);
const SS_ALARM_CIDS  = new Set([1110, 1120, 1132, 1134, 1154, 1159, 1162]);

// alarmState string → HomeKit SecuritySystemCurrentState value
const SS_ALARM_STATE_MAP = {
  OFF: 3, HOME: 0, AWAY: 1,
  HOME_COUNT: 0, AWAY_COUNT: 1,
  ALARM: 4, ALARM_COUNT: 4,
};

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

    // HB UI auth (used for AD side only)
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenTimer = null;

    // HB UI socket (AD monitoring only)
    this.socket = null;

    // SimpliSafe direct connection
    this.ssToken = null;
    this.ssUserId = null;
    this.ssSid = null;
    this.ssWs = null;
    this._ssReconnectTimer = null;
    this._ssWatcher = null;
    this._ssWatchDebounce = null;

    // State tracking
    this.ssLastValue = null;
    this.adUniqueId = null;
    this.adLastValue = null;
    this._activatedZone = null; // 'immediate' | 'delayed' | null

    // AD discovery
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
    // SS init and HB UI login are independent — run in parallel
    await Promise.all([
      this._initSS(),
      this._login(),
    ]);
    this._scheduleTokenRefresh();
    this._connectSocket();
    this._startDiscoveryPoller();
  }

  // ── SimpliSafe Direct API ─────────────────────────────────────────────────

  async _initSS() {
    const tokenPath = path.join(this.api.user.storagePath(), 'simplisafe3auth.json');
    const maxAttempts = 10;
    const retryDelay = 6000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!fs.existsSync(tokenPath)) throw new Error('simplisafe3auth.json not found — is homebridge-simplisafe3 installed and logged in?');
        const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        if (!raw.accessToken) throw new Error('accessToken missing from simplisafe3auth.json');
        const accessToken = raw.accessToken;

        const authRes = await fetch(`${SS_API_BASE}/api/authCheck`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!authRes.ok) throw new Error(`SS authCheck failed (${authRes.status} ${authRes.statusText})`);
        const authJson = await authRes.json();
        const userId = authJson?.data?.userId ?? authJson?.userId ?? authJson?.id;
        if (!userId) throw new Error(`Could not find userId in SS authCheck response: ${JSON.stringify(authJson)}`);
        this.log.debug(`SS authCheck response structure: ${JSON.stringify(Object.keys(authJson))}`);

        const subRes = await fetch(
          `${SS_API_BASE}/users/${userId}/subscriptions?activeOnly=false`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!subRes.ok) throw new Error(`SS subscriptions fetch failed (${subRes.status} ${subRes.statusText})`);
        const subData = await subRes.json();
        const sid = subData.subscriptions?.[0]?.sid;
        if (!sid) throw new Error('No SimpliSafe subscription found');

        this.ssToken = accessToken;
        this.ssUserId = String(userId);
        this.ssSid = sid;
        this.log.info(`SimpliSafe: authenticated (userId=${userId}, sid=${sid})`);

        await this._pollSSState();
        this._connectSSSocket();
        this._watchTokenFile(tokenPath);
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          this.log.error(`SimpliSafe direct connection failed after ${maxAttempts} attempts: ${err.message}`);
          return; // non-fatal — AD side continues to work
        }
        this.log.warn(`SimpliSafe init attempt ${attempt}/${maxAttempts}: ${err.message} — retrying in ${retryDelay / 1000}s`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
  }

  _connectSSSocket() {
    if (this._ssReconnectTimer) { clearTimeout(this._ssReconnectTimer); this._ssReconnectTimer = null; }
    if (this.ssWs) {
      try { this.ssWs.removeAllListeners(); this.ssWs.close(); } catch (_) {}
      this.ssWs = null;
    }
    if (!this.ssToken || !this.ssUserId) return;

    const ws = new WebSocket(SS_WS_URL);
    this.ssWs = ws;

    ws.on('open', () => {
      this.log.info('Connected to SimpliSafe WebSocket');
      ws.send(JSON.stringify({
        datacontenttype: 'application/json',
        type: 'com.simplisafe.connection.identify',
        time: new Date().toISOString(),
        id: `ts:${Date.now()}`,
        specversion: '1.0',
        source: 'homebridge-simplisafe-alarmdecoder-bridge',
        data: {
          auth: { schema: 'bearer', token: this.ssToken },
          join: [`uid:${this.ssUserId}`],
        },
      }));
    });

    ws.on('message', (raw) => {
      try { this._handleSSEvent(JSON.parse(raw.toString())); }
      catch (err) { this.log.error(`SS WS parse error: ${err.message}`); }
    });

    ws.on('close', (code, reason) => {
      this.log.warn(`SS WebSocket closed (${code}): ${reason.toString() || 'no reason'} — reconnecting in 5s`);
      this._ssReconnectTimer = setTimeout(() => this._connectSSSocket(), 5000);
    });

    ws.on('error', (err) => {
      this.log.error(`SS WebSocket error: ${err.message}`);
    });
  }

  _watchTokenFile(tokenPath) {
    try {
      this._ssWatcher = fs.watch(tokenPath, () => {
        // Debounce — fs.watch can fire multiple events per single write
        if (this._ssWatchDebounce) return;
        this._ssWatchDebounce = setTimeout(() => {
          this._ssWatchDebounce = null;
          try {
            const raw = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
            if (raw.accessToken && raw.accessToken !== this.ssToken) {
              this.log.info('SimpliSafe token refreshed — reconnecting SS WebSocket');
              this.ssToken = raw.accessToken;
              this._connectSSSocket();
            }
          } catch (err) {
            this.log.warn(`Failed to read updated SS token file: ${err.message}`);
          }
        }, 500);
      });
    } catch (err) {
      this.log.warn(`Could not watch SS token file: ${err.message}`);
    }
  }

  _handleSSEvent(msg) {
    const type = msg.type ?? '';
    if (!type.startsWith('com.simplisafe.event')) return;

    const data = msg.data ?? {};
    if (String(data.sid) !== String(this.ssSid)) return;

    const eventCid = data.eventCid;
    const sensorType = data.sensorType;

    let newValue;
    if (SS_STAY_CIDS.has(eventCid))        newValue = 0; // STAY_ARM
    else if (SS_AWAY_CIDS.has(eventCid))   newValue = 1; // AWAY_ARM
    else if (SS_DISARM_CIDS.has(eventCid)) newValue = 3; // DISARMED
    else if (SS_ALARM_CIDS.has(eventCid))  newValue = 4; // ALARM_TRIGGERED
    else {
      this.log.debug(`SS WS: unrecognised eventCid=${eventCid} — ignoring`);
      return;
    }

    this.log.debug(`SS WS event: cid=${eventCid} sensorType=${sensorType} → ${this._stateLabel(newValue)}`);

    if (newValue === this.ssLastValue) return;
    const old = this.ssLastValue;
    this.ssLastValue = newValue;
    this._handleSSChange(old, newValue, sensorType);
  }

  async _pollSSState() {
    if (!this.ssSid) return;
    try {
      const res = await fetch(`${SS_API_BASE}/subscriptions/${this.ssSid}/`, {
        headers: { Authorization: `Bearer ${this.ssToken}` },
      });
      if (!res.ok) {
        this.log.warn(`SS state poll failed: ${res.status} ${res.statusText}`);
        return;
      }
      const data = await res.json();
      const alarmState = data.subscription?.location?.system?.alarmState;
      if (!alarmState) return;
      const v = SS_ALARM_STATE_MAP[alarmState];
      if (v === undefined) return;
      this.log.debug(`SS poll: alarmState=${alarmState} → ${this._stateLabel(v)} (last=${this.ssLastValue})`);
      if (v !== this.ssLastValue) {
        const old = this.ssLastValue;
        this.ssLastValue = v;
        this._handleSSChange(old, v);
      }
    } catch (err) {
      this.log.warn(`SS state poll error: ${err.message}`);
    }
  }

  // ── HB UI Auth ────────────────────────────────────────────────────────────

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

  // ── HB UI REST helpers ────────────────────────────────────────────────────

  async _fetchAccessories() {
    const url = `${this.config.hb_ui_url}/api/accessories`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`Fetch accessories failed: ${response.status}`);
    return response.json();
  }

  // ── AD Discovery ──────────────────────────────────────────────────────────

  _startDiscoveryPoller() {
    this._discoveryInterval = setInterval(() => {
      if (this._discoveryComplete) {
        clearInterval(this._discoveryInterval);
        this._discoveryInterval = null;
        return;
      }
      if (this.socket?.connected) {
        this.log.debug('Polling for AD accessory via socket...');
        this.socket.emit('get-accessories');
      }
    }, DISCOVERY_POLL_MS);

    this._discoveryWarnTimer = setTimeout(() => {
      if (this._discoveryComplete) return;
      const seen = this._seenNames.size
        ? [...this._seenNames].map(n => `"${n}"`).join(', ')
        : '(nothing yet)';
      this.log.error(`AlarmDecoder accessory "${this.config.ad_accessory_name}" not found after ${DISCOVERY_WARN_MS / 1000}s. Seen: ${seen}`);
    }, DISCOVERY_WARN_MS);
  }

  _onDiscoveryComplete() {
    this._discoveryComplete = true;
    if (this._discoveryInterval) { clearInterval(this._discoveryInterval); this._discoveryInterval = null; }
    if (this._discoveryWarnTimer) { clearTimeout(this._discoveryWarnTimer); this._discoveryWarnTimer = null; }
    this.log.info('AlarmDecoder accessory discovered — bridge is active');
    this.log.info(`AD "${this.config.ad_accessory_name}" current=${this._stateLabel(this.adLastValue)}, SS current=${this._stateLabel(this.ssLastValue)}`);
    this._pollInterval = setInterval(() => this._pollState(), STATE_POLL_MS);
  }

  // ── State polling (REST fallback) ─────────────────────────────────────────

  async _pollState() {
    if (!this._discoveryComplete) return;
    await Promise.all([
      this._pollSSState(),
      this._pollADState(),
    ]);
  }

  async _pollADState() {
    try {
      const accessories = await this._fetchAccessories();
      for (const acc of accessories) {
        if (!acc?.uniqueId || acc.uniqueId !== this.adUniqueId) continue;
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
    } catch (err) {
      this.log.warn(`AD state poll error: ${err.message}`);
    }
  }

  // ── HB UI Socket (AD monitoring only) ────────────────────────────────────

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

  // ── Accessory data handler (AD discovery + monitoring only) ───────────────

  _handleAccessoriesData(data) {
    const accessories = Array.isArray(data) ? data : [data];

    for (const acc of accessories) {
      if (!acc || !acc.uniqueId) continue;

      const svcName = acc.serviceName ?? '';
      if (svcName) this._seenNames.add(svcName);

      // ── Passive SS uniqueId capture (for AD→SS PUT) ──────────────────────
      if (!this._ssUniqueId && this.config.simplisafe_name && svcName === this.config.simplisafe_name) {
        if (acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
          this._ssUniqueId = acc.uniqueId;
          this.log.info(`Found SS "${svcName}" in HB UI (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
        }
      }

      // ── Discovery ────────────────────────────────────────────────────────
      if (!this._discoveryComplete) {
        if (!this.adUniqueId && svcName === this.config.ad_accessory_name) {
          if (acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
            this.adUniqueId = acc.uniqueId;
            this.adLastValue = acc.values?.SecuritySystemTargetState ?? acc.values?.SecuritySystemCurrentState ?? null;
            this.log.info(`Found AD "${svcName}" (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
            this._onDiscoveryComplete();
          }
        }
        if (!this._discoveryComplete) {
          this.log.info(`[discovery] Saw accessory: "${svcName}" (uniqueId: ${acc.uniqueId.slice(0, 12)}...)`);
          continue;
        }
      }

      // ── Monitoring ───────────────────────────────────────────────────────
      if (acc.uniqueId === this.adUniqueId) {
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

  // SimpliSafe → AlarmDecoder
  _handleSSChange(oldValue, newValue, sensorType = null) {
    const label = this._stateLabel(newValue);
    this.log.info(`SS changed: ${this._stateLabel(oldValue)} → ${label}`);

    // Zone fault/restore — runs regardless of AD sync state
    if (newValue === 4) {
      const isPanic = sensorType === 3; // PANIC_BUTTON
      const immediateZone = this.config.ad_immediate_zone;
      const delayedZone = this.config.ad_trigger_zone;

      if (isPanic && immediateZone) {
        this.log.info('Panic button detected — faulting immediate zone');
        this._activatedZone = 'immediate';
        this._faultZone(immediateZone);
      } else if (delayedZone) {
        this.log.info(`${isPanic ? 'Panic (no immediate zone configured)' : 'Sensor triggered'} — faulting delayed zone`);
        this._activatedZone = 'delayed';
        this._faultZone(delayedZone);
      }
    } else if (oldValue === 4) {
      if (this._activatedZone === 'immediate' && this.config.ad_immediate_zone) {
        this._restoreZone(this.config.ad_immediate_zone);
      } else if (this._activatedZone === 'delayed' && this.config.ad_trigger_zone) {
        this._restoreZone(this.config.ad_trigger_zone);
      }
      this._activatedZone = null;
    }

    // AD keypress sync — skip if already in sync
    if (this.adLastValue === newValue) {
      this.log.debug(`SS → ${label}; AD already there — skipping keypress`);
      return;
    }
    const keys = this._stateToKeys(newValue);
    if (keys !== null) this._sendToAlarmDecoder(keys, label);
  }

  // AlarmDecoder → SimpliSafe
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
      const url = `${this.config.hb_ui_url}/api/accessories/${this.ssUniqueId ?? this.adUniqueId}`;
      // We no longer have ssUniqueId — use the HB UI to find SS by name if needed.
      // For AD→SS we need the SS accessory uniqueId. Fetch it on-demand.
      const ssUniqueId = await this._getSSUniqueId();
      if (!ssUniqueId) {
        this.log.error('Cannot update SS state — SS accessory not found in Homebridge UI');
        return;
      }
      const response = await fetch(`${this.config.hb_ui_url}/api/accessories/${ssUniqueId}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
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

  // Lazily fetch and cache the SS accessory uniqueId from the HB UI (needed for AD→SS PUT).
  async _getSSUniqueId() {
    if (this._ssUniqueId) return this._ssUniqueId;
    if (!this.config.simplisafe_name) return null;
    try {
      const accessories = await this._fetchAccessories();
      for (const acc of accessories) {
        if ((acc.serviceName ?? '') === this.config.simplisafe_name &&
            acc.serviceCharacteristics?.find(c => c.type === 'SecuritySystemCurrentState')) {
          this._ssUniqueId = acc.uniqueId;
          return acc.uniqueId;
        }
      }
    } catch (err) {
      this.log.warn(`Could not fetch SS uniqueId from HB UI: ${err.message}`);
    }
    return null;
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

  async _faultZone(zone) {
    const { ad_host, ad_port, ad_api_key } = this.config;
    const url = `http://${ad_host}:${ad_port}/api/v1/zones/${zone}/fault`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': ad_api_key },
      });
      if (response.ok) {
        this.log.info(`AlarmDecoder zone ${zone} faulted`);
      } else {
        this.log.error(`Zone ${zone} fault failed: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : '';
      this.log.error(`Failed to fault zone ${zone}: ${err.message}${cause}`);
    }
  }

  async _restoreZone(zone) {
    const { ad_host, ad_port, ad_api_key } = this.config;
    const url = `http://${ad_host}:${ad_port}/api/v1/zones/${zone}/restore`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': ad_api_key },
      });
      if (response.ok) {
        this.log.info(`AlarmDecoder zone ${zone} restored`);
      } else {
        this.log.error(`Zone ${zone} restore failed: ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      const cause = err.cause ? ` (${err.cause.code ?? err.cause.message})` : '';
      this.log.error(`Failed to restore zone ${zone}: ${err.message}${cause}`);
    }
  }

  _shutdown() {
    if (this.tokenTimer) clearTimeout(this.tokenTimer);
    if (this._discoveryInterval) clearInterval(this._discoveryInterval);
    if (this._discoveryWarnTimer) clearTimeout(this._discoveryWarnTimer);
    if (this._pollInterval) clearInterval(this._pollInterval);
    if (this._ssReconnectTimer) clearTimeout(this._ssReconnectTimer);
    if (this._ssWatchDebounce) clearTimeout(this._ssWatchDebounce);
    if (this._ssWatcher) { try { this._ssWatcher.close(); } catch (_) {} }
    if (this.ssWs) { try { this.ssWs.removeAllListeners(); this.ssWs.close(); } catch (_) {} }
    if (this.socket) { try { this.socket.disconnect(); } catch (_) {} }
  }
}
