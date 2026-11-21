// HistoryStore with synthetic snapshots. Run from the repo root: gjs -m tests/test_history.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import {HistoryStore} from '../history.js';

const ROOT = `/tmp/claude-1000/pg-history-test-${GLib.get_monotonic_time()}`;
let failures = 0, checks = 0;

function check(ok, msg) {
    checks++;
    if (!ok) {
        failures++;
        print(`FAIL: ${msg}`);
    }
}
const near = (a, b, eps, msg) => check(a !== null && Math.abs(a - b) <= eps, `${msg}: got ${a}, want ${b} ± ${eps}`);

function dir(name) {
    const d = `${ROOT}/${name}`;
    GLib.mkdir_with_parents(d, 0o755);
    return d;
}

// Lets async file I/O and idle callbacks run until cond() holds.
function runUntil(cond, timeoutMs = 5000) {
    const loop = new GLib.MainLoop(null, false);
    const start = Date.now();
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5, () => {
        if (cond() || Date.now() - start > timeoutMs) {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    });
    loop.run();
    return cond();
}

function readLines(d) {
    try {
        const [, bytes] = GLib.file_get_contents(`${d}/history.jsonl`);
        return new TextDecoder().decode(bytes).split('\n').filter(l => l.trim());
    } catch (e) {
        return [];
    }
}

const fileRecords = d => readLines(d).map(l => JSON.parse(l));
const unique = recs => new Set(recs.map(r => r.t)).size === recs.length;
const sorted = recs => recs.every((r, i) => i === 0 || r.t > recs[i - 1].t);

// A fake clock; tick() records a snapshot at the current time, then moves on 2 s.
function clock(wall) {
    return {wall, mono: 5000};
}

function tick(store, clk, {watts = 6, status = 'Discharging', measured = status === 'Discharging', percent = 50} = {}) {
    store.record({
        wall: clk.wall, monotonic: clk.mono, status, percent,
        system: watts, systemMeasured: measured,
    });
    clk.wall += 2;
    clk.mono += 2;
}

function feedUntil(store, clk, endWall, opts) {
    while (clk.wall <= endWall) tick(store, clk, opts);
}

const minuteOf = t => Math.floor(t / 60) * 60;

function localMidnight(unix) {
    const d = GLib.DateTime.new_from_unix_local(unix);
    return GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0).to_unix();
}

// Yesterday's local midnight: every synthetic time is in the past, so loads never treat it as future.
const NOW = Math.floor(GLib.get_real_time() / 1e6);
const M = localMidnight(NOW - 86400);
const CHARGING = {watts: 10, status: 'Charging', percent: 50};
const BATTERY = {watts: 6, status: 'Discharging', percent: 49};

