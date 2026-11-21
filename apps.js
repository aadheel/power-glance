// Splits measured processor and graphics power between apps, from per-process CPU time and GPU time.
// Only uses GLib/Gio so it can be tested with plain gjs. All /proc work runs in short idle chunks.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const BATTERY_INTERVAL = 10;   // s between scans on battery
const VIEW_INTERVAL = 4;       // s between scans while the Apps tab is showing
const GPU_REDISCOVER = 60;     // s between searches for processes that use the GPU
const CHUNK_US = 1000;         // work per idle callback; one more item may run past it
const LIST_BATCH = 64;         // /proc entries per async callback (~0.2 ms each)
const GPU_PIDS_PER_CHUNK = 12;
const MAX_DT = 10;             // s; longer gaps between feeds (lock, stall) are not integrated
const ALPHA = 0.5;             // smoothing for the "right now" figures
const HZ = 100;                // USER_HZ, the unit of utime/stime in /proc/<pid>/stat
const NCPU = GLib.get_num_processors();
const MIN_W = 0.005, MIN_PCT = 0.05;   // below both, an app has stopped and drops out

// Launcher names in "app-<launcher>-<id>-<random>.scope" (systemd.io/DESKTOP_ENVIRONMENTS).
const LAUNCHERS = new Set(['gnome', 'flatpak', 'kde', 'xfce', 'cinnamon', 'mate', 'budgie', 'lxqt', 'cosmic']);
// D-Bus activated apps are named after their bus name: "dbus-:1.2-org.gnome.Nautilus".
const DBUS_RE = /^dbus-:[\d.]+-(.+)$/;
const USER_GROUPS = new Set(['session.slice', 'background.slice', 'app.slice']);

const GROUPS = {
    shell: {name: 'Desktop (GNOME Shell)', icon: 'user-desktop-symbolic'},
    background: {name: 'Background services', icon: 'emblem-system-symbolic'},
    system: {name: 'System', icon: 'computer-symbolic'},
};

const decoder = new TextDecoder();
const UID = (() => {
    try {
        return new Gio.Credentials().get_unix_user();
    } catch (e) {
        return null;
    }
})();

// Survives disable/enable, which GNOME does on every screen lock. Plain data only, never sources.
// lastWall: time of the latest battery feed, so a locked gap before plugging in isn't counted.
// sawUnplug: false when the shell started while already on battery (login, shell restart), so the
// session can't know the real unplug time. seen: this shell process has fed at least once.
const session = {onBattery: false, since: null, until: null, lastWall: null, lastPercent: null, sawUnplug: false, seen: false, wh: new Map()};   // wh: group key -> Wh
const appCache = new Map();    // app id -> {info: Gio.DesktopAppInfo|null, searched: bool}
const termNames = new Map();   // terminal scope -> name of the command running in it
const icons = new Map();       // themed icon name -> Gio.ThemedIcon

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch (e) {
        return null;
    }
}

/** Undo systemd unit-name escaping: "google\x2dchrome" -> "google-chrome". */
export function decodeUnit(s) {
    return s.replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
}

/** One cgroup path component -> {id, dbus} when it names an app, else null. */
function appUnit(raw, child) {
    const snap = /^snap\.([^.]+)\..+\.scope$/.exec(raw);
    if (snap) return {id: snap[1], dbus: false};

    const m = /^(app-)?(.+)\.(scope|service|slice)$/.exec(raw);
    if (!m) return null;
    const [, app, whole, type] = m;
    const body = type === 'service' ? whole.replace(/@[^@]*$/, '') : whole;
    if (!app) {
        // Without the "app-" prefix only D-Bus activated services are apps.
        const d = type === 'service' && DBUS_RE.exec(decodeUnit(body));
        return d ? {id: d[1], dbus: true} : null;
    }
    // systemd wraps "foo@x.service" in a per-template "app-foo.slice"; that slice is not an app.
    if (type === 'slice' && child?.includes('@') && decodeUnit(child.split('@')[0]) === decodeUnit(body))
        return null;

    // Split on raw dashes: dashes inside the app id are escaped as \x2d.
    const parts = body.split('-');
    if (type === 'scope' && parts.length > 1) parts.pop();   // random suffix
    if (parts.length > 1 && LAUNCHERS.has(parts[0])) parts.shift();
    const id = decodeUnit(parts.join('-'));
    const d = DBUS_RE.exec(id);
    if (d) return {id: d[1], dbus: true};
    return id ? {id, dbus: false} : null;
}

