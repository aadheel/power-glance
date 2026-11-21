// Tests for battery.js. Run from the repo root: gjs -m tests/test_battery.js
// Fake batteries live under /tmp/claude-1000 and are removed at the end.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';
import {BatteryInfo, parseChargeTypes, planWrites, limitActive, LIMIT_END, LIMIT_START} from '../battery.js';

let passed = 0, failed = 0;
function check(cond, msg) {
    if (cond) {
        passed++;
    } else {
        failed++;
        printerr(`FAIL: ${msg}`);
    }
}
const eq = (got, want, msg) =>
    check(JSON.stringify(got) === JSON.stringify(want), `${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const near = (got, want, tol, msg) => check(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`);

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

/** read() once the first (async) charge-limit check has finished. */
async function settled(info) {
    for (let i = 0; i < 300; i++) {
        const r = info.read();
        if (!r.limit.pending) return r;
        await sleep(10);
    }
    throw new Error('the charge-limit check never finished');
}

const decoder = new TextDecoder();
function cat(path) {
    try {
        return decoder.decode(GLib.file_get_contents(path)[1]).trim();
    } catch (e) {
        return null;
    }
}

const BASE = `/tmp/claude-1000/pg-battery-test-${GLib.random_int()}`;
let fakeCount = 0;

/** A fake /sys/class/power_supply with one battery. `modes` maps a file name to a chmod mode. */
function fakeBattery(files, modes = {}) {
    const root = `${BASE}/ps${fakeCount++}`;
    const dir = `${root}/BAT0`;
    GLib.mkdir_with_parents(dir, 0o755);
    const all = {
        type: 'Battery', present: '1', status: 'Discharging', capacity: '55',
        charge_full: '2545000', charge_full_design: '3528000', charge_now: '1400000',
        voltage_min_design: '15000000', cycle_count: '411', manufacturer: 'ACME', model_name: 'TEST 1',
        ...files,
    };
    for (const [name, value] of Object.entries(all)) {
        if (value !== undefined) GLib.file_set_contents(`${dir}/${name}`, `${value}\n`);
    }
    for (const [name, mode] of Object.entries(modes)) GLib.chmod(`${dir}/${name}`, mode);
    const vendorFile = `${root}/sys_vendor`;
    GLib.file_set_contents(vendorFile, 'ACME Inc.\n');
    return {root, dir, vendorFile};
}

// Behaves like a kernel driver: rejects a start at or above the end and a start below min_start,
// keeps charge_types as "A [B] C", and logs every attempted write to writes.log.
const DRIVER = [
    'v=$1; p=$2; d=${p%/*}',
    'echo "${p##*/}=$v" >> "$d/writes.log"',
    'case "$p" in',
    '*/charge_types)',
    '    all=$(tr -d "[]" < "$p")',
    '    case " $all " in *" $v "*) ;; *) echo "write error: Invalid argument" >&2; exit 1 ;; esac',
    '    out=""',
    '    for m in $all; do if [ "$m" = "$v" ]; then out="$out [$m]"; else out="$out $m"; fi; done',
    '    printf "%s\\n" "${out# }" > "$p" ;;',
    '*/charge_control_end_threshold)',
    '    s=$(cat "$d/charge_control_start_threshold" 2>/dev/null || echo -1)',
    '    [ "$s" -lt "$v" ] || { echo "write error: Invalid argument" >&2; exit 1; }',
    '    printf "%s\\n" "$v" > "$p" ;;',
    '*/charge_control_start_threshold)',
    '    e=$(cat "$d/charge_control_end_threshold"); min=$(cat "$d/min_start" 2>/dev/null || echo 0)',
    '    [ "$v" -lt "$e" ] && [ "$v" -ge "$min" ] || { echo "write error: Invalid argument" >&2; exit 1; }',
    '    printf "%s\\n" "$v" > "$p" ;;',
    'esac',
].join('\n');
const driverArgv = (value, path) => ['/bin/sh', '-c', DRIVER, 'sh', value, path];
const writesLog = dir => (cat(`${dir}/writes.log`) ?? '').split('\n').filter(Boolean);

