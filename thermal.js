// Temperatures, fan speeds, and CPU / graphics load and clocks.
//
// Many of these reads are slow or intrusive (measured on a Dell Inspiron 14 5445): the SSD temperature
// takes 4-21 ms and wakes the drive from its power-saving state, RAM sensors ~2 ms each over I2C, and
// Dell's embedded-controller sensors ~3 ms each through a BIOS call that briefly pauses every core.
// So every read runs in a GIO worker thread, nothing is read unless the Temps tab asks, and the slow
// sensors are read every SLOW_SECONDS instead of every tick.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const SLOW_SECONDS = 6;
const decoder = new TextDecoder();

// Discovered sensor list: plain data, kept across disable/enable (screen lock).
let discovered = null;

function readTextSync(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

function listDir(path) {
    const out = [];
    try {
        const en = Gio.File.new_for_path(path).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) out.push(info.get_name());
        en.close(null);
    } catch (e) { /* missing */ }
    return out;
}

const exists = p => GLib.file_test(p, GLib.FileTest.EXISTS);
const milli = t => (t === null || t === '' ? null : Number(t) / 1000);
const natural = (a, b) => a.localeCompare(b, undefined, {numeric: true});

// hwmon chip name -> how to show its temperatures. `pick` chooses the input(s) worth showing.
const CHIPS = {
    k10temp: {name: 'CPU', limit: 100, pick: ['Tctl', 'Tdie'], slow: false},
    zenpower: {name: 'CPU', limit: 100, pick: ['Tdie', 'Tctl'], slow: false},
    coretemp: {name: 'CPU', limit: 100, pick: ['Package id 0'], slow: false},
    amdgpu: {name: 'Graphics', limit: 100, pick: ['edge'], slow: false},
    nvme: {name: 'SSD', limit: 85, pick: ['Composite'], slow: true},
    spd5118: {name: 'RAM module', limit: 85, pick: null, slow: true, numbered: true},
    jc42: {name: 'RAM module', limit: 85, pick: null, slow: true, numbered: true},
    iwlwifi_1: {name: 'Wi-Fi', limit: 90, pick: null, slow: true},
    mt7921_phy0: {name: 'Wi-Fi', limit: 90, pick: null, slow: true},
    dell_smm: {name: 'Inside the case', limit: 70, pick: ['Ambient'], slow: true},
};

