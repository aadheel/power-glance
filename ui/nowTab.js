// "Now" tab: the live breakdown (what the menu showed before tabs existed).
import St from 'gi://St';
import {BarRow, dimLabel, fmtW, fmtHoursLeft, sectionLabel, DIM, wrapLabel} from './common.js';

export class NowTab {
    constructor() {
        this.actor = new St.BoxLayout({vertical: true, style_class: 'pg-page'});

        const head = new St.BoxLayout({vertical: true, style_class: 'pg-head'});
        this._eyebrow = sectionLabel('WHOLE LAPTOP');
        this._total = new St.Label({text: '–', style_class: 'pg-total'});
        this._sub = new St.Label({text: '', style_class: 'pg-sub'});
        this._sub.opacity = DIM;
        wrapLabel(this._sub);
        head.add_child(this._eyebrow);
        head.add_child(this._total);
        head.add_child(this._sub);
        this.actor.add_child(head);

        const rows = new St.BoxLayout({vertical: true, style_class: 'pg-rows'});
        this.actor.add_child(rows);
        const add = (name, child, hint) => {
            const r = new BarRow({name, child, hint});
            rows.add_child(r.actor);
            return r;
        };
        this._rows = {
            socket: add('Processor package', false),
            cpu: add('CPU cores', true),
            gfx: add('Graphics', true),
            soc: add('Memory & I/O', true),
            rest: add('Rest of laptop', false),
            screen: add('Screen', true),
            wifi: add('Wi-Fi', true),
            storage: add('Storage', true),
            ram: add('RAM', true),
            other: add('Other', true, 'fan, motherboard, USB, power losses'),
        };

        this.actor.add_child(dimLabel('≈ estimated from brightness, network traffic, disk activity and CPU load. These parts have no power sensor.'));
    }

    update(s) {
        const headline = s.system;
        this._total.text = (s.systemMeasured || headline === null ? '' : '≈ ') + fmtW(headline);
        this._eyebrow.text = s.systemMeasured ? 'WHOLE LAPTOP' : 'ESTIMATED TOTAL';

        const parts = [];
        if (s.status === 'Discharging') parts.push('On battery');
        else if (s.status) parts.push('On charger');
        if (s.percent !== null) parts.push(`${s.percent}%`);
        const left = fmtHoursLeft(s.hoursLeft);
        if (left) parts.push(left);
        let sub = parts.join('  ·  ');
        if (!s.systemMeasured && s.status) sub += '\nUnplug to measure the whole laptop.';
        this._sub.text = sub;

        const base = Math.max(headline ?? 0, 0.001);
        const r = this._rows;
        r.socket.setWatts(s.socket, base);
        r.cpu.setWatts(s.cpu, base);
        r.gfx.setWatts(s.gfx, base);
        r.soc.setWatts(s.soc, base);
        r.rest.setWatts(s.rest, base, s.restApprox);
        r.screen.setWatts(s.screen, base, true);
        r.wifi.setWatts(s.wifi, base, true);
        r.storage.setWatts(s.storage, base, true);
        r.ram.setWatts(s.ram, base, true);
        r.other.setWatts(s.other, base, true);
    }

    destroy() {
        this.actor.destroy();
    }
}
