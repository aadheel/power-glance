// Tests for apps.js. Run from the extension folder: gjs -m tests/test_apps.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import {AppTracker, decodeUnit, parseCgroup, parseFdinfo, parseStat} from '../apps.js';

let failures = 0;
function check(cond, msg) {
    if (cond) {
        print(`ok   ${msg}`);
    } else {
        failures++;
        printerr(`FAIL ${msg}`);
    }
}

// Record every GLib source apps.js creates, so we can prove destroy() removes them all.
const orig = {idle_add: GLib.idle_add, timeout_add: GLib.timeout_add, timeout_add_seconds: GLib.timeout_add_seconds};
const created = [];
for (const fn of Object.keys(orig)) {
    GLib[fn] = (...args) => {
        const id = orig[fn](...args);
        created.push(id);
        return id;
    };
}
const ctx = GLib.MainContext.default();
const liveSources = () => created.filter(id => ctx.find_source_by_id(id) !== null);

// ---- 1. cgroup -> app ----------------------------------------------------------------------------
print('# cgroup parsing');
const U = '0::/user.slice/user-1000.slice/user@1000.service';
const cgroupCases = [
    [`${U}/app.slice/app-gnome-com.anthropic.Claude-231666.scope`, {kind: 'app', id: 'com.anthropic.Claude', dbus: false}],
    [`${U}/app.slice/app-com.anthropic.Claude-231666.scope`, {kind: 'app', id: 'com.anthropic.Claude', dbus: false}],
    [String.raw`${U}/app.slice/app-gnome-google\x2dchrome-12345.scope`, {kind: 'app', id: 'google-chrome'}],
    [`${U}/app.slice/app-flatpak-org.mozilla.firefox-2345.scope`, {kind: 'app', id: 'org.mozilla.firefox'}],
    [String.raw`${U}/app.slice/app-dbus\x2d\x3a1.2\x2dorg.gnome.Nautilus@0.service`, {kind: 'app', id: 'org.gnome.Nautilus', dbus: true}],
    [`${U}/app.slice/app-dbus-:1.2-org.gnome.Nautilus@0.service`, {kind: 'app', id: 'org.gnome.Nautilus', dbus: true}],
    // The layout systemd actually uses here: a per-template slice around the dbus service.
    [String.raw`${U}/app.slice/app-dbus\x2d:1.2\x2dorg.gnome.Shell.Notifications.slice/dbus-:1.2-org.gnome.Shell.Notifications@0.service`,
        {kind: 'app', id: 'org.gnome.Shell.Notifications', dbus: true}],
    [`${U}/app.slice/app-org.gnome.Terminal.slice/vte-spawn-0d4c5e1a-9f3b-4c1e-8d2a-1b2c3d4e5f60.scope`,
        {kind: 'term', id: 'vte-spawn-0d4c5e1a-9f3b-4c1e-8d2a-1b2c3d4e5f60.scope'}],
    [`${U}/app.slice/app-org.gnome.Terminal.slice/gnome-terminal-server.service`, {kind: 'app', id: 'org.gnome.Terminal'}],
    [`${U}/app.slice/snap.firefox.firefox-1d2b3c4d-aaaa-bbbb-cccc-000000000000.scope`, {kind: 'app', id: 'firefox'}],
    [`${U}/session.slice/org.gnome.Shell@wayland.service`, {kind: 'shell'}],
    [`${U}/session.slice/org.gnome.Shell@x11.service`, {kind: 'shell'}],
    [`${U}/session.slice/gvfs-daemon.service`, {kind: 'background'}],
    [`${U}/background.slice/tracker-miner-fs-3.service`, {kind: 'background'}],
    [`${U}/app.slice/speech-dispatcher.service`, {kind: 'background'}],
    [String.raw`${U}/app.slice/app-gnome\x2dsession\x2dmanager.slice/gnome-session-manager@gnome.service`, {kind: 'background'}],
    [`${U}/init.scope`, {kind: 'system'}],
    ['0::/system.slice/upower.service', {kind: 'system', mine: false}],
    ['0::/system.slice/systemd-udevd.service/udev', {kind: 'system'}],
    ['0::/init.scope', {kind: 'system'}],
    ['0::/user.slice/user-120.slice/user@120.service/session.slice/org.gnome.Shell@wayland.service', {kind: 'system', mine: false}],
    ['0::/', {kind: 'system', mine: false}],
    ['', {kind: 'system'}],
    ['0::/user.slice/user-1000.slice/session-40.scope', {kind: 'comm', mine: true}],
    [`${U}/app.slice/some-random.scope`, {kind: 'comm'}],
    // Edge cases: dashes inside ids, KDE-style random suffix, cgroup v1 lines first, service instances.
    [String.raw`${U}/app.slice/app-gnome-org.gnome.Evolution\x2dalarm\x2dnotify-230208.scope`, {kind: 'app', id: 'org.gnome.Evolution-alarm-notify'}],
    [String.raw`${U}/app.slice/app-gnome-at\x2dspi\x2ddbus\x2dbus-229960.scope`, {kind: 'app', id: 'at-spi-dbus-bus'}],
    [`${U}/app.slice/app-org.kde.konsole-a1b2c3d4e5.scope`, {kind: 'app', id: 'org.kde.konsole'}],
    [`${U}/app.slice/app-gnome-org.gnome.Calculator@3f2a.service`, {kind: 'app', id: 'org.gnome.Calculator'}],
    [`${U}/app.slice/app-org.gnome.Terminal.slice/app-gnome-org.gnome.Terminal-777.scope`, {kind: 'app', id: 'org.gnome.Terminal'}],
    [`12:cpu,cpuacct:/foo\n${U}/app.slice/app-gnome-firefox-99.scope\n`, {kind: 'app', id: 'firefox', mine: true}],
];
for (const [text, want] of cgroupCases) {
    const got = parseCgroup(text, 1000);
    const ok = Object.entries(want).every(([k, v]) => got[k] === v);
    check(ok, `${text.split('/').slice(-2).join('/') || '(empty)'} -> ${JSON.stringify(got)}`);
}
check(decodeUnit(String.raw`dbus\x2d\x3a1.2`) === 'dbus-:1.2', 'decodeUnit handles \\xNN');

