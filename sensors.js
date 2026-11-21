// Reads power figures from sysfs. Only uses GLib/Gio so it can be tested with plain gjs.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

function readNum(path) {
    const t = readText(path);
    if (t === null || t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function listDir(path) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) out.push(info.get_name());
        en.close(null);
    } catch (e) { /* missing dir */ }
    return out.sort();
}

// AMD APU gpu_metrics table, format 2.x (Renoir, Rembrandt, Phoenix, Hawk Point).
function parseMetrics(bytes) {
    if (!bytes || bytes.length < 64) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint8(2) !== 2) return null;

    const mW = off => {
        const x = dv.getUint16(off, true);
        return x === 0xffff ? null : x / 1000;
    };
    const socket = mW(40);
    if (socket === null || socket > 200) return null;
    const cpuDirect = mW(42), soc = mW(44), gfx = mW(46);
    const cores = [];
    for (let i = 0; i < 8; i++) {
        const c = mW(48 + i * 2);
        if (c !== null) cores.push(c);
    }
    const cpu = cpuDirect ?? (cores.length ? cores.reduce((a, c) => a + c, 0) : null);
    return {socket, cpu, gfx, soc};
}

// Paths found on the first run. Plain strings, so they may outlive disable/enable (screen lock);
// re-enumerating sysfs on every unlock would stall the shell for several ms.
let discovered = null;

const EMPTY_BAT = {status: null, percent: null, watts: null, hoursLeft: null};

