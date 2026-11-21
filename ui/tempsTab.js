// "Temps" tab: temperatures, fan speeds, and how busy and fast the CPU and graphics are.
import St from 'gi://St';
import {BarRow, dimLabel, sectionLabel} from './common.js';

const MAX_TEMPS = 8;
const MAX_FANS = 3;
const FAN_SCALE = 6000;   // rpm, for fans that don't report a maximum

const fmtC = c => (c === null || c === undefined ? '–' : `${Math.round(c)} °C`);
const fmtRpm = r => (r === null || r === undefined ? '–' : r === 0 ? 'Off' : `${r.toLocaleString()} rpm`);
const fmtClock = mhz => (mhz === null || mhz === undefined ? null : mhz >= 1000 ? `${(mhz / 1000).toFixed(1)} GHz` : `${Math.round(mhz)} MHz`);

function activity(load, mhz) {
    const parts = [];
    if (Number.isFinite(load)) parts.push(`${Math.round(load)}%`);
    const clock = fmtClock(mhz);
    if (clock) parts.push(clock);
    return parts.length ? parts.join(' · ') : '–';
}

export class TempsTab {
    constructor(thermal) {
        this._thermal = thermal;
        this._last = null;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'pg-page'});

        const temps = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        temps.add_child(sectionLabel('TEMPERATURES'));
        this._finding = dimLabel('Finding sensors…');
        temps.add_child(this._finding);
        const tempRows = new St.BoxLayout({vertical: true, style_class: 'pg-rows'});
        this._temps = [];
        for (let i = 0; i < MAX_TEMPS; i++) {
            const r = new BarRow({name: ''});
            r.hide();
            tempRows.add_child(r.actor);
            this._temps.push(r);
        }
        temps.add_child(tempRows);
        temps.add_child(dimLabel('Bars show how close each part is to its safe limit. Orange means it is running hot.'));
        this.actor.add_child(temps);

        this._fanBox = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        this._fanBox.add_child(sectionLabel('FANS'));
        const fanRows = new St.BoxLayout({vertical: true, style_class: 'pg-rows'});
        this._fans = [];
        for (let i = 0; i < MAX_FANS; i++) {
            const r = new BarRow({name: ''});
            r.hide();
            fanRows.add_child(r.actor);
            this._fans.push(r);
        }
        this._fanBox.add_child(fanRows);
        this._fanBox.visible = false;
        this.actor.add_child(this._fanBox);

        const act = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        act.add_child(sectionLabel('ACTIVITY'));
        const actRows = new St.BoxLayout({vertical: true, style_class: 'pg-rows'});
        this._cpu = new BarRow({name: 'CPU'});
        this._gpu = new BarRow({name: 'Graphics'});
        actRows.add_child(this._cpu.actor);
        actRows.add_child(this._gpu.actor);
        act.add_child(actRows);
        act.add_child(dimLabel('Load and current clock speed.'));
        this.actor.add_child(act);

        // Readings arrive from background threads; show them as soon as they land.
        this._thermal.onChange = () => {
            if (this._last && this.actor.mapped) this._render(this._thermal.read(), this._last);
        };
    }

    update(snapshot) {
        this._last = snapshot;
        this._render(this._thermal.read(), snapshot);
    }

    _render(t, s) {
        this._finding.visible = !t.ready;

        t.temps.slice(0, MAX_TEMPS).forEach((x, i) => {
            const r = this._temps[i];
            r.setName(x.name);
            r.set(fmtC(x.c), x.c === null ? 0 : x.c / x.limit);
            r.setHot(x.c !== null && x.c >= x.warn);
        });
        for (let i = t.temps.length; i < MAX_TEMPS; i++) this._temps[i].hide();

        this._fanBox.visible = t.fans.length > 0;
        t.fans.slice(0, MAX_FANS).forEach((f, i) => {
            const r = this._fans[i];
            r.setName(f.name);
            r.set(fmtRpm(f.rpm), f.rpm === null ? 0 : f.rpm / (f.max ?? FAN_SCALE));
        });
        for (let i = t.fans.length; i < MAX_FANS; i++) this._fans[i].hide();

        const cpuLoad = s?.cpuLoad ?? null;
        this._cpu.set(activity(cpuLoad, t.cpu.mhz), (cpuLoad ?? 0) / 100);
        this._gpu.set(activity(t.gpu.load, t.gpu.mhz), (t.gpu.load ?? 0) / 100);
        if (t.ready && t.gpu.load === null && t.gpu.mhz === null) this._gpu.hide();
    }

    destroy() {
        this._thermal.onChange = null;
        this.actor.destroy();
    }
}
