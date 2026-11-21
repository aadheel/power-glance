// Battery health and the optional charge limit. Only uses GLib/Gio so it can be tested with plain gjs.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const END = 'charge_control_end_threshold';
const START = 'charge_control_start_threshold';
const TYPES = 'charge_types';
export const LIMIT_END = 80;
export const LIMIT_START = 75;
const RECHECK_SECONDS = 60;

const NO_PERMISSION = 'Not allowed to change it. Run the one-time setup again.';
const REJECTED = "The laptop didn't accept this setting.";
const CANCELLED = {ok: false, error: 'Cancelled.'};

// Charge-limit readings per battery folder. On some laptops every read is a slow firmware call
// (12-60 ms on this Dell), so they are read off the main thread and kept in module scope, where
// they survive a lock/unlock instead of being read again.
const limitCache = new Map();

const decoder = new TextDecoder();
const now = () => GLib.get_monotonic_time() / 1e6;

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes).trim() : null;
    } catch (e) {
        return null;
    }
}

function toNum(t) {
    if (t === null || t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

const readNum = path => toNum(readText(path));

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

// Threaded read, so a slow firmware call never stalls the shell. Resolves to null on any error.
function readTextAsync(path, cancellable) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(cancellable, (file, res) => {
            try {
                const [, bytes] = file.load_contents_finish(res);
                resolve(decoder.decode(bytes).trim());
            } catch (e) {
                resolve(null);
            }
        });
    });
}

function canWrite(path) {
    try {
        return Gio.File.new_for_path(path)
            .query_info('access::can-write', Gio.FileQueryInfoFlags.NONE, null)
            .get_attribute_boolean('access::can-write');
    } catch (e) {
        return false;
    }
}

function findBattery(root) {
    for (const n of listDir(root)) {
        const p = `${root}/${n}`;
        // Skip mice, keyboards and other devices that report their own battery.
        if (readText(`${p}/type`) === 'Battery' && readText(`${p}/scope`) !== 'Device') return p;
    }
    return null;
}

// Never write sysfs with GLib.file_set_contents: it writes a temp file and renames it.
const defaultWriteArgv = (value, path) => ['/bin/sh', '-c', 'printf "%s" "$1" > "$2"', 'sh', value, path];

/** "Standard Adaptive [Custom]" -> {modes: ['Standard', 'Adaptive', 'Custom'], active: 'Custom'} */
export function parseChargeTypes(text) {
    const modes = [];
    let active = null;
    for (const tok of (text ?? '').split(/\s+/)) {
        if (!tok) continue;
        const m = /^\[(.+)\]$/.exec(tok);
        modes.push(m ? m[1] : tok);
        if (m) active = m[1];
    }
    return {modes, active};
}

/** True when a cap below 100% is in force. With charge_types, the thresholds only count in Custom mode. */
export function limitActive({end, modes, mode}) {
    if (end === null) return null;
    if (modes.includes('Custom')) return mode === 'Custom' && end < 100;
    return end < 100;
}

/**
 * The writes that turn the limit on or off, as [{file, value, optional}], skipping values already set.
 * Drivers reject a start at or above the end, so the order keeps start < end after every step.
 * cur: {end, start, hasStart, modes, mode}
 */
export function planWrites(cur, enabled) {
    const {modes, mode} = cur;
    const start = cur.hasStart ? cur.start : null;
    const steps = [];
    if (enabled) {
        if (modes.includes('Custom') && mode !== 'Custom') steps.push({file: TYPES, value: 'Custom'});
        const setEnd = cur.end === LIMIT_END ? [] : [{file: END, value: String(LIMIT_END)}];
        const setStart = !cur.hasStart || start === LIMIT_START ? [] : [{file: START, value: String(LIMIT_START)}];
        // Lowering the end to or below the current start: move the start down first.
        if (start !== null && LIMIT_END <= start) steps.push(...setStart, ...setEnd);
        else steps.push(...setEnd, ...setStart);
    } else if (modes.includes('Custom') && modes.includes('Standard')) {
        if (mode !== 'Standard') steps.push({file: TYPES, value: 'Standard'});
    } else {
        if (cur.end !== 100) steps.push({file: END, value: '100'});
        // Some drivers have a minimum start (Dell: 50). Then the old start stays, harmless with end at 100.
        if (cur.hasStart && start !== 0) steps.push({file: START, value: '0', optional: true});
    }
    return steps;
}