// 1. Minute records, gaps, unplug, suspend, buckets and stats.
{
    const d = dir('basic');
    const store = new HistoryStore({dataDir: d});
    check(runUntil(() => store.ready), 'ready with no file');
    const T0 = M + 3600;
    const clk = clock(T0 + 1);
    feedUntil(store, clk, T0 + 179, CHARGING);
    feedUntil(store, clk, T0 + 299, BATTERY);          // unplugged at T0+180
    clk.wall += 30;                                    // screen locked for 30 s
    clk.mono += 30;
    feedUntil(store, clk, T0 + 599, BATTERY);

    const recs = store._st.records;
    const at = t => recs.find(r => r.t === t);
    check(recs.length === 9, `9 finished minutes, got ${recs.length}`);
    check(sorted(recs) && unique(recs), 'records ordered and unique');
    const r0 = at(T0);
    check(r0 && r0.c === 59 && r0.w === 10 && r0.m === 0 && r0.s === 'C' && r0.p === 50, `first minute ${JSON.stringify(r0)}`);
    const r2 = at(T0 + 120);
    check(r2 && r2.c === 60 && r2.w === 9.93 && r2.m === 0 && r2.s === 'C', `minute before unplug ${JSON.stringify(r2)}`);
    const r3 = at(T0 + 180);
    check(r3 && r3.c === 60 && r3.w === 6 && r3.m === 1 && r3.s === 'D' && r3.p === 49, `first battery minute ${JSON.stringify(r3)}`);
    check(at(T0 + 240)?.c === 59, 'minute cut by the lock keeps 59 s');
    check(at(T0 + 300)?.c === 29, 'minute after the lock has 29 s');
    check(store._st.cur.t === T0 + 540 && store._st.cur.cov === 59, 'partial minute holds 59 s');

    let s = store.stats();
    near(s.sinceUnplug?.since, T0 + 180, 0, 'unplug time');
    near(s.sinceUnplug?.wh, 388 * 6 / 3600 - 6 / 3600, 1e-6, 'energy since unplug');
    near(s.sinceUnplug?.seconds, 419, 1e-6, 'time since unplug');
    near(s.sinceUnplug?.avgW, 6, 1e-9, 'average since unplug');
    near(s.avgOnBattery, 6, 1e-9, 'average on battery');
    near(s.todayWh, (59 * 10 + 60 * 10 + 595.8 + 387 * 6) / 3600, 1e-6, 'energy today');
    check(s.todayApprox === true, 'today is approximate after charger minutes');

    let b = store.buckets();
    check(b.length === 96, `96 buckets, got ${b.length}`);
    const last = b[95];
    check(last.start <= T0 + 599 && T0 + 599 < last.start + 900, 'last bucket holds now');
    check(b[95].start - b[0].start === 95 * 900, 'buckets are 15 min apart');
    near(last.watts, (59 * 10 + 60 * 10 + 595.8 + 387 * 6) / (59 + 60 + 60 + 387), 1e-6, 'last bucket watts');
    check(last.measured === true, 'last bucket mostly measured');
    check(b.slice(0, 95).every(x => x.watts === null && !x.measured), 'other buckets empty');
    check(store.buckets(1, 5).length === 12, '1 h of 5-min buckets');

    // Suspended for an hour: wall time jumps, monotonic time doesn't.
    clk.wall += 3600;
    clk.mono += 2;
    feedUntil(store, clk, T0 + 4200 + 119, BATTERY);
    s = store.stats();
    near(s.sinceUnplug?.since, T0 + 180, 0, 'suspend keeps the unplug time');
    near(s.sinceUnplug?.avgW, 6, 1e-9, 'suspend does not dilute the average');
    near(s.sinceUnplug?.seconds, T0 + 4319 - (T0 + 180), 1e-6, 'time since unplug spans the suspend');
    const across = store._st.records.find(r => r.t === T0 + 540);
    check(across?.c === 59, `no energy across the suspend (c=${across?.c})`);
    b = store.buckets();
    check(b[95].watts === 6 && b[95].measured, 'bucket after resume');
    check(b[91].watts !== null && [92, 93, 94].every(i => b[i].watts === null), 'buckets during the suspend stay empty');

    // Plugged in again.
    feedUntil(store, clk, clk.wall + 30, CHARGING);
    s = store.stats();
    check(s.sinceUnplug === null, 'no "since unplugged" on the charger');
    near(s.avgOnBattery, 6, 1e-9, 'average on battery ignores charger minutes');

    // No data for a snapshot without a reading.
    const before = store._st.cur.cov;
    tick(store, clk, {watts: null, status: 'Charging'});
    check(store._st.cur.cov === before, 'null power adds no coverage');
    store.destroy();
    check(fileRecords(d).length === store._st.records.length, 'destroy writes every finished minute');
}

// 2. Midnight.
{
    const d = dir('midnight');
    const store = new HistoryStore({dataDir: d});
    runUntil(() => store.ready);
    const clk = clock(M - 600 + 1);
    feedUntil(store, clk, M + 599, {watts: 8, status: 'Discharging'});
    let s = store.stats();
    near(s.todayWh, 599 * 8 / 3600, 1e-6, 'today starts at local midnight');
    check(s.todayApprox === false, 'today measured');
    near(s.avgOnBattery, 8, 1e-9, 'average across midnight');
    near(s.sinceUnplug?.since, M - 599, 0, 'unplug before midnight still counts');
    feedUntil(store, clk, M + 700, {watts: 20, status: 'Charging'});
    s = store.stats();
    check(s.todayApprox === true, 'charger minute makes today approximate');
    near(s.todayWh, (599 * 8 + 100 * 20) / 3600, 1e-6, 'today with charger');
    store.destroy();
}