function testParsing() {
    eq(parseChargeTypes('Standard Adaptive [Custom]'), {modes: ['Standard', 'Adaptive', 'Custom'], active: 'Custom'}, 'charge_types Custom');
    eq(parseChargeTypes('[Standard] Long_Life\n'), {modes: ['Standard', 'Long_Life'], active: 'Standard'}, 'charge_types Standard');
    eq(parseChargeTypes(null), {modes: [], active: null}, 'charge_types missing');
    eq(parseChargeTypes(''), {modes: [], active: null}, 'charge_types empty');

    eq(limitActive({end: 80, modes: [], mode: null}), true, 'end 80, no modes');
    eq(limitActive({end: 100, modes: [], mode: null}), false, 'end 100, no modes');
    eq(limitActive({end: 80, modes: ['Standard', 'Custom'], mode: 'Standard'}), false, 'end 80 but Standard mode');
    eq(limitActive({end: 80, modes: ['Standard', 'Custom'], mode: 'Custom'}), true, 'end 80 in Custom mode');
    eq(limitActive({end: 100, modes: ['Standard', 'Custom'], mode: 'Custom'}), false, 'Custom at 100');
    eq(limitActive({end: 80, modes: ['Fast', 'Standard'], mode: 'Standard'}), true, 'no Custom mode: thresholds rule');
    eq(limitActive({end: null, modes: [], mode: null}), null, 'end unknown');
}

// Every plan must keep start < end after each write and end at the target.
function testOrdering() {
    const starts = [null, 0, 40, 50, 74, 75, 78, 79, 80, 85, 90, 95, 99];
    const ends = [55, 60, 76, 80, 81, 86, 90, 96, 100];
    let cases = 0;
    for (const enabled of [true, false]) {
        for (const start of starts) {
            for (const end of ends) {
                if (start !== null && start >= end) continue;
                const cur = {end, start, hasStart: start !== null, modes: [], mode: null};
                const s = {...cur};
                const name = `${enabled ? 'on' : 'off'} from start=${start} end=${end}`;
                for (const step of planWrites(cur, enabled)) {
                    const v = Number(step.value);
                    if (step.file === 'charge_control_end_threshold') s.end = v;
                    else if (step.file === 'charge_control_start_threshold') s.start = v;
                    if (s.start !== null) check(s.start < s.end, `${name}: start ${s.start} >= end ${s.end} after ${step.file}`);
                }
                if (enabled) {
                    eq(s.end, LIMIT_END, `${name}: end`);
                    if (cur.hasStart) eq(s.start, LIMIT_START, `${name}: start`);
                } else {
                    eq(s.end, 100, `${name}: end`);
                    if (cur.hasStart) eq(s.start, 0, `${name}: start`);
                }
                cases++;
            }
        }
    }
    check(cases > 100, 'ordering grid ran');

    const types = {end: 90, start: 50, hasStart: true, modes: ['Standard', 'Adaptive', 'Custom'], mode: 'Standard'};
    eq(planWrites(types, true).map(s => `${s.file}=${s.value}`),
        ['charge_types=Custom', 'charge_control_end_threshold=80', 'charge_control_start_threshold=75'], 'on with charge_types');
    eq(planWrites({...types, mode: 'Custom', end: 80, start: 75}, true), [], 'already on: nothing to write');
    eq(planWrites({...types, mode: 'Custom', end: 80, start: 75}, false).map(s => `${s.file}=${s.value}`),
        ['charge_types=Standard'], 'off with charge_types only switches mode');
    eq(planWrites({end: 80, start: 75, hasStart: true, modes: [], mode: null}, false),
        [{file: 'charge_control_end_threshold', value: '100'}, {file: 'charge_control_start_threshold', value: '0', optional: true}],
        'off without charge_types: start=0 is optional');
    eq(planWrites({end: 100, start: null, hasStart: false, modes: [], mode: null}, true),
        [{file: 'charge_control_end_threshold', value: '80'}], 'end only');
}