function isCancel(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class Sensors {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._bat = EMPTY_BAT;
        this._metrics = null;
        this._batBusy = false;
        this._metricsBusy = false;
        this._prev = null;
        if (discovered) {
            Object.assign(this, discovered);
        } else {
            this._discover();
            discovered = {
                battery: this.battery, metricsPath: this.metricsPath, pptPath: this.pptPath,
                backlight: this.backlight, panel: this.panel, wifi: this.wifi, disks: this.disks, dimms: this.dimms,
            };
        }
        this._refresh();
    }

    _discover() {
        this.battery = null;
        for (const n of listDir('/sys/class/power_supply')) {
            const p = `/sys/class/power_supply/${n}`;
            if (readText(`${p}/type`) === 'Battery') { this.battery = p; break; }
        }

        this.metricsPath = null;
        for (const n of listDir('/sys/class/drm')) {
            const p = `/sys/class/drm/${n}/device/gpu_metrics`;
            if (/^card\d+$/.test(n) && exists(p)) { this.metricsPath = p; break; }
        }

        this.pptPath = null;
        for (const n of listDir('/sys/class/hwmon')) {
            const p = `/sys/class/hwmon/${n}`;
            if (readText(`${p}/name`) !== 'amdgpu') continue;
            for (const f of ['power1_average', 'power1_input']) {
                if (exists(`${p}/${f}`)) { this.pptPath = `${p}/${f}`; break; }
            }
            if (this.pptPath) break;
        }

        // Devices with no power sensor; we estimate them from their activity.
        this.backlight = listDir('/sys/class/backlight').map(n => `/sys/class/backlight/${n}`)[0] ?? null;
        this.panel = listDir('/sys/class/drm').filter(n => /^card\d+-eDP-/.test(n)).map(n => `/sys/class/drm/${n}`)[0] ?? null;
        this.wifi = listDir('/sys/class/net').map(n => `/sys/class/net/${n}`).find(p => exists(`${p}/wireless`)) ?? null;
        this.disks = listDir('/sys/block').filter(n => /^nvme\d+n\d+$/.test(n)).map(n => `/sys/block/${n}/stat`);
        this.dimms = listDir('/sys/class/hwmon').filter(n => readText(`/sys/class/hwmon/${n}/name`) === 'spd5118').length || 2;
    }

    // Reading the battery makes the ACPI firmware refresh (2-3 ms on this Dell, once per second at
    // most), and gpu_metrics occasionally takes a few ms too. Both go to a GIO worker thread; each tick
    // uses the values that arrived since the previous one (at most ~2 s old).
    _refresh() {
        if (this.battery && !this._batBusy) {
            this._batBusy = true;
            Gio.File.new_for_path(`${this.battery}/status`).load_contents_async(this._cancellable, (file, res) => {
                let status = null;
                try {
                    const [, bytes] = file.load_contents_finish(res);
                    status = decoder.decode(bytes).trim();
                } catch (e) {
                    if (isCancel(e)) return;
                }
                this._batBusy = false;
                // The firmware data is fresh now, so the remaining reads are cheap cache hits.
                this._bat = this._readBattery(status);
            });
        }
        if (this.metricsPath && !this._metricsBusy) {
            this._metricsBusy = true;
            Gio.File.new_for_path(this.metricsPath).load_contents_async(this._cancellable, (file, res) => {
                let bytes = null;
                try {
                    [, bytes] = file.load_contents_finish(res);
                } catch (e) {
                    if (isCancel(e)) return;
                }
                this._metricsBusy = false;
                this._metrics = bytes ? parseMetrics(bytes) : null;
            });
        }
    }

    destroy() {
        this._cancellable.cancel();
    }

    _sample() {
        const s = {t: GLib.get_monotonic_time() / 1e6};
        if (this.wifi) {
            s.up = readText(`${this.wifi}/operstate`) === 'up';
            s.rx = readNum(`${this.wifi}/statistics/rx_bytes`) ?? 0;
            s.tx = readNum(`${this.wifi}/statistics/tx_bytes`) ?? 0;
        }
        s.ios = 0; s.ioTicks = 0;
        for (const p of this.disks) {
            const f = (readText(p) ?? '').split(/\s+/).map(Number);
            if (f.length >= 10) { s.ios += f[0] + f[4]; s.ioTicks += f[9]; }
        }
        const cpu = (readText('/proc/stat') ?? '').split('\n')[0].split(/\s+/).slice(1).map(Number);
        if (cpu.length >= 5) {
            s.cpuTotal = cpu.reduce((a, c) => a + (c || 0), 0);
            s.cpuIdle = cpu[3] + cpu[4];
        }
        return s;
    }

    // Rough models for a 14" laptop. Each returns watts.
    _estimateDevices() {
        const now = this._sample(), prev = this._prev;
        this._prev = now;
        const dt = prev ? Math.max(0.2, now.t - prev.t) : null;

        // Screen: panel electronics plus a backlight that scales with brightness.
        let screen = null;
        if (this.backlight) {
            const on = !this.panel || (readText(`${this.panel}/dpms`) !== 'Off' && readText(`${this.panel}/status`) === 'connected');
            const b = readNum(`${this.backlight}/actual_brightness`) ?? readNum(`${this.backlight}/brightness`);
            const max = readNum(`${this.backlight}/max_brightness`);
            // LED backlights get less efficient near full brightness, hence the 1.5 power.
            screen = on && b !== null && max ? 0.4 + 3.6 * Math.pow(Math.min(1, b / max), 1.5) : 0;
        }

        // Wi-Fi: idle when associated, rising with traffic (sending costs more than receiving).
        let wifi = null;
        if (this.wifi) {
            if (!now.up) wifi = 0.05;
            else {
                let mbps = 0;
                if (dt) mbps = (Math.max(0, now.rx - prev.rx) + 2 * Math.max(0, now.tx - prev.tx)) * 8 / dt / 1e6;
                wifi = 0.2 + Math.min(1.8, 0.012 * mbps);
            }
        }

        // Storage: deep sleep when idle, awake when any I/O happened, more as it gets busier.
        let storage = null;
        if (this.disks.length) {
            storage = 0.05 * this.disks.length;
            if (dt) {
                const util = Math.min(1, Math.max(0, now.ioTicks - prev.ioTicks) / (dt * 1000));
                if (now.ios > prev.ios) storage += 0.35;
                storage += 2.4 * util;
            }
        }

        // RAM: per-module background power plus a share that follows CPU activity.
        let busy = 0;
        if (dt && now.cpuTotal > prev.cpuTotal)
            busy = 1 - (now.cpuIdle - prev.cpuIdle) / (now.cpuTotal - prev.cpuTotal);
        const ram = this.dimms * (0.15 + 0.8 * Math.min(1, Math.max(0, busy)));

        // CPU load in percent, shared with the Temps tab so /proc/stat is read once per tick.
        const cpuLoad = dt && now.cpuTotal > prev.cpuTotal ? 100 * Math.min(1, Math.max(0, busy)) : null;
        return {screen, wifi, storage, ram, cpuLoad};
    }

    _readBattery(status) {
        const b = this.battery;
        if (!b) return EMPTY_BAT;
        const percent = readNum(`${b}/capacity`);
        const powerNow = readNum(`${b}/power_now`);
        const currentNow = readNum(`${b}/current_now`);
        const voltageNow = readNum(`${b}/voltage_now`);

        let watts = null;
        if (powerNow !== null) watts = powerNow / 1e6;
        else if (currentNow !== null && voltageNow !== null) watts = (currentNow * voltageNow) / 1e12;

        let hoursLeft = null;
        if (status === 'Discharging') {
            const chargeNow = readNum(`${b}/charge_now`);
            const energyNow = readNum(`${b}/energy_now`);
            if (chargeNow && currentNow) hoursLeft = chargeNow / currentNow;
            else if (energyNow && powerNow) hoursLeft = energyNow / powerNow;
        }
        // The battery only tells us the whole-laptop draw while it is the power source.
        return {status, percent, watts: status === 'Discharging' ? watts : null, hoursLeft};
    }

    read() {
        const bat = this._bat;
        const m = this._metrics;
        this._refresh();   // for the next tick
        let socket = m?.socket ?? null;
        if (socket === null && this.pptPath) {
            const v = readNum(this.pptPath);
            if (v !== null) socket = v / 1e6;
        }
        const rest = bat.watts !== null && socket !== null ? Math.max(0, bat.watts - socket) : null;
        const devices = this._estimateDevices();
        return {
            devices,
            status: bat.status,
            percent: bat.percent,
            hoursLeft: bat.hoursLeft,
            total: bat.watts,
            socket,
            cpu: m?.cpu ?? null,
            gfx: m?.gfx ?? null,
            soc: m?.soc ?? null,
            rest,
        };
    }
}