// ---- 2. /proc/<pid>/stat --------------------------------------------------------------------------
print('# stat parsing');
// Fields 3..22 after the comm: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt
// utime(14) stime(15) cutime cstime priority nice threads itreal starttime(22)
const fake = '4321 (x) (y z) S 1 4321 4321 0 -1 4194560 100 0 0 0 250 75 9 9 20 0 3 0 987654 1000 200\n';
const st = parseStat(fake);
check(st?.comm === 'x) (y z', `comm with ")" and spaces -> ${JSON.stringify(st?.comm)}`);
check(st?.ticks === 325, `utime + stime -> ${st?.ticks}`);
check(st?.start === 987654, `starttime -> ${st?.start}`);
check(parseStat('garbage') === null, 'garbage -> null');
const read = p => new TextDecoder().decode(GLib.file_get_contents(p)[1]);
const self = parseStat(read('/proc/self/stat'));
check(self?.comm === read('/proc/self/comm').trim() && self.ticks >= 0 && self.start > 0, `own process -> ${JSON.stringify(self)}`);

print('# fdinfo parsing');
const fd = parseFdinfo('pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-client-id:\t852\ndrm-pdev:\t0000:03:00.0\ndrm-engine-gfx:\t7536018403 ns\n');
check(fd.client === '0000:03:00.0/852' && fd.gfx === 7536018403, `amdgpu fdinfo -> ${JSON.stringify(fd)}`);
const noGfx = parseFdinfo('drm-client-id:\t873\ndrm-pdev:\t0000:03:00.0\n');
check(noGfx.gfx === null, 'client without gfx time -> gfx null');