async function testStates() {
    // No battery at all.
    const empty = `${BASE}/empty`;
    GLib.mkdir_with_parents(empty, 0o755);
    let info = new BatteryInfo({root: empty, vendorFile: `${empty}/none`});
    let r = info.read();
    eq([r.present, r.healthPct, r.limit.state, r.vendor], [false, null, 'none', null], 'no battery');
    eq((await info.setLimit(true)).ok, false, 'setLimit without battery');
    info.destroy();

    // Charge-based battery without a limit; a mouse battery sorted first is skipped.
    let fb = fakeBattery({cycle_count: '0'});
    GLib.mkdir_with_parents(`${fb.root}/AAA-mouse`, 0o755);
    GLib.file_set_contents(`${fb.root}/AAA-mouse/type`, 'Battery\n');
    GLib.file_set_contents(`${fb.root}/AAA-mouse/scope`, 'Device\n');
    info = new BatteryInfo(fb);
    r = info.read();
    eq([r.present, r.status, r.percent, r.cycles, r.manufacturer, r.model, r.vendor],
        [true, 'Discharging', 55, null, 'ACME', 'TEST 1', 'ACME Inc.'], 'basic fields (cycle_count 0 means unknown)');
    near(r.healthPct, 72.14, 0.01, 'health from charge');
    near(r.fullWh, 38.175, 0.001, 'full Wh from charge × design voltage');
    near(r.designWh, 52.92, 0.001, 'design Wh');
    near(r.nowWh, 21, 0.001, 'now Wh');
    eq(r.whApprox, true, 'charge-based Wh is approximate');
    eq(r.limit, {state: 'none', enabled: null, start: null, end: null, mode: null, pending: false}, 'state none');
    // Health is kept for a minute (no firmware call on every update); status and charge are read live.
    GLib.file_set_contents(`${fb.dir}/charge_full`, '2000000\n');
    GLib.file_set_contents(`${fb.dir}/status`, 'Charging\n');
    GLib.file_set_contents(`${fb.dir}/charge_now`, '700000\n');
    r = info.read();
    near(r.healthPct, 72.14, 0.01, 'health is cached');
    eq([r.status, r.nowWh], ['Charging', 10.5], 'status and now Wh are live');
    info.destroy();

    // Energy-based battery.
    fb = fakeBattery({energy_full: '40000000', energy_full_design: '50000000', energy_now: '20000000'});
    info = new BatteryInfo(fb);
    r = info.read();
    eq([r.healthPct, r.fullWh, r.designWh, r.nowWh, r.whApprox], [80, 40, 50, 20, false], 'health from energy');
    info.destroy();

    // Unreadable: the file exists but reading fails. Pending until the async check has run.
    fb = fakeBattery({charge_control_end_threshold: '80', charge_types: 'Standard [Custom]'},
        {charge_control_end_threshold: 0o000});
    info = new BatteryInfo(fb);
    r = info.read();
    eq([r.limit.state, r.limit.pending], ['unreadable', true], 'pending before the first check');
    r = await settled(info);
    eq(r.limit, {state: 'unreadable', enabled: null, start: null, end: null, mode: null, pending: false}, 'state unreadable');
    eq((await info.setLimit(true)).ok, false, 'setLimit refused when unreadable');
    info.destroy();

    // Read-only: readable, but not writable by us.
    fb = fakeBattery({charge_control_end_threshold: '80', charge_control_start_threshold: '75', charge_types: 'Standard Adaptive [Custom]'},
        {charge_control_end_threshold: 0o444, charge_control_start_threshold: 0o444, charge_types: 0o444});
    info = new BatteryInfo(fb);
    r = await settled(info);
    eq(r.limit, {state: 'readonly', enabled: true, start: 75, end: 80, mode: 'Custom', pending: false}, 'state readonly');
    const res = await info.setLimit(false);
    check(!res.ok && typeof res.error === 'string', 'setLimit refused when read-only');
    eq(cat(`${fb.dir}/charge_types`), 'Standard Adaptive [Custom]', 'read-only file untouched');
    // After the one-time setup the switch works without a restart.
    for (const n of ['charge_control_end_threshold', 'charge_control_start_threshold', 'charge_types'])
        GLib.chmod(`${fb.dir}/${n}`, 0o644);
    eq(info.read().limit.state, 'ready', 'writable again: ready');
    info.destroy();

    // A cancelled first check stores nothing.
    fb = fakeBattery({charge_control_end_threshold: '100'});
    info = new BatteryInfo(fb);
    info.destroy();
    await sleep(50);
    info = new BatteryInfo(fb);
    eq(info.read().limit.pending, true, 'destroy() cancels the first check');
    r = await settled(info);
    eq([r.limit.state, r.limit.enabled], ['ready', false], 'state ready, off');
    info.destroy();
}