// 3. Lock/unlock: destroy + new store keeps memory and the partial minute; files have no duplicates.
{
    const d = dir('lock');
    const a = new HistoryStore({dataDir: d});
    runUntil(() => a.ready);
    const P0 = M + 7200;
    const clk = clock(P0 + 1);
    feedUntil(a, clk, P0 + 301, BATTERY);
    a._flush();
    check(runUntil(() => readLines(d).length === 5 && !a._st.busy), 'timed flush appends 5 minutes');
    check(a._st.pending.length === 0, 'nothing pending after the flush');
    feedUntil(a, clk, P0 + 450, BATTERY);              // stop half way through minute P0+420
    const memBefore = a._st.records.length;
    a.destroy();
    check(readLines(d).length === memBefore, `destroy flushed (${readLines(d).length}/${memBefore})`);
    a.record({wall: clk.wall, monotonic: clk.mono, status: 'Discharging', system: 99, systemMeasured: true, percent: 1});
    check(a._st.records.length === memBefore, 'destroyed store ignores snapshots');

    const b = new HistoryStore({dataDir: d});
    check(b.ready, 'new store is ready at once');
    check(b._st.records.length === memBefore, 'new store keeps records in memory');
    feedUntil(b, clk, P0 + 600, BATTERY);              // within 10 s of the last tick: joined
    const whole = b._st.records.find(r => r.t === P0 + 420);
    check(whole?.c === 60, `partial minute survived the unlock (c=${whole?.c})`);
    b.destroy();

    const c = new HistoryStore({dataDir: d});
    clk.wall += 40;                                    // locked for 40 s
    clk.mono += 40;
    feedUntil(c, clk, P0 + 780, BATTERY);
    const cut = c._st.records.find(r => r.t === P0 + 600);
    check(cut && cut.c < 60, `long lock leaves a hole (c=${cut?.c})`);
    c.destroy();

    const onDisk = fileRecords(d);
    check(unique(onDisk) && sorted(onDisk), 'file has each minute once, in order');
    check(onDisk.length === c._st.records.length, `file matches memory (${onDisk.length}/${c._st.records.length})`);

    // Round trip: a fresh process (new data dir key) reads the same file.
    const d2 = dir('lock-copy');
    GLib.file_set_contents(`${d2}/history.jsonl`, GLib.file_get_contents(`${d}/history.jsonl`)[1]);
    const fresh = new HistoryStore({dataDir: d2});
    check(!fresh.ready, 'fresh store loads asynchronously');
    check(runUntil(() => fresh.ready), 'fresh store loads');
    check(JSON.stringify(fresh._st.records) === JSON.stringify(c._st.records), 'records survive a round trip');
    fresh.record({wall: clk.wall, monotonic: clk.mono, status: 'Discharging', system: 6, systemMeasured: true, percent: 40});
    const s = fresh.stats();
    check(s.sinceUnplug !== null && s.sinceUnplug.since === P0 + 1, `run read back from disk (since ${s.sinceUnplug?.since})`);
    fresh.destroy();
}

// 4. Minutes recorded and flushed before the load finishes; damaged file gets cleaned.
{
    const d = dir('early');
    const Q0 = M + 10800;
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(JSON.stringify({t: Q0 + i * 60, w: 5, c: 60, m: 1, s: 'D', p: 80}));
    lines.splice(10, 0, lines[5]);                                    // duplicate
    lines.splice(3, 0, '{"t": 12, "w": broken');                      // malformed
    lines.unshift(JSON.stringify({t: minuteOf(M - 8 * 86400), w: 5, c: 60, m: 1, s: 'D', p: 80}));   // too old
    lines.push(JSON.stringify({t: Q0 + 45 * 60, w: 'x', c: 60}));      // wrong type
    GLib.file_set_contents(`${d}/history.jsonl`, `${lines.join('\n')}\n`);

    const store = new HistoryStore({dataDir: d});
    const clk = clock(Q0 + 40 * 60 + 1);
    feedUntil(store, clk, Q0 + 43 * 60 + 30, BATTERY);   // 3 finished minutes before the load ran
    check(!store.ready && store._st.records.length === 3, 'minutes recorded before the load');
    store._flush();                                      // append races the load
    check(runUntil(() => store.ready && !store._st.busy && !store._st.rewrite), 'load, append and rewrite finish');
    const recs = store._st.records;
    check(recs.length === 33 && unique(recs) && sorted(recs), `33 unique records in memory, got ${recs.length}`);
    const onDisk = fileRecords(d);
    check(onDisk.length === 33 && unique(onDisk) && sorted(onDisk), `file cleaned to 33 records, got ${onDisk.length}`);
    check(readLines(d).every(l => !l.includes('broken')), 'malformed line removed');
    store.destroy();
    check(fileRecords(d).length === 33, 'nothing written twice on destroy');
}

