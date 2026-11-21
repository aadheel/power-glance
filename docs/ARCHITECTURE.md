# Power Glance architecture

GNOME Shell 46+ extension (ES modules, `gi://` imports). Everything runs inside the `gnome-shell`
process, on its main thread. A stall here freezes the whole desktop, so:

- **Never block for more than ~2 ms at a time.** Split bigger jobs into chunks with
  `GLib.idle_add(GLib.PRIORITY_LOW, ...)` or short timeouts. Small sysfs/procfs reads with
  `GLib.file_get_contents` are fine (~10–20 µs each); hundreds of them in one go are not.
- **File I/O on real disks is async** (`Gio.File.*_async` + a `Gio.Cancellable` cancelled in `destroy()`).
  Exception: a tiny final flush in `destroy()` may be synchronous.
- **No subprocesses on the hot path.** One-off user actions (e.g. writing a charge limit) may use
  `Gio.Subprocess` asynchronously.
- **`destroy()` must remove every GLib source, signal handler and cancellable it created.**
  GNOME disables extensions on every screen lock and re-enables them on unlock, so `destroy()` and
  construction happen often. Plain data (numbers, maps) may be kept in **module scope** so it survives a
  lock/unlock cycle; never keep actors, sources or signals there.
- After a lock/unlock or suspend, time jumps. Treat any gap between ticks longer than ~3× the expected
  interval as a break: re-baseline counters, don't integrate energy across it.

## Files

```
extension.js        panel button, tab bar, 2-second tick loop (owned by the integrator)
model.js            PowerModel: sensors -> Snapshot (done)
sensors.js          raw sysfs reads (done)
ui/common.js        shared widgets + formatters: BarRow, StatRow, dimLabel, sectionLabel, wrapLabel,
                    fmtW, fmtWh, fmtDuration, fmtHoursLeft, DIM, CONTENT_W, CHILD_INDENT, ACCENT, NEUTRAL (done)
ui/nowTab.js        "Now" tab (done) - read this as the reference for how a tab looks and is built
battery.js          BatteryInfo                  -> feature: battery
ui/batteryTab.js    BatteryTab                   -> feature: battery
setup-charge-limit.sh  one-time root helper      -> feature: battery
history.js          HistoryStore                 -> feature: history
ui/historyTab.js    HistoryTab                   -> feature: history
apps.js             AppTracker                   -> feature: apps
ui/appsTab.js       AppsTab                      -> feature: apps
thermal.js          ThermalInfo                  -> feature: temps
ui/tempsTab.js      TempsTab                     -> feature: temps
styles/base.css     shared CSS (done)
styles/<feature>.css  each feature's extra CSS; concatenated into stylesheet.css by the integrator
tests/test_<feature>.js  gjs -m tests runnable outside the shell
```

## Reading the hardware (sensors.js)

Reading the battery makes the ACPI firmware refresh (2–3 ms on the test Dell, at most once per second),
and `gpu_metrics` occasionally takes a few ms. Both are read with `load_contents_async` in a GIO worker
thread; each tick uses the values that arrived since the previous one. The sysfs paths found on the first
run are cached in module scope so re-enabling after a screen unlock doesn't enumerate sysfs again.

## The tick loop (extension.js)

Every 2 seconds:

```js
const s = model.read();      // Snapshot
history.record(s);
apps.feed(s);
panelLabel.text = ...;
if (menu.isOpen) pages[activeTab].update(s);
```

Each step runs inside `guard()`, which logs and swallows an error so one failing module can't stop the
timer or the others. The first tick runs from an idle callback so `enable()` stays quick.

When the menu opens or the user switches tab, the newly visible tab gets `update(lastSnapshot)` at once.
`apps.setViewActive(bool)` is called with `true` while the menu is open **and** the Apps tab is showing.

## Snapshot (from `PowerModel.read()`)

All power values are watts (`number`) or `null` when unknown.

| field | meaning |
|---|---|
| `monotonic` | seconds, `GLib.get_monotonic_time()/1e6`; use for intervals (does not advance during suspend) |
| `wall` | seconds since the Unix epoch, `GLib.get_real_time()/1e6`; use for timestamps you store |
| `status` | battery status string: `'Discharging'`, `'Charging'`, `'Full'`, `'Not charging'`, or `null` |
| `percent` | battery % or `null` |
| `hoursLeft` | estimated hours left on battery or `null` |
| `total` | measured whole-laptop draw; only non-null while discharging |
| `socket` | processor package (APU) power, measured; smoothed like `total` and never above it |
| `cpu`, `gfx`, `soc` | CPU cores / graphics / memory & I/O, measured parts of the package (AMD only); smoothed and scaled to fit inside `socket` |
| `rest` | laptop minus package; measured on battery, sum of estimates on AC (`restApprox: true`) |
| `screen`, `wifi`, `storage`, `ram`, `other` | estimates |
| `system` | best whole-laptop figure: `total` when measured, else `socket + rest` (estimated); `null` when neither is known or there is no package sensor |
| `systemMeasured` | `true` when `system` is the measured `total` |
| `cpuLoad` | CPU load in percent over the last tick, or `null` |