async function testSetLimit() {
    // The real write command (sh + printf) on plain files, thresholds only.
    let fb = fakeBattery({charge_control_end_threshold: '100', charge_control_start_threshold: '0'});
    let info = new BatteryInfo(fb);
    await settled(info);
    eq(await info.setLimit(true), {ok: true}, 'on (default writer)');
    eq([cat(`${fb.dir}/charge_control_end_threshold`), cat(`${fb.dir}/charge_control_start_threshold`)], ['80', '75'], 'files after on');
    eq(info.read().limit.enabled, true, 'enabled after on');
    eq(await info.setLimit(false), {ok: true}, 'off (default writer)');
    eq([cat(`${fb.dir}/charge_control_end_threshold`), cat(`${fb.dir}/charge_control_start_threshold`)], ['100', '0'], 'files after off');
    eq(info.read().limit.enabled, false, 'disabled after off');
    info.destroy();

    // Dell-style: charge_types plus thresholds that keep their Custom values in Standard mode.
    fb = fakeBattery({charge_control_end_threshold: '90', charge_control_start_threshold: '50', charge_types: '[Standard] Adaptive Custom'});
    info = new BatteryInfo({...fb, writeArgv: driverArgv});
    eq((await settled(info)).limit.enabled, false, 'Standard mode is off');
    eq(await info.setLimit(true), {ok: true}, 'on with charge_types');
    eq(writesLog(fb.dir), ['charge_types=Custom', 'charge_control_end_threshold=80', 'charge_control_start_threshold=75'], 'write order on');
    eq(info.read().limit, {state: 'ready', enabled: true, start: 75, end: 80, mode: 'Custom', pending: false}, 'limit after on');
    eq(await info.setLimit(false), {ok: true}, 'off with charge_types');
    eq(writesLog(fb.dir).slice(3), ['charge_types=Standard'], 'off only switches to Standard');
    eq([info.read().limit.enabled, info.read().limit.mode], [false, 'Standard'], 'limit after off');
    info.destroy();

    // Lowering the end below the current start: start goes first.
    fb = fakeBattery({charge_control_end_threshold: '90', charge_control_start_threshold: '85'});
    info = new BatteryInfo({...fb, writeArgv: driverArgv});
    await settled(info);
    eq(await info.setLimit(true), {ok: true}, 'on from 85-90');
    eq(writesLog(fb.dir), ['charge_control_start_threshold=75', 'charge_control_end_threshold=80'], 'start lowered first');
    info.destroy();

    // Raising the end above the target start: end goes first.
    fb = fakeBattery({charge_control_end_threshold: '60', charge_control_start_threshold: '55'});
    info = new BatteryInfo({...fb, writeArgv: driverArgv});
    await settled(info);
    eq(await info.setLimit(true), {ok: true}, 'on from 55-60');
    eq(writesLog(fb.dir), ['charge_control_end_threshold=80', 'charge_control_start_threshold=75'], 'end raised first');
    info.destroy();

    // A driver with a minimum start (like Dell's 50): turning off still works, start stays.
    fb = fakeBattery({charge_control_end_threshold: '80', charge_control_start_threshold: '75', min_start: '50'});
    info = new BatteryInfo({...fb, writeArgv: driverArgv});
    await settled(info);
    eq(await info.setLimit(false), {ok: true}, 'off when start=0 is rejected');
    eq([info.read().limit.end, info.read().limit.start, info.read().limit.enabled], [100, 75, false], 'start left alone');
    info.destroy();

    // A rejected write is reported, and the read-back reflects what stuck.
    fb = fakeBattery({charge_control_end_threshold: '100', charge_control_start_threshold: '0', min_start: '78'});
    info = new BatteryInfo({...fb, writeArgv: driverArgv});
    await settled(info);
    const bad = await info.setLimit(true);
    check(!bad.ok && /didn't accept/.test(bad.error), `rejected write reported: ${JSON.stringify(bad)}`);
    eq([info.read().limit.end, info.read().limit.start], [80, 0], 'state after a rejected write');

    // One change at a time.
    const [a, b] = await Promise.all([info.setLimit(false), info.setLimit(false)]);
    eq([a.ok, b.ok, /Already/.test(b.error)], [true, false, true], 'second concurrent call refused');
    info.destroy();

    // Disabled (screen lock) in the middle of a change: the next BatteryInfo reads the limit again
    // instead of trusting values from before the change.
    fb = fakeBattery({charge_control_end_threshold: '90', charge_control_start_threshold: '50', charge_types: '[Standard] Adaptive Custom'});
    const slowArgv = (value, path) => ['/bin/sh', '-c', `sleep 0.2; ${DRIVER}`, 'sh', value, path];
    info = new BatteryInfo({...fb, writeArgv: slowArgv});
    await settled(info);
    const pending = info.setLimit(true);
    await sleep(100);
    info.destroy();
    eq(await pending, {ok: false, error: 'Cancelled.'}, 'setLimit cancelled by destroy()');
    eq(writesLog(fb.dir), ['charge_types=Custom'], 'the running write finished, the rest were skipped');
    info = new BatteryInfo(fb);
    eq(info.read().limit.pending, true, 'stale values dropped after a cancelled change');
    eq((await settled(info)).limit.mode, 'Custom', 'new state read back');
    info.destroy();
}

async function testThisLaptop() {
    const bat = '/sys/class/power_supply/BAT0';
    if (cat(`${bat}/model_name`) !== 'DELL WV3K854') {
        print('skip: not the Dell Inspiron 14 5445 this was written on');
        return;
    }
    const info = new BatteryInfo();
    const r = await settled(info);
    eq([r.present, r.manufacturer, r.model, r.vendor], [true, 'BYD', 'DELL WV3K854', 'Dell Inc.'], 'this laptop: identity');
    eq(r.limit.state, 'unreadable', 'this laptop: firmware hides the limit');
    near(r.healthPct, 72, 3, 'this laptop: health');
    near(r.healthPct, Number(cat(`${bat}/charge_full`)) / Number(cat(`${bat}/charge_full_design`)) * 100, 1e-9, 'this laptop: health formula');
    check(r.cycles >= 411, `this laptop: cycles ${r.cycles} >= 411`);
    eq(r.whApprox, true, 'this laptop: Wh from charge');
    near(r.designWh, 52.92, 0.01, 'this laptop: design Wh');
    print(`this laptop: health ${r.healthPct.toFixed(1)}%, ${r.fullWh.toFixed(1)} of ${r.designWh.toFixed(1)} Wh, ${r.cycles} cycles, limit ${r.limit.state}`);
    info.destroy();
}

try {
    testParsing();
    testOrdering();
    await testStates();
    await testSetLimit();
    await testThisLaptop();
} catch (e) {
    failed++;
    printerr(`FAIL: ${e}\n${e.stack}`);
} finally {
    Gio.Subprocess.new(['rm', '-rf', BASE], Gio.SubprocessFlags.NONE).wait(null);
}

print(`${passed} passed, ${failed} failed`);
if (failed) System.exit(1);