// ---- 3. a real tracker on this machine ------------------------------------------------------------
print('# live tracker');
// The shell already has GIO's desktop-file cache loaded; warm it here so timings match.
Gio.DesktopAppInfo.new('org.gnome.Nautilus.desktop');
// search() blocks ~80 ms on its first call, so the tracker must never use it.
let searches = 0;
const origSearch = Gio.DesktopAppInfo.search;
Gio.DesktopAppInfo.search = (...args) => {
    searches++;
    return origSearch(...args);
};

const snap = (status, cpu = 3, gfx = 1, socket = 5) => ({
    monotonic: GLib.get_monotonic_time() / 1e6, wall: GLib.get_real_time() / 1e6,
    status, cpu, gfx, socket, percent: 50,
});
const fmtApp = a => `${a.name.padEnd(28)} ${a.watts === null ? '' : `${a.watts.toFixed(3)} W (cpu ${a.cpuW.toFixed(3)}, gpu ${a.gpuW.toFixed(3)})`}  ${a.cpuPct.toFixed(2)}% CPU`;
const sum = (list, f) => list.reduce((acc, a) => acc + (a[f] ?? 0), 0);

function runFor(seconds, onSecond) {
    const loop = new GLib.MainLoop(null, false);
    let sec = 0;
    orig.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        sec++;
        onSecond(sec);
        if (sec < seconds) return GLib.SOURCE_CONTINUE;
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

const tracker = new AppTracker();
const wallStart = GLib.get_real_time() / 1e6;
// Largest idle chunk per phase (the /proc listing callbacks only show up in stats.maxChunkUs).
const phaseMax = {};
tracker._step = function () {
    const phase = this._scan.phase, start = GLib.get_monotonic_time();
    const r = AppTracker.prototype._step.call(this);
    phaseMax[phase] = Math.max(phaseMax[phase] ?? 0, GLib.get_monotonic_time() - start);
    return r;
};
let seenScans = 0;
const noteScan = () => {
    if (tracker.stats.scans === seenScans) return;
    seenScans = tracker.stats.scans;
    print(`  scan ${seenScans}: ${(tracker.stats.lastScanUs / 1000).toFixed(2)} ms work in ${tracker.stats.lastScanChunks} chunks, ` +
        `largest piece so far ${(tracker.stats.maxChunkUs / 1000).toFixed(2)} ms`);
};

// On battery, tab hidden: one scan every 10 s (the first only sets the counters).
tracker.feed(snap('Discharging'));
runFor(15, sec => {
    noteScan();
    if (sec % 2 === 0) tracker.feed(snap('Discharging'));
});
noteScan();

const t0 = GLib.get_monotonic_time();
const now = tracker.now(Infinity);
const firstNowMs = (GLib.get_monotonic_time() - t0) / 1000;
print(`  now(): ready=${now.ready} basis=${now.basis}, ${now.apps.length} groups (first call ${firstNowMs.toFixed(1)} ms incl. name lookups)`);
for (const a of now.apps.slice(0, 8)) print(`    ${fmtApp(a)}`);
const total = sum(now.apps, 'watts'), gpu = sum(now.apps, 'gpuW');
print(`  attributed ${total.toFixed(3)} W (cpu ${sum(now.apps, 'cpuW').toFixed(3)} + gpu ${gpu.toFixed(3)}); GPU clients known: ${tracker._gpu.size}`);
check(tracker.stats.scans === 2, `two scans in 15 s on battery (got ${tracker.stats.scans})`);
check(now.ready && now.basis === 'watts' && now.apps.length > 0, 'ready with watts after the second scan');
check(Math.abs(sum(now.apps, 'cpuW') - 3) < 0.05, 'CPU watts add up to the 3 W fed in');
check(gpu === 0 || Math.abs(gpu - 1) < 0.05, 'graphics watts are 1 W, or unattributed when the GPU was idle');
check(tracker._gpu.size > 0, 'found at least one GPU client (gnome-shell)');
check(tracker.now(5).apps.length <= 5, 'now(5) returns at most 5 apps');

const since = tracker.sinceUnplug(Infinity);
const wh = sum(since.apps, 'wh');
print(`  sinceUnplug(): onBattery=${since.onBattery} since=${since.since?.toFixed(0)} seconds=${since.seconds?.toFixed(1)} total ${wh.toFixed(5)} Wh`);
for (const a of since.apps.slice(0, 5)) print(`    ${a.name.padEnd(28)} ${a.wh.toFixed(5)} Wh`);
const expectWh = (3 + (gpu > 0 ? 1 : 0)) * 10 / 3600;
check(since.onBattery && Math.abs(since.since - wallStart) < 1, 'battery session started at the first feed');
check(Math.abs(wh - expectWh) / expectWh < 0.15, `since-unplug Wh ≈ ${expectWh.toFixed(5)} (10 s at ${gpu > 0 ? 4 : 3} W)`);

// Tab open, now on the charger: scans every 4 s; the battery session ends but keeps its totals.
print('# view active on AC');
const scansBefore = tracker.stats.scans;
tracker.setViewActive(true);
// This first scan still splits the last few seconds on battery; let it finish before plugging in.
while (tracker._scan) ctx.iteration(false);
const whAtPlug = sum(tracker.sinceUnplug(Infinity).apps, 'wh');
runFor(6, sec => {
    noteScan();
    if (sec % 2 === 1) tracker.feed(snap('Charging'));
});
noteScan();
const after = tracker.sinceUnplug(Infinity);
check(tracker.stats.scans - scansBefore === 2, `scanning every 4 s with the tab open (got ${tracker.stats.scans - scansBefore} scans in 6 s)`);
check(!after.onBattery && after.since === since.since && after.apps.length >= since.apps.length,
    'plugging in keeps the finished session');
check(sum(after.apps, 'wh') === whAtPlug, 'no Wh added while on the charger');
check(tracker.now().ready, 'still ready on AC with the tab open');

tracker.setViewActive(false);
const scansIdle = tracker.stats.scans;
runFor(5, sec => {
    if (sec % 2 === 1) tracker.feed(snap('Charging'));
});
check(tracker.stats.scans === scansIdle && !tracker._idle, 'no scanning on AC with the tab hidden');
// Reopening after a long pause: the old figures must not show as current while the baseline scan runs.
tracker._lastScan -= 60;
tracker.setViewActive(true);
const reopened = tracker.now();
check(tracker._scan?.baseline && !reopened.ready && reopened.apps.length === 0,
    'reopening the tab after a pause shows "measuring", not old figures');
tracker.destroy();

// A screen lock destroys the tracker; the session must survive in module scope.
print('# new tracker (as after unlock), no power sensors');
const tracker2 = new AppTracker();
const kept = tracker2.sinceUnplug(Infinity);
check(kept.since === after.since && kept.apps.length === after.apps.length && kept.apps[0].name === after.apps[0].name,
    'since-unplug data survives destroy + new AppTracker');
tracker2.setViewActive(true);
tracker2.feed(snap('Charging', null, null, null));
runFor(5, sec => {
    if (sec % 2 === 0) tracker2.feed(snap('Charging', null, null, null));
});
const cpuNow = tracker2.now(Infinity);
const pct = sum(cpuNow.apps, 'cpuPct');
print(`  basis=${cpuNow.basis}, total ${pct.toFixed(2)}% CPU`);
for (const a of cpuNow.apps.slice(0, 5)) print(`    ${fmtApp(a)}`);
check(cpuNow.ready && cpuNow.basis === 'cpu' && cpuNow.apps.every(a => a.watts === null), 'no power figures -> basis cpu');
check(pct > 0 && pct <= 100.5, 'CPU percentages are a share of the whole processor');

tracker2.feed(snap('Discharging', null, null, null));
const fresh = tracker2.sinceUnplug();
check(fresh.onBattery && fresh.since > since.since && fresh.apps.length === 0, 'a new unplug starts a new session');
// Locked on battery, plugged in, unlocked 8 h later: the locked time is not battery time.
tracker2.feed({...snap('Charging', null, null, null), wall: fresh.since + 8 * 3600});
const ended = tracker2.sinceUnplug();
print(`  session after an 8 h locked gap: ${ended.seconds?.toFixed(1)} s`);
check(!ended.onBattery && ended.seconds !== null && ended.seconds <= 10, 'a locked gap before plugging in is not counted');
tracker2.destroy();

// Apps without a .desktop file in the application folders: autostart entries, never search().
print('# app names');
const tracker3 = new AppTracker();
tracker3._now.set('app:at-spi-dbus-bus', {cpuW: 1, gpuW: 0, cpuPct: 1});
const tn = GLib.get_monotonic_time();
const atspi = tracker3.now().apps[0];
const lookupMs = (GLib.get_monotonic_time() - tn) / 1000;
print(`  at-spi-dbus-bus -> "${atspi.name}" in ${lookupMs.toFixed(2)} ms`);
const hasAutostart = GLib.file_test('/etc/xdg/autostart/at-spi-dbus-bus.desktop', GLib.FileTest.EXISTS);
check(!hasAutostart || atspi.name !== 'At-spi-dbus-bus', 'autostart-only app gets its real name');
check(lookupMs < 2, 'name lookup stays under 2 ms');
check(searches === 0, `Gio.DesktopAppInfo.search() never called (${searches})`);
tracker3.destroy();

// ---- 4. destroy() leaves nothing running ----------------------------------------------------------
print('# destroy');
function destroyDuring(phaseReached, label) {
    const t = new AppTracker();
    let calls = 0;
    t._step = function () {
        calls++;
        return AppTracker.prototype._step.call(this);
    };
    t.setViewActive(true);
    const until = GLib.get_monotonic_time() + 5e6;
    while (!phaseReached(t._scan) && GLib.get_monotonic_time() < until) ctx.iteration(false);
    check(phaseReached(t._scan), `reached ${label}`);
    t.destroy();
    const callsAtDestroy = calls;
    // Let cancelled async listing callbacks come back; they must not restart anything.
    const settle = GLib.get_monotonic_time() + 3e5;
    while (GLib.get_monotonic_time() < settle) ctx.iteration(false);
    check(t._idle === 0 && calls === callsAtDestroy && liveSources().length === 0,
        `destroy during ${label}: no chunk ran afterwards, ${liveSources().length} sources left`);
    t.feed(snap('Discharging'));
    t.setViewActive(true);
    check(liveSources().length === 0, `feed/setViewActive after destroy (${label}) start nothing`);
}
destroyDuring(s => s?.phase === 'list', 'the /proc listing');
destroyDuring(s => s?.phase === 'procs' && s.i > 0, 'a process scan');
destroyDuring(s => s?.phase === 'discover' && s.disc.dir !== null, 'GPU discovery with a folder open');
check(created.length > 0 && liveSources().length === 0, `all ${created.length} sources created by apps.js are gone`);

const ms = us => `${(us / 1000).toFixed(2)} ms`;
print(`# cost: last full scan ${ms(tracker.stats.lastScanUs)} of main-thread work in ${tracker.stats.lastScanChunks} pieces; ` +
    `GPU discovery ${ms(tracker.stats.lastDiscoveryUs)} in ${tracker.stats.lastDiscoveryChunks} chunks`);
print(`# largest piece ${ms(tracker.stats.maxChunkUs)}; per phase: ` +
    Object.entries(phaseMax).map(([k, v]) => `${k} ${ms(v)}`).join(', '));
// The budget is ~1 ms per chunk; a loaded machine can preempt us, so only catch gross overruns.
check(tracker.stats.maxChunkUs < 3000, 'no piece of work came near blocking the shell (< 3 ms)');
check(failures === 0, `${failures} failures`);
if (failures) System.exit(1);