/**
 * Contents of /proc/<pid>/cgroup -> which group the process belongs to:
 * {kind: 'app' (id, dbus) | 'term' (id = scope) | 'shell' | 'background' | 'system' | 'comm', mine}.
 * `mine` is true for processes in this user's slice (the only ones whose GPU use we can read).
 */
export function parseCgroup(text, uid = UID) {
    const line = text.split('\n').find(l => l.startsWith('0::'));
    const path = line ? line.slice(3).trim() : '';
    const m = /^\/user\.slice\/user-(\d+)\.slice\/(.+)$/.exec(path);
    if (!m || (uid !== null && Number(m[1]) !== uid))
        return {kind: 'system', mine: false};   // kernel threads, system services, other users

    const parts = m[2].split('/');
    if (parts[0] !== `user@${m[1]}.service`) return {kind: 'comm', mine: true};   // e.g. a login session scope
    const rest = parts.slice(1);
    if (rest.length === 0) return {kind: 'comm', mine: true};
    if (rest[0] === 'init.scope') return {kind: 'system', mine: true};

    const term = rest.find(c => /^\w+-spawn-.+\.scope$/.test(c));
    if (term) return {kind: 'term', id: term, mine: true};
    for (let i = rest.length - 1; i >= 0; i--) {
        const app = appUnit(rest[i], rest[i + 1]);
        if (app) return {kind: 'app', ...app, mine: true};
    }
    if (rest.some(c => /^org\.gnome\.Shell@.+\.service$/.test(c))) return {kind: 'shell', mine: true};
    if (USER_GROUPS.has(rest[0]) && rest[rest.length - 1].endsWith('.service'))
        return {kind: 'background', mine: true};
    return {kind: 'comm', mine: true};
}

/** /proc/<pid>/stat -> {comm, ticks: utime + stime, start: starttime}, or null. */
export function parseStat(text) {
    const open = text.indexOf('('), close = text.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    // comm may hold spaces and ")", so count fields after the last ")": f[0] is field 3.
    const f = text.slice(close + 2).split(' ');
    const ticks = Number(f[11]) + Number(f[12]), start = Number(f[19]);
    if (!Number.isFinite(ticks) || !Number.isFinite(start)) return null;
    return {comm: text.slice(open + 1, close), ticks, start};
}

/** DRM fdinfo -> {client: unique client key or null, gfx: cumulative graphics ns or null}. */
export function parseFdinfo(text) {
    let id = null, pdev = '', gfx = null;
    for (const line of text.split('\n')) {
        const i = line.indexOf(':');
        if (i < 0) continue;
        const k = line.slice(0, i), v = line.slice(i + 1).trim();
        if (k === 'drm-client-id') id = v;
        else if (k === 'drm-pdev') pdev = v;
        else if (k === 'drm-engine-gfx') gfx = parseInt(v);   // "7536018403 ns"
    }
    return {client: id === null ? null : `${pdev}/${id}`, gfx: Number.isFinite(gfx) ? gfx : null};
}

function newAppInfo(id) {
    try {
        return Gio.DesktopAppInfo.new(`${id}.desktop`);
    } catch (e) {
        return null;
    }
}

// Session-started apps (at-spi, reminders...) only have a .desktop file in an autostart folder.
function autostartAppInfo(id) {
    for (const dir of [GLib.get_user_config_dir(), ...GLib.get_system_config_dirs()]) {
        try {
            const info = Gio.DesktopAppInfo.new_from_filename(`${dir}/autostart/${id}.desktop`);
            if (info) return info;
        } catch (e) {}
    }
    return null;
}

// Gio.DesktopAppInfo.search() is not used: its first call builds GIO's index and blocks for ~80 ms.
// The autostart lookup is a few file opens (~0.3 ms), so it is only tried for apps on display.
function findApp(id, autostart) {
    let e = appCache.get(id);
    if (!e) {
        e = {info: newAppInfo(id) ?? newAppInfo(id.toLowerCase()), searched: false};
        appCache.set(id, e);
    }
    if (!e.info && autostart && !e.searched) {
        e.searched = true;
        e.info = autostartAppInfo(id);
    }
    return e.info;
}