// The slow-changing fields of read(), plus what nowWh needs: {data, energy, uv}.
function readHealth(f) {
    const data = {present: readText(f('present')) !== '0', whApprox: false};
    const cycles = readNum(f('cycle_count'));
    data.cycles = cycles > 0 ? cycles : null;   // 0 or -1 means the firmware doesn't count
    data.manufacturer = readText(f('manufacturer')) || null;
    data.model = readText(f('model_name')) || null;

    const ef = readNum(f('energy_full')), ed = readNum(f('energy_full_design'));
    if (ef !== null && ed) {
        // energy_* are µWh.
        data.healthPct = ef / ed * 100;
        data.fullWh = ef / 1e6;
        data.designWh = ed / 1e6;
        return {data, energy: true, uv: null};
    }
    // charge_* are µAh. Wh = µAh × µV / 1e12, at the design voltage (as UPower does), so approximate.
    const cf = readNum(f('charge_full')), cd = readNum(f('charge_full_design'));
    data.healthPct = cf !== null && cd ? cf / cd * 100 : null;
    const uv = readNum(f('voltage_min_design')) ?? readNum(f('voltage_now'));
    data.fullWh = data.designWh = null;
    if (uv) {
        data.fullWh = cf === null ? null : cf * uv / 1e12;
        data.designWh = cd === null ? null : cd * uv / 1e12;
        data.whApprox = true;
    }
    return {data, energy: false, uv: uv || null};
}

export class BatteryInfo {
    /** Options are for tests: a fake power_supply folder, DMI vendor file and write command. */
    constructor({root = '/sys/class/power_supply', vendorFile = '/sys/class/dmi/id/sys_vendor',
        writeArgv = defaultWriteArgv} = {}) {
        this._root = root;
        this._writeArgv = writeArgv;
        this._vendor = readText(vendorFile) || null;
        this._cancellable = new Gio.Cancellable();
        this._probing = null;
        this._busy = false;
        this._health = null;
        this._dir = findBattery(root);
        // Start the first check now so the answer is there by the time the tab is opened.
        if (this._dir && !limitCache.has(this._dir) && exists(`${this._dir}/${END}`)) this._recheck();
    }

    read() {
        if (!this._dir) this._dir = findBattery(this._root);
        const d = this._dir;
        const out = {
            present: false, status: null, percent: null,
            healthPct: null, fullWh: null, designWh: null, nowWh: null, whApprox: false,
            cycles: null, manufacturer: null, model: null, vendor: this._vendor,
            limit: this._limit(),
        };
        if (!d) return out;
        const f = name => `${d}/${name}`;

        // After a second without battery reads, the first one makes the firmware refresh (~2 ms on
        // the main thread). Health barely changes, so it is read at most once a minute.
        if (!this._health || now() - this._health.time > RECHECK_SECONDS)
            this._health = {time: now(), ...readHealth(f)};
        const h = this._health;
        return {
            ...out, ...h.data,
            // These change all the time and cost the same firmware refresh, so they are only read
            // when used (the tab doesn't).
            get status() {
                return readText(f('status')) || null;
            },
            get percent() {
                return readNum(f('capacity'));
            },
            get nowWh() {
                if (h.energy) {
                    const en = readNum(f('energy_now'));
                    return en === null ? null : en / 1e6;
                }
                const cn = h.uv ? readNum(f('charge_now')) : null;
                return cn === null ? null : cn * h.uv / 1e12;
            },
        };
    }

