import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Sensors} from './sensors.js';

const REFRESH_SECONDS = 2;
const SMOOTHING = 0.35;      // battery readings jump around; ease them a little
const TRACK_W = 248;         // matches .pg-box width in stylesheet.css
const CHILD_INDENT = 14;     // matches .pg-row-child padding-left
const DIM = 150;             // opacity for secondary text, works on light and dark shell themes

const fmtW = w => (w === null || w === undefined) ? '–' : `${w.toFixed(1)} W`;

function fmtHours(h) {
    if (!h || !Number.isFinite(h) || h > 48) return null;
    const total = Math.round(h * 60);
    const hh = Math.floor(total / 60), mm = total % 60;
    return hh > 0 ? `${hh} h ${mm} min left` : `${mm} min left`;
}

const PowerIndicator = GObject.registerClass(
class PowerIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Power Glance');

        this._sensors = new Sensors();
        this._ema = {};

        this._panelLabel = new St.Label({
            text: '– W',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pg-panel-label',
        });
        this.add_child(this._panelLabel);

        this._buildMenu();
        this.menu.connect('open-state-changed', (_m, open) => { if (open) this._refresh(); });

        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'pg-box'});
        item.add_child(box);
        this.menu.addMenuItem(item);

        this._eyebrow = new St.Label({text: 'WHOLE LAPTOP', style_class: 'pg-eyebrow'});
        this._eyebrow.opacity = DIM;
        this._total = new St.Label({text: '–', style_class: 'pg-total'});
        this._sub = new St.Label({text: '', style_class: 'pg-sub'});
        this._sub.opacity = DIM;
        this._sub.clutter_text.line_wrap = true;

        const head = new St.BoxLayout({vertical: true, style_class: 'pg-head'});
        head.add_child(this._eyebrow);
        head.add_child(this._total);
        head.add_child(this._sub);
        box.add_child(head);

        const rows = new St.BoxLayout({vertical: true, style_class: 'pg-rows'});
        box.add_child(rows);

        this._rows = {
            socket: this._makeRow(rows, 'Processor package', false),
            cpu: this._makeRow(rows, 'CPU cores', true),
            gfx: this._makeRow(rows, 'Graphics', true),
            soc: this._makeRow(rows, 'Memory & I/O', true),
            rest: this._makeRow(rows, 'Rest of laptop', false),
            screen: this._makeRow(rows, 'Screen', true),
            wifi: this._makeRow(rows, 'Wi-Fi', true),
            storage: this._makeRow(rows, 'Storage', true),
            ram: this._makeRow(rows, 'RAM', true),
            other: this._makeRow(rows, 'Other', true, 'fan, motherboard, USB, power losses'),
        };

        this._note = new St.Label({
            text: '≈ estimated from brightness, network traffic, disk activity and CPU load. These parts have no power sensor.',
            style_class: 'pg-hint',
        });
        this._note.opacity = DIM;
        this._note.clutter_text.line_wrap = true;
        box.add_child(this._note);
    }

    _makeRow(parent, name, child, hint) {
        const wrap = new St.BoxLayout({vertical: true, style_class: child ? 'pg-row pg-row-child' : 'pg-row'});
        const line = new St.BoxLayout({x_expand: true});
        const nameLabel = new St.Label({text: name, x_expand: true, style_class: 'pg-row-name'});
        const value = new St.Label({text: '–', style_class: 'pg-row-value'});
        if (child) nameLabel.opacity = 210;
        line.add_child(nameLabel);
        line.add_child(value);
        wrap.add_child(line);
        if (hint) {
            const h = new St.Label({text: hint, style_class: 'pg-hint'});
            h.opacity = DIM;
            wrap.add_child(h);
        }
        const trackW = child ? TRACK_W - CHILD_INDENT : TRACK_W;
        const track = new St.Widget({style_class: 'pg-track', width: trackW, x_expand: false});
        const fill = new St.Widget({style_class: child ? 'pg-fill pg-fill-child' : 'pg-fill'});
        track.add_child(fill);
        wrap.add_child(track);
        parent.add_child(wrap);
        return {wrap, value, fill, trackW};
    }

    _smooth(key, v) {
        if (v === null) { delete this._ema[key]; return null; }
        const prev = this._ema[key];
        this._ema[key] = prev === undefined ? v : prev + SMOOTHING * (v - prev);
        return this._ema[key];
    }

    _refresh() {
        const r = this._sensors.read();
        const total = this._smooth('total', r.total);
        const socket = r.socket;
        let rest = total !== null && socket !== null ? Math.max(0, total - socket) : null;

        // Estimated devices. On battery, fit them inside the measured remainder; the gap is "Other".
        const est = {};
        let estSum = 0;
        for (const k of ['screen', 'wifi', 'storage', 'ram']) {
            est[k] = this._smooth(k, r.devices?.[k] ?? null);
            if (est[k] !== null) estSum += est[k];
        }
        let other = null, restApprox = false;
        if (rest !== null) {
            if (estSum > rest && estSum > 0) {
                const f = rest / estSum;
                for (const k in est) if (est[k] !== null) est[k] *= f;
                other = 0;
            } else {
                other = rest - estSum;
            }
        } else if (estSum > 0) {
            rest = estSum;
            restApprox = true;
        }

        const headline = total ?? socket;
        this._panelLabel.text = fmtW(headline);
        if (total === null) this._panelLabel.add_style_class_name('pg-on-ac');
        else this._panelLabel.remove_style_class_name('pg-on-ac');

        if (!this.menu.isOpen) return;

        this._total.text = fmtW(headline);
        this._eyebrow.text = total !== null ? 'WHOLE LAPTOP' : 'PROCESSOR PACKAGE';

        const parts = [];
        if (r.status === 'Discharging') parts.push('On battery');
        else if (r.status) parts.push('On charger');
        if (r.percent !== null) parts.push(`${r.percent}%`);
        const left = fmtHours(r.hoursLeft);
        if (left) parts.push(left);
        let sub = parts.join('  ·  ');
        if (total === null && r.status) sub += '\nUnplug to measure the whole laptop.';
        this._sub.text = sub;

        const base = Math.max(total ?? ((socket ?? 0) + (rest ?? 0)), 0.001);
        this._setRow(this._rows.socket, socket, base);
        this._setRow(this._rows.cpu, r.cpu, base);
        this._setRow(this._rows.gfx, r.gfx, base);
        this._setRow(this._rows.soc, r.soc, base);
        this._setRow(this._rows.rest, rest, base, restApprox);
        this._setRow(this._rows.screen, est.screen, base, true);
        this._setRow(this._rows.wifi, est.wifi, base, true);
        this._setRow(this._rows.storage, est.storage, base, true);
        this._setRow(this._rows.ram, est.ram, base, true);
        this._setRow(this._rows.other, other, base, true);
    }

    _setRow(row, watts, base, approx = false) {
        row.wrap.visible = watts !== null;
        if (watts === null) return;
        row.value.text = (approx ? '≈ ' : '') + fmtW(watts);
        row.fill.width = Math.max(2, Math.round(Math.min(1, watts / base) * row.trackW));
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        super.destroy();
    }
});

export default class PowerGlanceExtension extends Extension {
    enable() {
        this._indicator = new PowerIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