function themedIcon(name) {
    let icon = icons.get(name);
    if (!icon) icons.set(name, icon = Gio.ThemedIcon.new(name));
    return icon;
}

function tidyId(id) {
    const last = id.split('.').pop();
    return last ? last[0].toUpperCase() + last.slice(1) : id;
}

/** Group key -> {name, gicon}. Apps are resolved lazily, only when shown. */
function describe(key) {
    if (key.startsWith('app:')) {
        const id = key.slice(4), info = findApp(id, true);
        return {name: info?.get_name() ?? tidyId(id), gicon: info?.get_icon() ?? null};
    }
    if (key.startsWith('term:'))
        return {name: `${termNames.get(key.slice(5)) ?? 'Command'} (terminal)`, gicon: themedIcon('utilities-terminal-symbolic')};
    if (key.startsWith('comm:')) return {name: key.slice(5), gicon: null};
    const g = GROUPS[key];
    return {name: g.name, gicon: themedIcon(g.icon)};
}

function groupKey(cls, comm) {
    switch (cls.kind) {
    case 'app':
        // A D-Bus service with no .desktop file is not something the user launched.
        return cls.dbus && !findApp(cls.id, false) ? 'background' : `app:${cls.id}`;
    case 'term':
        return `term:${cls.id}`;
    case 'comm':
        return `comm:${comm}`;
    default:
        return cls.kind;
    }
}

const newEnergy = () => ({cpuJ: 0, gfxJ: 0, batCpuJ: 0, batGfxJ: 0, power: false});
const ema = (prev, v) => prev + ALPHA * (v - prev);

export class AppTracker {
    constructor() {
        this._procs = new Map();      // pid -> {start, ticks, cls, settled, key}
        this._gpu = new Map();        // drm client -> {pid, path, ns}
        this._now = new Map();        // group key -> smoothed {cpuW, gpuW, cpuPct}
        this._energy = newEnergy();   // since the last scan
        this._w = null;               // latest power figures
        this._energyTo = null;        // monotonic time _energy runs up to
        this._gap = false;
        this._lastScan = null;
        this._lastDiscovery = null;
        this._scan = null;
        this._idle = 0;
        this._cancellable = new Gio.Cancellable();
        this._viewActive = false;
        this._onBattery = false;
        this._ready = false;
        this._basis = 'watts';
        this._destroyed = false;
        // Measured cost, for tests and debugging.
        this.stats = {scans: 0, lastScanUs: 0, lastScanChunks: 0, maxChunkUs: 0, lastDiscoveryUs: 0, lastDiscoveryChunks: 0};
    }

    feed(s) {
        if (this._destroyed) return;
        const onBattery = s.status === 'Discharging';
        const pct = Number.isFinite(s.percent) ? s.percent : null;
        // Charged during a lock or suspend (e.g. lid closed, plugged in, unplugged, reopened): the
        // battery went up across the gap, so this is a new battery session.
        const chargedInGap = onBattery && session.onBattery && session.lastWall !== null &&
            s.wall - session.lastWall > MAX_DT && pct !== null && session.lastPercent !== null &&
            pct > session.lastPercent + 1;
        const firstFeed = !session.seen;
        session.seen = true;
        if (onBattery && (!session.onBattery || chargedInGap)) {
            Object.assign(session, {onBattery: true, since: s.wall, until: null, lastWall: s.wall, wh: new Map(),
                sawUnplug: !firstFeed});
        } else if (!onBattery && session.onBattery) {
            // Feeds stop while the screen is locked; time after the last battery feed may have been on AC.
            session.onBattery = false;
            session.until = Math.min(s.wall, (session.lastWall ?? s.wall) + MAX_DT);
        }
        if (onBattery) {
            session.lastWall = s.wall;
            session.lastPercent = pct;
        }
        this._onBattery = onBattery;

        const socket = s.socket ?? null, gfx = s.gfx ?? null;
        const cpu = s.cpu ?? (socket === null ? null : Math.max(0, socket - (gfx ?? 0)));
        this._w = {cpu, gfx, battery: onBattery};
        this._integrateTo(s.monotonic);
        this._maybeScan(s.monotonic);
    }