## Feature interfaces

Constructors take no required arguments (optional options objects for tests are fine).

### battery.js

```js
export class BatteryInfo {
  constructor()
  read() -> {
    present: bool, status: string|null, percent: number|null,
    healthPct: number|null,          // full / design * 100
    fullWh: number|null, designWh: number|null, nowWh: number|null,
    cycles: number|null, manufacturer: string|null, model: string|null,
    limit: {
      state: 'none' | 'unreadable' | 'readonly' | 'ready',
      enabled: bool|null,            // true when a cap below 100% is active
      start: number|null, end: number|null, mode: string|null,   // raw values when readable
      pending: bool,                 // true until the first background read of the limit files finishes
    },
    whApprox: bool,                  // Wh worked out from charge x design voltage (shown with ≈)
    vendor: string|null,             // system maker from DMI, for the BIOS hint
  }
  setLimit(enabled: bool) -> Promise<{ok: bool, error?: string}>
  destroy()
}
```

### history.js

```js
export class HistoryStore {
  constructor({dataDir} = {})        // default: GLib.get_user_data_dir() + '/power-glance'
  record(snapshot)                   // every ~2 s
  ready -> bool                      // true once the on-disk history has loaded
  buckets(hours = 24, bucketMinutes = 15) -> [{start: unixSeconds, watts: number|null, measured: bool}]
  stats() -> {
    todayWh: number|null, todayApprox: bool,            // since local midnight
    avgOnBattery: number|null,                           // mean measured W while discharging, last 24 h
    sinceUnplug: null | {since: unixSeconds, wh: number, seconds: number, covered: number, avgW: number},
                                     // covered: seconds actually recorded (locked/asleep time is not)
  }
  destroy()                          // flush, cancel I/O
}
```

### apps.js

```js
export class AppTracker {
  constructor()
  feed(snapshot)                     // every ~2 s; accumulates CPU/GPU energy between scans
  setViewActive(active: bool)        // Apps tab visible: scan more often
  now(limit = 5) -> {ready: bool, basis: 'watts' | 'cpu', apps: [{key, name, gicon, watts, cpuW, gpuW, cpuPct}]}
  sinceUnplug(limit = 5) -> {since: unixSeconds|null, onBattery: bool, fromLogin: bool, seconds: number|null,
                             apps: [{key, name, gicon, wh}]}   // fromLogin: shell started already on battery
  destroy()
}
```

### thermal.js

```js
export class ThermalInfo {
  constructor()                      // cheap; sensors are discovered on the first read(), in idle steps
  onChange                           // optional callback, called when a batch of readings arrives
  read() -> {
    ready: bool,                     // false until discovery has finished
    temps: [{key, name, c: number|null, limit: number, warn: number}],   // °C; warn < limit
    fans:  [{key, name, rpm: number|null, max: number|null}],
    cpu:   {mhz: number|null, maxMHz: number|null},
    gpu:   {load: number|null, mhz: number|null},
  }
  destroy()
}
```

Every sensor read is a `load_contents_async` (SSD temperature: 4-21 ms, RAM over I2C ~2 ms, Dell EC
~3 ms via a BIOS call). Fast sensors are read at most every 1.5 s, slow ones every 6 s, and only when
`read()` is called, i.e. while the Temps tab is open. CPU load comes from the Snapshot (`cpuLoad`).

### Tabs (`ui/*Tab.js`)

```js
export class XTab {
  constructor(dataSource)    // BatteryInfo / HistoryStore / AppTracker
  actor                      // St.BoxLayout({vertical: true, style_class: 'pg-page'})
  update(snapshot)           // only called while the tab is visible in an open menu
  destroy()                  // destroy actor and anything the tab created
}
```

## Look

- Content is exactly 248 px wide (`CONTENT_W`). Child rows are indented 14 px.
- Use `BarRow`, `StatRow`, `sectionLabel`, `dimLabel` from `ui/common.js`; don't restyle them.
- Secondary text: `opacity = DIM`, never a hard-coded grey. The shell theme may be light or dark.
- One accent colour, `#62a0ea` (`ACCENT` for cairo). Neutral grey for anything else (`NEUTRAL`, or
  `rgba(128,128,128,a)` in CSS).
- Mark estimated values with a leading `≈ `.
- Keep it quiet: no emoji, no extra borders or cards, sentence-case labels, small uppercase section headings.
- New CSS classes are prefixed `pg-bat-`, `pg-hist-`, `pg-app-` and live in `styles/<feature>.css`.
