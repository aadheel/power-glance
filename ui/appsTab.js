// "Apps" tab: where the processor and graphics power went, right now and since the charger came out.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import {BarRow, dimLabel, fmtDuration, fmtW, fmtWh, sectionLabel} from './common.js';

const ROWS = 5;
const MEASURING = 'Measuring… this takes a few seconds.';
const NOTE_WATTS = 'CPU and graphics only. The screen, Wi-Fi and the rest aren’t split by app.';
const NOTE_CPU = 'Share of processor time. This laptop doesn’t report processor power.';
const NO_SENSOR = 'Can’t count energy per app: this laptop doesn’t report processor power.';

const approxW = w => w < 0.05 ? '< 0.1 W' : `≈ ${fmtW(w)}`;
const approxWh = wh => wh < 0.05 ? '< 0.1 Wh' : `≈ ${fmtWh(wh)}`;
const fmtPct = p => `${p < 1 ? p.toFixed(1) : Math.round(p)}% CPU`;

export class AppsTab {
    constructor(tracker) {
        this._tracker = tracker;
        this._fallbackIcon = Gio.ThemedIcon.new('application-x-executable-symbolic');
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this.actor = new St.BoxLayout({vertical: true, style_class: 'pg-page'});

        const nowBox = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        nowBox.add_child(sectionLabel('RIGHT NOW'));
        this._nowStatus = dimLabel(MEASURING, 'pg-app-status');
        nowBox.add_child(this._nowStatus);
        this._nowRows = this._rowPool(nowBox);
        this._nowNote = dimLabel(NOTE_WATTS);
        nowBox.add_child(this._nowNote);
        this.actor.add_child(nowBox);

        const sinceBox = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        this._sinceHead = sectionLabel('SINCE UNPLUGGED');
        sinceBox.add_child(this._sinceHead);
        this._sinceWhen = dimLabel('', 'pg-app-status');
        sinceBox.add_child(this._sinceWhen);
        this._sinceRows = this._rowPool(sinceBox);
        this._sinceStatus = dimLabel('Unplug the charger to start tracking.', 'pg-app-status');
        sinceBox.add_child(this._sinceStatus);
        this.actor.add_child(sinceBox);
    }

    // Rows are made once and reused; update() only changes their text, icon and visibility.
    _rowPool(parent) {
        const box = new St.BoxLayout({vertical: true, style_class: 'pg-rows'});
        parent.add_child(box);
        const rows = [];
        for (let i = 0; i < ROWS; i++) {
            const row = new BarRow({name: ''});
            row.hide();
            box.add_child(row.actor);
            rows.push({row, gicon: null});
        }
        return {box, rows};
    }

    /** items come sorted, biggest first; bars are relative to the first. */
    _fill(pool, items, valueOf, textOf) {
        pool.box.visible = items.length > 0;   // an empty box would still add section spacing
        const top = items.length ? valueOf(items[0]) : 0;
        pool.rows.forEach((r, i) => {
            const a = items[i];
            if (!a) {
                r.row.hide();
                return;
            }
            r.row.setName(a.name);
            const gicon = a.gicon ?? this._fallbackIcon;
            if (r.gicon !== gicon) {
                r.row.setIcon(gicon);
                r.gicon = gicon;
            }
            r.row.set(textOf(a), top > 0 ? valueOf(a) / top : 0);
        });
    }

    _clock(dt) {
        const time = this._interface.get_string('clock-format') === '12h' ? '%-l:%M %p' : '%H:%M';
        const today = GLib.DateTime.new_now_local().format('%F');
        return dt.format(dt.format('%F') === today ? time : `%a ${time}`);
    }

    _when(since) {
        const start = GLib.DateTime.new_from_unix_local(Math.floor(since.since));
        const length = fmtDuration(since.seconds);
        if (since.onBattery) return `Since ${this._clock(start)} · ${length}`;
        const end = GLib.DateTime.new_from_unix_local(Math.floor(since.since + since.seconds));
        return `${this._clock(start)} to ${this._clock(end)} · ${length}`;
    }

    update(_snapshot) {
        const now = this._tracker.now(ROWS);
        const byCpu = now.basis === 'cpu';
        const apps = now.ready ? now.apps : [];
        this._nowStatus.text = now.ready ? 'Nothing is busy right now.' : MEASURING;
        this._nowStatus.visible = apps.length === 0;
        if (byCpu) this._fill(this._nowRows, apps, a => a.cpuPct, a => fmtPct(a.cpuPct));
        else this._fill(this._nowRows, apps, a => a.watts, a => approxW(a.watts));
        this._nowNote.text = byCpu ? NOTE_CPU : NOTE_WATTS;

        const since = this._tracker.sinceUnplug(ROWS);
        const started = since.since !== null;
        // When the shell started already on battery (login, restart) the real unplug time is unknown
        // here, so say what the numbers actually cover.
        if (!since.onBattery && started) this._sinceHead.text = 'LAST TIME ON BATTERY';
        else this._sinceHead.text = since.fromLogin ? 'ON BATTERY SINCE LOGIN' : 'SINCE UNPLUGGED';
        this._sinceWhen.visible = started;
        if (started) this._sinceWhen.text = this._when(since);
        this._fill(this._sinceRows, since.apps, a => a.wh, a => approxWh(a.wh));
        this._sinceStatus.visible = since.apps.length === 0;
        if (!started) this._sinceStatus.text = 'Unplug the charger to start tracking.';
        else this._sinceStatus.text = byCpu && now.ready ? NO_SENSOR : 'Nothing counted yet.';
    }

    destroy() {
        this.actor.destroy();
        this._tracker = null;
        this._interface = null;
    }
}