    setViewActive(active) {
        if (this._destroyed) return;
        this._viewActive = active;
        if (active) this._maybeScan(GLib.get_monotonic_time() / 1e6);
    }

    now(limit = 5) {
        const byCpu = this._basis === 'cpu';
        const apps = [...this._now]
            .sort((a, b) => byCpu ? b[1].cpuPct - a[1].cpuPct : b[1].cpuW + b[1].gpuW - a[1].cpuW - a[1].gpuW)
            .slice(0, limit)
            .map(([key, v]) => ({
                key, ...describe(key),
                watts: byCpu ? null : v.cpuW + v.gpuW,
                cpuW: byCpu ? null : v.cpuW,
                gpuW: byCpu ? null : v.gpuW,
                cpuPct: v.cpuPct,
            }));
        return {ready: this._ready, basis: this._basis, apps};
    }

    sinceUnplug(limit = 5) {
        const end = session.onBattery ? GLib.get_real_time() / 1e6 : session.until;
        const apps = [...session.wh]
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
            .map(([key, wh]) => ({key, ...describe(key), wh}));
        return {
            since: session.since,
            onBattery: session.onBattery,
            fromLogin: session.since !== null && !session.sawUnplug,
            seconds: session.since === null || end === null ? null : Math.max(0, end - session.since),
            apps,
        };
    }

    destroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        if (this._idle) GLib.source_remove(this._idle);
        this._idle = 0;
        this._scan?.disc?.dir?.close();
        this._scan = null;
        this._procs.clear();
        this._gpu.clear();
    }

    // Adds energy up to time t at the latest power figures.
    _integrateTo(t) {
        const dt = this._energyTo === null ? 0 : t - this._energyTo;
        this._energyTo = t;
        if (dt > MAX_DT) {
            this._gap = true;
            return;
        }
        const w = this._w, e = this._energy;
        if (dt <= 0 || !w) return;
        if (w.cpu !== null) {
            e.cpuJ += w.cpu * dt;
            e.power = true;
            if (w.battery) e.batCpuJ += w.cpu * dt;
        }
        if (w.gfx !== null) {
            e.gfxJ += w.gfx * dt;
            if (w.battery) e.batGfxJ += w.gfx * dt;
        }
    }

    _interval() {
        if (this._viewActive) return VIEW_INTERVAL;
        return this._onBattery ? BATTERY_INTERVAL : 0;   // on AC with the tab hidden: no scanning
    }

    _maybeScan(t) {
        const interval = this._interval();
        if (!interval || this._scan) return;
        if (this._lastScan !== null && t - this._lastScan < interval - 0.5) return;

        // Cut the energy at the scan start; it is split by the CPU time used since the previous one.
        this._integrateTo(t);
        const baseline = this._gap || this._lastScan === null || t - this._lastScan > 3 * interval;
        if (baseline) {
            // The old figures are stale from now on, not only once this scan ends.
            this._now.clear();
            this._ready = false;
        }
        this._scan = {
            phase: 'list', t, baseline,
            elapsed: baseline ? 0 : t - this._lastScan,
            energy: this._energy,
            pids: null, i: 0,
            procs: new Map(),
            ticks: new Map(), total: 0,       // group key -> CPU ticks used since the last scan
            gpuNs: new Map(), gpuTotal: 0,    // group key -> graphics ns since the last scan
            terms: new Map(),                 // terminal scope -> {comm, delta} of its busiest process
            disc: null,
            workUs: 0, chunks: 0, discUs: 0, discChunks: 0,
        };
        this._energy = newEnergy();
        this._gap = false;
        this._lastScan = t;
        this._listPids(this._scan);
    }

    // Listing /proc is one ~1-2 ms getdents call, too long for the main thread, so GIO's worker
    // thread does it and hands the names back in small batches.
    _listPids(s) {
        const pids = [];
        const proc = Gio.File.new_for_path('/proc');
        const next = en => en.next_files_async(LIST_BATCH, GLib.PRIORITY_LOW, this._cancellable, (_en, res) => {
            const start = GLib.get_monotonic_time();
            let infos = null;
            try {
                infos = en.next_files_finish(res);
            } catch (e) { /* cancelled or failed */ }
            if (this._scan !== s) return;
            if (!infos) {
                this._abortScan();
                return;
            }
            for (const info of infos) {
                const name = info.get_name(), c = name.charCodeAt(0);
                if (c >= 48 && c <= 57) pids.push(Number(name));
            }
            if (infos.length) {
                next(en);
            } else {
                en.close(null);
                s.pids = pids;
                s.phase = 'procs';
                this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => this._step());
            }
            this._account(s, start, false);
        });
        proc.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, this._cancellable, (_proc, res) => {
                let en = null;
                try {
                    en = proc.enumerate_children_finish(res);
                } catch (e) { /* cancelled or failed */ }
                if (this._scan !== s) return;
                if (en) next(en);
                else this._abortScan();
            });
    }

    _abortScan() {
        this._scan = null;
        this._gap = true;   // counters are now out of step with the energy; start over
    }

    _account(s, start, discovery) {
        const used = GLib.get_monotonic_time() - start;
        this.stats.maxChunkUs = Math.max(this.stats.maxChunkUs, used);
        if (discovery) {
            s.discUs += used;
            s.discChunks++;
        } else {
            s.workUs += used;
            s.chunks++;
        }
    }

    _step() {
        try {
            return this._stepInner();
        } catch (e) {
            console.error(`Power Glance: app scan failed: ${e.message}`);
            this._idle = 0;
            this._abortScan();
            return GLib.SOURCE_REMOVE;
        }
    }

    _stepInner() {
        const s = this._scan;
        const start = GLib.get_monotonic_time(), deadline = start + CHUNK_US;
        const phase = s.phase;
        if (phase === 'procs') {
            while (s.i < s.pids.length && GLib.get_monotonic_time() < deadline)
                this._readProc(s.pids[s.i++], s);
            if (s.i >= s.pids.length) s.phase = 'finish';
        } else if (phase === 'finish') {
            this._readGpu(s);
            this._attribute(s);
            const due = this._lastDiscovery === null || s.t - this._lastDiscovery >= GPU_REDISCOVER;
            s.phase = due ? 'discover' : 'done';
            if (due) this._startDiscovery(s);
        } else if (this._discoverStep(s.disc, deadline)) {
            s.phase = 'done';
        }

        this._account(s, start, phase === 'discover');
        if (s.phase !== 'done') return GLib.SOURCE_CONTINUE;

        Object.assign(this.stats, {scans: this.stats.scans + 1, lastScanUs: s.workUs, lastScanChunks: s.chunks});
        if (s.disc) Object.assign(this.stats, {lastDiscoveryUs: s.discUs, lastDiscoveryChunks: s.discChunks});
        this._scan = null;
        this._idle = 0;
        return GLib.SOURCE_REMOVE;
    }

    _readProc(pid, s) {
        const text = readText(`/proc/${pid}/stat`);
        const st = text && parseStat(text);
        if (!st) return;   // exited

        // pid + start time identifies a process even if the pid is reused.
        const prev = this._procs.get(pid);
        const same = prev?.start === st.start;
        let cls = prev?.cls;
        // Read the cgroup for a new process, and once more on its second scan: the shell moves a
        // freshly launched app into its own scope a moment after starting it.
        if (!same || !prev.settled) cls = parseCgroup(readText(`/proc/${pid}/cgroup`) ?? '');
        const key = groupKey(cls, st.comm);
        s.procs.set(pid, {start: st.start, ticks: st.ticks, cls, settled: same, key});

        // A process we have not seen started after the previous scan, so all its time is new.
        const delta = same ? Math.max(0, st.ticks - prev.ticks) : st.ticks;
        if (delta > 0) {
            s.ticks.set(key, (s.ticks.get(key) ?? 0) + delta);
            s.total += delta;
        }
        if (cls.kind === 'term') {
            const best = s.terms.get(cls.id);
            if (!best || delta > best.delta) s.terms.set(cls.id, {comm: st.comm, delta});
        }
    }

    _readGpu(s) {
        for (const [client, c] of this._gpu) {
            const info = parseFdinfo(readText(c.path) ?? '');
            if (info.client !== client || info.gfx === null) {
                this._gpu.delete(client);   // fd closed or reused; rediscovered later if still in use
                continue;
            }
            const delta = c.ns === null ? 0 : Math.max(0, info.gfx - c.ns);
            c.ns = info.gfx;
            const key = s.procs.get(c.pid)?.key;
            if (delta > 0 && key) {
                s.gpuNs.set(key, (s.gpuNs.get(key) ?? 0) + delta);
                s.gpuTotal += delta;
            }
        }
    }

    _attribute(s) {
        this._procs = s.procs;
        for (const [scope, best] of s.terms)
            if (best.delta > 0 || !termNames.has(scope)) termNames.set(scope, best.comm);

        // A baseline scan (after a pause) only sets the counters; _maybeScan already cleared the figures.
        if (!s.baseline) {
            this._split(s);
            this._ready = true;
        }

        for (const scope of termNames.keys()) {
            const key = `term:${scope}`;
            if (!s.terms.has(scope) && !this._now.has(key) && !session.wh.has(key)) termNames.delete(scope);
        }
    }

    _split(s) {
        const e = s.energy, dt = s.elapsed;
        const gfxSplit = s.gpuTotal > 0;   // otherwise graphics energy stays unattributed
        this._basis = e.power ? 'watts' : 'cpu';
        const keys = new Set([...s.ticks.keys(), ...s.gpuNs.keys(), ...this._now.keys()]);
        for (const key of keys) {
            const ticks = s.ticks.get(key) ?? 0;
            const cpuShare = s.total > 0 ? ticks / s.total : 0;
            const gpuShare = gfxSplit ? (s.gpuNs.get(key) ?? 0) / s.gpuTotal : 0;
            const v = {cpuW: cpuShare * e.cpuJ / dt, gpuW: gpuShare * e.gfxJ / dt, cpuPct: 100 * ticks / (dt * HZ * NCPU)};

            const prev = this._now.get(key);
            const next = prev
                ? {cpuW: ema(prev.cpuW, v.cpuW), gpuW: ema(prev.gpuW, v.gpuW), cpuPct: ema(prev.cpuPct, v.cpuPct)}
                : v;
            if (next.cpuW + next.gpuW < MIN_W && next.cpuPct < MIN_PCT) this._now.delete(key);
            else this._now.set(key, next);

            const wh = (cpuShare * e.batCpuJ + gpuShare * e.batGfxJ) / 3600;
            if (wh > 0 && session.since !== null) session.wh.set(key, (session.wh.get(key) ?? 0) + wh);
        }
    }

    // GPU clients are found by walking every fd of this user's processes, which is slow
    // (~20 ms in all), so it runs rarely and in small pieces, one fd per step.
    _startDiscovery(s) {
        this._lastDiscovery = s.t;
        const pids = [];
        for (const [pid, p] of s.procs) if (p.cls.mine) pids.push(pid);
        s.disc = {pids, i: 0, pid: 0, dir: null, found: new Map()};
    }

    _discoverStep(d, deadline) {
        let opened = 0;
        while (GLib.get_monotonic_time() < deadline) {
            if (!d.dir) {
                if (d.i >= d.pids.length) {
                    this._adoptGpu(d.found);
                    return true;
                }
                if (opened++ >= GPU_PIDS_PER_CHUNK) return false;
                d.pid = d.pids[d.i++];
                try {
                    d.dir = GLib.Dir.open(`/proc/${d.pid}/fd`, 0);
                } catch (e) { /* not ours to read, or exited */ }
                continue;
            }
            const fd = d.dir.read_name();
            if (fd === null) {
                d.dir.close();
                d.dir = null;
                continue;
            }
            this._probeFd(d, fd);
        }
        return false;
    }

    _probeFd(d, fd) {
        let target;
        try {
            target = GLib.file_read_link(`/proc/${d.pid}/fd/${fd}`);
        } catch (e) {
            return;
        }
        if (!target.startsWith('/dev/dri/')) return;
        const path = `/proc/${d.pid}/fdinfo/${fd}`;
        const info = parseFdinfo(readText(path) ?? '');
        // dup'd and inherited fds share a client; keep one file per client.
        if (info.client !== null && info.gfx !== null && !d.found.has(info.client))
            d.found.set(info.client, {pid: d.pid, path, ns: info.gfx});
    }

    _adoptGpu(found) {
        // Keep the counters of known clients so the next scan still sees their full delta.
        for (const [client, c] of found) {
            const known = this._gpu.get(client);
            if (known) c.ns = known.ns;
        }
        this._gpu = found;
    }
}