// 5. Destroyed before the load finished: the next store reloads without duplicating.
{
    const d = dir('early-destroy');
    const Q0 = M + 14400;
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(JSON.stringify({t: Q0 + i * 60, w: 4, c: 60, m: 1, s: 'D', p: 70}));
    GLib.file_set_contents(`${d}/history.jsonl`, `${lines.join('\n')}\n`);
    const e = new HistoryStore({dataDir: d});
    const clk = clock(Q0 + 30 * 60 + 1);
    feedUntil(e, clk, Q0 + 33 * 60 + 10, BATTERY);
    e.destroy();                                          // load cancelled, 3 minutes appended
    const f = new HistoryStore({dataDir: d});
    check(!f.ready, 'reloads after a cancelled load');
    check(runUntil(() => f.ready), 'reload finishes');
    const recs = f._st.records;
    check(recs.length === 23 && unique(recs) && sorted(recs), `23 unique records after reload, got ${recs.length}`);
    feedUntil(f, clk, Q0 + 34 * 60 + 10, BATTERY);
    f.destroy();
    const onDisk = fileRecords(d);
    check(onDisk.length === 24 && unique(onDisk), `24 unique minutes on disk, got ${onDisk.length}`);
}

// 6. Buckets over two hours: one on the charger, one on battery.
{
    const d = dir('buckets');
    const store = new HistoryStore({dataDir: d});
    runUntil(() => store.ready);
    const B0 = M + 18000;
    const clk = clock(B0);
    feedUntil(store, clk, B0 + 3600, {watts: 12, status: 'Charging'});
    feedUntil(store, clk, B0 + 7200 - 2, {watts: 5, status: 'Discharging'});
    const b = store.buckets();
    const byStart = t => b.find(x => x.start === t);
    for (let i = 0; i < 4; i++) {
        const x = byStart(B0 + i * 900);
        check(x && Math.abs(x.watts - 12) < 0.05 && !x.measured, `charger bucket ${i}: ${JSON.stringify(x)}`);
    }
    for (let i = 5; i < 8; i++) {
        const x = byStart(B0 + i * 900);
        check(x && Math.abs(x.watts - 5) < 1e-6 && x.measured, `battery bucket ${i}: ${JSON.stringify(x)}`);
    }
    check(b[b.length - 1].start === B0 + 7 * 900, 'graph ends with the current bucket');
    check(b.filter(x => x.watts !== null).length === 8, '8 filled buckets');
    store.destroy();
}

// 7. A week of minutes: loading and the 2-second calls stay cheap.
{
    const d = dir('week');
    const end = minuteOf(NOW) - 60;
    const parts = [];
    for (let t = end - 7 * 86400 + 120; t <= end; t += 60)
        parts.push(`{"t":${t},"w":${(5 + (t % 7)).toFixed(2)},"c":60,"m":1,"s":"${t % 3600 < 1800 ? 'D' : 'C'}","p":60}\n`);
    GLib.file_set_contents(`${d}/history.jsonl`, parts.join(''));
    const store = new HistoryStore({dataDir: d});
    check(runUntil(() => store.ready), 'week loads');
    check(store._st.records.length === parts.length, `all ${parts.length} minutes loaded`);
    store.record({wall: end + 61, monotonic: 1, status: 'Discharging', system: 6, systemMeasured: true, percent: 60});
    store.record({wall: end + 63, monotonic: 3, status: 'Discharging', system: 6, systemMeasured: true, percent: 60});
    let t0 = GLib.get_monotonic_time();
    store.buckets();
    store.stats();
    const cold = (GLib.get_monotonic_time() - t0) / 1000;
    t0 = GLib.get_monotonic_time();
    for (let i = 0; i < 100; i++) {
        store.buckets();
        store.stats();
    }
    const warm = (GLib.get_monotonic_time() - t0) / 100000;
    print(`week: ${store._st.records.length} records, first call ${cold.toFixed(2)} ms, cached call ${warm.toFixed(3)} ms`);
    check(cold < 20 && warm < 1, 'buckets() + stats() are cheap');
    store.destroy();
}