function* discover(out) {
    const temps = [], fans = [];
    const counts = {};
    for (const n of listDir('/sys/class/hwmon').sort(natural)) {
        const dir = `/sys/class/hwmon/${n}`;
        const chip = readTextSync(`${dir}/name`);
        const files = listDir(dir);

        const spec = CHIPS[chip];
        if (spec) {
            const inputs = files.filter(f => /^temp\d+_input$/.test(f)).sort(natural);
            const labelled = inputs.map(f => ({f, label: readTextSync(`${dir}/${f.replace('_input', '_label')}`)}));
            let chosen = [];
            if (spec.pick) {
                for (const want of spec.pick) {
                    const hit = labelled.find(x => x.label === want);
                    if (hit) { chosen = [hit]; break; }
                }
            } else {
                chosen = labelled.slice(0, 1);
            }
            for (const {f} of chosen) {
                const base = `${dir}/${f.replace('_input', '')}`;
                let name = spec.name;
                if (spec.numbered) {
                    counts[spec.name] = (counts[spec.name] ?? 0) + 1;
                    name = `${spec.name} ${counts[spec.name]}`;
                }
                // Limits are read later in the background: on SSDs and RAM even these cost ms.
                temps.push({
                    key: `${n}/${f}`, path: `${dir}/${f}`, name, defaultLimit: spec.limit, slow: spec.slow,
                    critPath: files.includes(`${f.replace('_input', '')}_crit`) ? `${base}_crit` : null,
                    maxPath: files.includes(`${f.replace('_input', '')}_max`) ? `${base}_max` : null,
                });
            }
        }

        // Fans from any chip. Dell's controller is behind a slow BIOS call, like other laptop ECs.
        for (const f of files.filter(x => /^fan\d+_input$/.test(x)).sort(natural)) {
            const base = `${dir}/${f.replace('_input', '')}`;
            const label = readTextSync(`${base}_label`);
            const max = Number(readTextSync(`${base}_max`)) || null;
            fans.push({
                key: `${n}/${f}`, path: `${dir}/${f}`,
                name: label ? label.replace(/\bProcessor\b/, 'CPU') : `Fan ${fans.length + 1}`,
                max, slow: chip === 'dell_smm' || chip === 'thinkpad' || chip === 'asus',
            });
        }
        yield;   // one hwmon folder per idle callback keeps each step around 1 ms
    }

    // Order: CPU, graphics, RAM, SSD, Wi-Fi, case.
    const rank = t => ['CPU', 'Graphics', 'RAM', 'SSD', 'Wi-Fi', 'Inside'].findIndex(p => t.name.startsWith(p));
    temps.sort((a, b) => rank(a) - rank(b) || natural(a.name, b.name));

    // One read of /proc/cpuinfo gives every core's clock, instead of one file per core.
    const cpuFreq = exists('/proc/cpuinfo') ? '/proc/cpuinfo' : null;
    const cpuMax = Number(readTextSync('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq')) || null;

    let gpuDir = null;
    for (const n of listDir('/sys/class/drm').sort(natural)) {
        const d = `/sys/class/drm/${n}/device`;
        if (/^card\d+$/.test(n) && exists(`${d}/gpu_busy_percent`)) { gpuDir = d; break; }
    }

    Object.assign(out, {temps, fans, cpuFreq, cpuMaxMHz: cpuMax ? cpuMax / 1000 : null, gpuDir});
}

// What read() returns before the sensors are known (first open of the tab, for a moment).
const EMPTY = {ready: false, temps: [], fans: [], cpu: {mhz: null, maxMHz: null}, gpu: {load: null, mhz: null}};

