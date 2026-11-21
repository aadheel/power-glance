// Live test of ThermalInfo on this machine: run with  gjs -m tests/test_thermal.js
// Checks that sensors are found, values are plausible, and that read() never blocks the caller.
import GLib from 'gi://GLib';
import {ThermalInfo} from '../thermal.js';

let failures = 0;
const check = (ok, what) => {
    print(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures++;
};

const t0 = GLib.get_monotonic_time();
const th = new ThermalInfo();
const ctorMs = (GLib.get_monotonic_time() - t0) / 1000;
let changes = 0;
th.onChange = () => changes++;

const loop = new GLib.MainLoop(null, false);
let n = 0, maxReadMs = 0, last = null;
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
    const a = GLib.get_monotonic_time();
    last = th.read();
    maxReadMs = Math.max(maxReadMs, (GLib.get_monotonic_time() - a) / 1000);
    if (++n < 5) return GLib.SOURCE_CONTINUE;
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();

for (const t of last.temps) print(`  temp  ${t.name.padEnd(16)} ${t.c?.toFixed(1) ?? '–'} °C  (warn ${t.warn}, limit ${t.limit})`);
for (const f of last.fans) print(`  fan   ${f.name.padEnd(16)} ${f.rpm ?? '–'} rpm of ${f.max ?? '?'}`);
print(`  cpu   clock ${last.cpu.mhz?.toFixed(0)} MHz of ${last.cpu.maxMHz}`);
print(`  gpu   load ${last.gpu.load}%  clock ${last.gpu.mhz} MHz`);
print(`  constructor ${ctorMs.toFixed(2)} ms, slowest read() ${maxReadMs.toFixed(2)} ms, ${changes} change callbacks`);

check(last.ready === true, 'sensors discovered in the background');
check(last.temps.length > 0, 'found temperature sensors');
check(last.temps.every(t => t.c === null || (t.c > 0 && t.c < 150)), 'temperatures are plausible');
check(last.temps.some(t => t.name === 'CPU' && t.c !== null), 'CPU temperature read');
check(last.temps.every(t => t.warn < t.limit), 'warning level is below the limit for every sensor');
check(maxReadMs < 2, 'read() returns quickly (slow sensor reads happen off the main thread)');
check(ctorMs < 2, 'constructor is quick (discovery runs later, in small steps)');
check(changes > 0, 'onChange fires when readings arrive');

th.destroy();
th.read();   // after destroy: must not throw or schedule work that touches the object
check(true, 'read() after destroy() is harmless');

print(failures ? `${failures} failure(s)` : 'ok   0 failures');
if (failures) imports.system.exit(1);