// 8. The wall clock jumps back two hours: the wrongly dated minutes go, the new ones stay.
{
    const d = dir('clock-back');
    const store = new HistoryStore({dataDir: d});
    runUntil(() => store.ready);
    const C0 = M + 30000;
    const clk = clock(C0 + 7200 + 1);
    feedUntil(store, clk, C0 + 7200 + 5 * 60 + 10, BATTERY);
    store._flush();
    check(runUntil(() => !store._st.busy && readLines(d).length === 5), 'future-dated minutes on disk');
    clk.wall -= 7200;                                   // now about C0 + 5 min
    feedUntil(store, clk, C0 + 15 * 60 + 10, BATTERY);
    const recs = store._st.records;
    check(recs.length === 10 && recs[0].t === C0 + 300 && recs.every(r => r.t < C0 + 3600) && sorted(recs),
        `only the 10 real minutes kept, got ${recs.length}`);
    const st = store.stats();
    check(st.sinceUnplug && st.sinceUnplug.since <= clk.wall && st.sinceUnplug.seconds > 500, 'since unplugged uses the corrected clock');
    store._flush();
    check(runUntil(() => !store._st.busy && !store._st.rewrite && !store._st.pending.length), 'rewrite and append finish');
    const onDisk = fileRecords(d);
    check(JSON.stringify(onDisk) === JSON.stringify(recs), `file matches memory after the jump (${onDisk.length})`);
    // A small step back only drops the repeated minute.
    clk.wall -= 70;
    feedUntil(store, clk, C0 + 18 * 60 + 10, BATTERY);
    const after = store._st.records;
    check(after.length === 13 && after[10].t === C0 + 900 && after[12].t === C0 + 1020 && sorted(after),
        `small step drops only the repeats, got ${after.map(r => (r.t - C0) / 60)}`);
    store.destroy();
}

// 9. A file whose last line has no newline: the next append still starts a new line.
{
    const d = dir('no-newline');
    const N0 = M + 39960;
    const lines = [0, 1, 2].map(i => JSON.stringify({t: N0 + i * 60, w: 5, c: 60, m: 1, s: 'D', p: 50}));
    GLib.file_set_contents(`${d}/history.jsonl`, lines.join('\n'));
    const store = new HistoryStore({dataDir: d});
    check(runUntil(() => store.ready && !store._st.busy && !store._st.rewrite), 'load and cleanup finish');
    const clk = clock(N0 + 600 + 1);
    feedUntil(store, clk, N0 + 600 + 3 * 60 + 10, BATTERY);
    store.destroy();
    const onDisk = fileRecords(d);
    check(onDisk.length === 6 && unique(onDisk) && sorted(onDisk), `6 records readable, got ${onDisk.length}`);
}

// 10. A long session: minutes older than a week are pruned from the file too, not only memory.
{
    const d = dir('prune');
    const start = minuteOf(NOW - 7 * 86400) + 3600;
    const parts = [];
    for (let t = start; t < start + 2 * 86400; t += 60)
        parts.push(`{"t":${t},"w":5,"c":60,"m":1,"s":"D","p":60}\n`);
    GLib.file_set_contents(`${d}/history.jsonl`, parts.join(''));
    const store = new HistoryStore({dataDir: d});
    check(runUntil(() => store.ready), 'two days load');
    check(store._st.records.length === parts.length && !store._st.rewrite, 'nothing to prune at load');
    // A day and a half later in the same session.
    store.record({wall: NOW + 1.5 * 86400, monotonic: 1, status: 'Discharging', system: 6, systemMeasured: true, percent: 60});
    store._flush();
    check(runUntil(() => !store._st.busy && !store._st.rewrite), 'prune rewrite finishes');
    const cutoff = NOW + 1.5 * 86400 - 7 * 86400;
    const onDisk = fileRecords(d);
    check(onDisk.length === store._st.records.length && onDisk.every(r => r.t >= cutoff) && onDisk.length < parts.length,
        `file pruned to ${store._st.records.length} records, got ${onDisk.length}`);
    store.destroy();
}

// Clean up.
function rmrf(path) {
    const f = Gio.File.new_for_path(path);
    if (GLib.file_test(path, GLib.FileTest.IS_DIR)) {
        const en = f.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = en.next_file(null)) !== null) rmrf(`${path}/${info.get_name()}`);
        en.close(null);
    }
    f.delete(null);
}
rmrf(ROOT);

print(`${checks - failures}/${checks} checks passed`);
if (failures) System.exit(1);