function isCancel(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class ThermalInfo {
    constructor() {
        this._d = discovered;       // null until the background discovery has finished once
        this._discoverId = 0;
        this._cancellable = new Gio.Cancellable();
        this._values = new Map();   // path -> latest text
        this._inFlight = new Set();
        this._lastFast = 0;
        this._lastSlow = 0;
        this._slowId = 0;
        this._cached = null;
        this.onChange = null;       // set by the tab: called when a batch of readings arrives
    }

    _readAsync(path) {
        if (this._inFlight.has(path)) return;
        this._inFlight.add(path);
        Gio.File.new_for_path(path).load_contents_async(this._cancellable, (file, res) => {
            try {
                const [, bytes] = file.load_contents_finish(res);
                let text = decoder.decode(bytes).trim();
                // /proc/cpuinfo is ~30 KB: boil it down to the average clock once, on arrival.
                if (path === this._d?.cpuFreq) {
                    const f = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gm)].map(m => Number(m[1])).filter(x => x > 0);
                    text = f.length ? String(f.reduce((a, c) => a + c, 0) / f.length) : null;
                }
                this._values.set(path, text);
                this._cached = null;
            } catch (e) {
                if (isCancel(e)) return;
                this._values.set(path, null);
                this._cached = null;
            }
            this._inFlight.delete(path);
            if (this._inFlight.size === 0) this.onChange?.();
        });
    }

    _startDiscovery() {
        if (this._discoverId) return;
        const out = {};
        const steps = discover(out);
        this._discoverId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (!steps.next().done) return GLib.SOURCE_CONTINUE;
            this._discoverId = 0;
            discovered = this._d = out;
            this.read();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Starts fresh background reads when due and returns the latest values that have arrived. */
    read() {
        if (this._cancellable.is_cancelled()) return EMPTY;
        if (!this._d) {
            this._startDiscovery();
            return EMPTY;
        }
        const d = this._d, now = GLib.get_monotonic_time() / 1e6;
        if (now - this._lastFast >= 1.5) {
            this._lastFast = now;
            for (const t of d.temps) if (!t.slow) this._readAsync(t.path);
            for (const f of d.fans) if (!f.slow) this._readAsync(f.path);
            if (d.cpuFreq) this._readAsync(d.cpuFreq);
            if (d.gpuDir) {
                this._readAsync(`${d.gpuDir}/gpu_busy_percent`);
                this._readAsync(`${d.gpuDir}/pp_dpm_sclk`);
            }
        }
        // Start the slow sensors from their own idle callback so their setup cost never adds to this call.
        if (now - this._lastSlow >= SLOW_SECONDS && !this._slowId) {
            this._lastSlow = now;
            this._slowId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
                this._slowId = 0;
                this._readSlow();
                return GLib.SOURCE_REMOVE;
            });
        }
        return this._snapshot();
    }

    _readSlow() {
        const d = this._d;
        // The first slow round also fetches each sensor's limits, once.
        if (!this._limitsAsked) {
            this._limitsAsked = true;
            for (const t of d.temps) {
                if (t.critPath) this._readAsync(t.critPath);
                if (t.maxPath) this._readAsync(t.maxPath);
            }
        }
        for (const t of d.temps) if (t.slow) this._readAsync(t.path);
        for (const f of d.fans) if (f.slow) this._readAsync(f.path);
    }

    _snapshot() {
        if (this._cached) return this._cached;
        const d = this._d, v = p => this._values.get(p) ?? null;
        const temps = [];
        for (const t of d.temps) {
            const c = milli(v(t.path));
            // 0 °C or less from a laptop sensor means "not fitted", not a frozen laptop: drop the row.
            const valid = c !== null && c > 0 && c < 150;
            if (this._values.has(t.path) && !valid) continue;
            // A sensor's own limits beat our defaults when they look sane.
            const crit = t.critPath ? milli(v(t.critPath)) : null;
            const max = t.maxPath ? milli(v(t.maxPath)) : null;
            const limit = crit > 30 && crit < 150 ? crit : t.defaultLimit;
            const warn = max > 30 && max < limit ? max : limit - 10;
            temps.push({key: t.key, name: t.name, c: valid ? c : null, limit, warn});
        }

        const fans = d.fans.map(f => {
            const raw = v(f.path);
            const rpm = raw === null ? null : Number(raw);
            return {key: f.key, name: f.name, rpm: Number.isFinite(rpm) ? rpm : null, max: f.max};
        });

        const cpuMHz = d.cpuFreq && v(d.cpuFreq) !== null ? Number(v(d.cpuFreq)) : null;

        let gpuLoad = null, gpuMHz = null;
        if (d.gpuDir) {
            const busy = Number(v(`${d.gpuDir}/gpu_busy_percent`));
            gpuLoad = Number.isFinite(busy) && v(`${d.gpuDir}/gpu_busy_percent`) !== null ? busy : null;
            const cur = (v(`${d.gpuDir}/pp_dpm_sclk`) ?? '').split('\n').find(l => l.includes('*'));
            const m = cur?.match(/(\d+)\s*Mhz/i);
            gpuMHz = m ? Number(m[1]) : null;
        }

        return this._cached = {
            ready: true,
            temps,
            fans,
            cpu: {mhz: cpuMHz, maxMHz: d.cpuMaxMHz},
            gpu: {load: gpuLoad, mhz: gpuMHz},
        };
    }

    destroy() {
        this.onChange = null;
        this._cancellable.cancel();
        if (this._discoverId) GLib.source_remove(this._discoverId);
        if (this._slowId) GLib.source_remove(this._slowId);
        this._discoverId = this._slowId = 0;
    }
}