    // `pending` is true until the first (async) check has finished; state is 'unreadable' meanwhile.
    _limit() {
        const none = {state: 'none', enabled: null, start: null, end: null, mode: null, pending: false};
        const d = this._dir;
        if (!d || !exists(`${d}/${END}`)) return none;

        const c = limitCache.get(d);
        // An unreadable limit stays unreadable until reboot; don't keep paying for the firmware call.
        if (!c || (c.readable && now() - c.time > RECHECK_SECONDS)) this._recheck();
        if (!c) return {...none, state: 'unreadable', pending: true};
        if (!c.readable) return {...none, state: 'unreadable'};

        // Cheap (no firmware call) and changes when the setup script runs, so check it every time.
        const writable = [END, START, TYPES].every(n => !exists(`${d}/${n}`) || canWrite(`${d}/${n}`));
        return {
            state: writable ? 'ready' : 'readonly',
            enabled: limitActive(c), start: c.start, end: c.end, mode: c.mode, pending: false,
        };
    }

    _recheck() {
        if (this._probing || this._busy) return;
        this._probing = this._probe().finally(() => {
            this._probing = null;
        });
    }

    async _probe() {
        const d = this._dir, cancellable = this._cancellable;
        const entry = {time: now(), readable: false, end: null, start: null, hasStart: false, modes: [], mode: null};
        try {
            entry.end = toNum(await readTextAsync(`${d}/${END}`, cancellable));
            entry.readable = entry.end !== null;
            // Each read may be another slow firmware call; when the end fails the others do too.
            if (entry.readable) {
                entry.hasStart = exists(`${d}/${START}`);
                const [start, types] = await Promise.all([
                    entry.hasStart ? readTextAsync(`${d}/${START}`, cancellable) : null,
                    exists(`${d}/${TYPES}`) ? readTextAsync(`${d}/${TYPES}`, cancellable) : null,
                ]);
                entry.start = toNum(start);
                const t = parseChargeTypes(types);
                entry.modes = t.modes;
                entry.mode = t.active;
            }
        } catch (e) {
            logError(e, 'Power Glance: reading the charge limit');
        }
        if (cancellable.is_cancelled()) return null;
        limitCache.set(d, entry);
        return entry;
    }

    /** Resolves to an error message, or null when the write worked. */
    _write(path, value) {
        return new Promise(resolve => {
            let proc;
            try {
                proc = Gio.Subprocess.new(this._writeArgv(value, path), Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                resolve("Couldn't start the command that changes the limit.");
                return;
            }
            proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
                try {
                    const [, , stderr] = p.communicate_utf8_finish(res);
                    if (p.get_successful()) resolve(null);
                    else resolve(/Permission denied/.test(stderr ?? '') ? NO_PERMISSION : REJECTED);
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) resolve(REJECTED);
                    // Cancelling doesn't stop the command; wait until its write has landed.
                    else p.wait_async(null, () => resolve(CANCELLED.error));
                }
            });
        });
    }

    /** Turns the 80% limit on or off. Only works in state 'ready'. */
    async setLimit(enabled) {
        if (this._busy) return {ok: false, error: 'Already changing the charge limit.'};
        if (!this._dir) return {ok: false, error: 'No battery found.'};
        this._busy = true;
        try {
            // Let a running check finish first so it can't overwrite the fresher values below.
            await this._probing;
            const before = await this._probe();
            if (!before) return CANCELLED;
            if (this._limit().state !== 'ready')
                return {ok: false, error: "The charge limit can't be changed from here."};

            for (const step of planWrites(before, enabled)) {
                const error = await this._write(`${this._dir}/${step.file}`, step.value);
                if (error && !step.optional) {
                    await this._probe();   // so the tab shows what is actually set now
                    return {ok: false, error};
                }
            }

            // Read back: some firmware accepts a write and then ignores it.
            const after = await this._probe();
            if (!after) return CANCELLED;
            if (limitActive(after) !== enabled || (enabled && after.end !== LIMIT_END))
                return {ok: false, error: "The laptop didn't keep the new setting."};
            return {ok: true};
        } finally {
            this._busy = false;
            // Stopped part way (the shell disables extensions on lock): the cached values may no
            // longer match the hardware, so the next BatteryInfo reads them again.
            if (this._cancellable.is_cancelled()) limitCache.delete(this._dir);
        }
    }

    destroy() {
        this._cancellable.cancel();
    }
}
