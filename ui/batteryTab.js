// "Battery" tab: how worn the battery is, and the optional 80% charge limit.
import St from 'gi://St';
import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {LIMIT_END} from '../battery.js';
import {BarRow, StatRow, dimLabel, sectionLabel, fmtWh, DIM, wrapLabel} from './common.js';

const ABOUT_HEALTH = 'Health is how much charge the battery holds now compared with when it was new. ' +
    'All batteries slowly lose capacity with charge cycles and age.';
const ABOUT_LIMIT = 'Keeping the battery below 100% when the laptop is mostly plugged in slows its wear.';
const NEEDS_SETUP = 'To switch it on or off here, run this once in a terminal:';
// install.sh copies the helper next to the extension, so this path always exists after installing.
const SETUP_CMD = 'sudo ~/.local/share/gnome-shell/extensions/power-glance@local/setup-charge-limit.sh';
const FIRMWARE = "This laptop's firmware doesn't share its charge limit with Linux.";
const DELL_BIOS = 'You can set one in the BIOS setup: press F2 at power-on, open Battery Charge Configuration ' +
    'and choose Custom (for example 50–80%) or “Primarily AC use”.';
const OTHER_BIOS = "If your BIOS/UEFI setup has one, it's usually in a battery or power section.";
const NONE = "This laptop doesn't offer a charge limit to Linux.";

// charge_types modes other than Standard/Custom, in plain words.
const MODE_NAMES = {Adaptive: 'Adaptive', Long_Life: 'Long life', Fast: 'Fast', Trickle: 'Trickle'};

const showStat = (row, text) => (text === null ? row.hide() : row.set(text));

export class BatteryTab {
    constructor(battery) {
        this._battery = battery;
        this._busy = false;
        this._error = null;
        this._destroyed = false;

        this.actor = new St.BoxLayout({vertical: true, style_class: 'pg-page'});

        // Health
        const health = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        const head = new St.BoxLayout({vertical: true, style_class: 'pg-head'});
        head.add_child(sectionLabel('HEALTH'));
        this._figure = new St.Label({text: '–', style_class: 'pg-total'});
        head.add_child(this._figure);
        health.add_child(head);

        this._noBattery = dimLabel('No battery found.');
        health.add_child(this._noBattery);
        this._capacity = new BarRow({name: 'Compared with new'});
        health.add_child(this._capacity.actor);
        this._stats = {
            full: new StatRow('Holds now'),
            design: new StatRow('When new'),
            cycles: new StatRow('Charge cycles'),
            model: new StatRow('Battery'),
        };
        for (const row of Object.values(this._stats)) health.add_child(row.actor);
        this._about = dimLabel(ABOUT_HEALTH);
        health.add_child(this._about);
        this.actor.add_child(health);

        // Charge limit: one fixed set of widgets; update() shows the ones that fit the state.
        this._limitBox = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        this._limitBox.add_child(sectionLabel('CHARGE LIMIT'));

        // A focusable button around label and switch, so mouse, Space and Enter all toggle it.
        this._toggleLabel = new St.Label({text: '', x_expand: true, style_class: 'pg-row-name', y_align: Clutter.ActorAlign.CENTER});
        this._switch = new PopupMenu.Switch(false);
        const switchBin = new St.Bin({style_class: 'pg-bat-switch', child: this._switch, y_align: Clutter.ActorAlign.CENTER});
        const line = new St.BoxLayout({x_expand: true, style_class: 'pg-row-line'});
        line.add_child(this._toggleLabel);
        line.add_child(switchBin);
        this._toggle = new St.Button({
            child: line,
            style_class: 'pg-bat-toggle',
            can_focus: true,
            x_expand: true,
            accessible_role: Atk.Role.CHECK_BOX,
        });
        this._toggle.label_actor = this._toggleLabel;
        this._toggle.connect('clicked', () => this._onToggle());
        this._limitBox.add_child(this._toggle);

        this._current = new StatRow('Current limit');
        this._limitBox.add_child(this._current.actor);
        this._limitText = dimLabel('');
        this._limitBox.add_child(this._limitText);
        this._cmd = wrapLabel(new St.Label({text: SETUP_CMD, style_class: 'pg-bat-cmd'}));
        this._limitBox.add_child(this._cmd);
        this._status = dimLabel('');
        this._limitBox.add_child(this._status);
        this.actor.add_child(this._limitBox);
    }

    update(_snapshot) {
        const b = this._battery.read();
        this._showHealth(b);
        this._showLimit(b);
    }

    _showHealth(b) {
        const has = b.present;
        this._figure.visible = has;
        this._about.visible = has;
        this._noBattery.visible = !has;
        if (!has) {
            this._capacity.hide();
            for (const row of Object.values(this._stats)) row.hide();
            return;
        }

        const h = b.healthPct;
        this._figure.text = h === null ? '–' : `${Math.round(h)}%`;
        if (h === null) this._capacity.hide();
        else this._capacity.set(`${Math.round(h)}%`, h / 100);

        // Wh worked out from charge and the design voltage is close, not exact.
        const wh = v => (v === null ? null : (b.whApprox ? '≈ ' : '') + fmtWh(v));
        showStat(this._stats.full, wh(b.fullWh));
        showStat(this._stats.design, wh(b.designWh));
        showStat(this._stats.cycles, b.cycles === null ? null : String(b.cycles));
        showStat(this._stats.model, [b.manufacturer, b.model].filter(Boolean).join(' ') || null);
    }

    _showLimit(b) {
        const lim = b.limit;
        this._limitBox.visible = b.present;
        const state = lim.pending ? 'checking' : lim.state;

        this._toggle.visible = state === 'ready';
        if (state === 'ready' && !this._busy) this._setSwitch(lim.enabled, lim.end);

        this._current.actor.visible = state === 'readonly';
        this._cmd.visible = state === 'readonly';
        if (state === 'readonly') this._current.set(this._describe(lim));

        const dell = (b.vendor ?? '').startsWith('Dell');
        this._limitText.text = {
            checking: 'Checking…',
            ready: ABOUT_LIMIT,
            readonly: NEEDS_SETUP,
            unreadable: `${FIRMWARE} ${dell ? DELL_BIOS : OTHER_BIOS}`,
            none: NONE,
        }[state];

        const status = this._busy ? 'Applying…' : this._error;
        this._status.visible = state === 'ready' && !!status;
        this._status.text = status ?? '';
    }

    _describe(lim) {
        if (lim.enabled) return `Stops at ${lim.end}%`;
        if (MODE_NAMES[lim.mode]) return `${MODE_NAMES[lim.mode]} mode`;
        return 'Off';
    }

    _setSwitch(on, end) {
        this._switch.state = !!on;
        this._toggleLabel.text = `Stop charging at ${on && end !== null ? end : LIMIT_END}%`;
        if (on) this._toggle.add_accessible_state(Atk.StateType.CHECKED);
        else this._toggle.remove_accessible_state(Atk.StateType.CHECKED);
    }

    async _onToggle() {
        if (this._busy) return;
        const want = !this._switch.state;
        this._busy = true;
        this._error = null;
        this._switch.state = want;
        this._toggle.reactive = false;
        this._toggle.opacity = DIM;
        this._status.text = 'Applying…';
        this._status.visible = true;

        let res;
        try {
            res = await this._battery.setLimit(want);
        } catch (e) {
            logError(e, 'Power Glance: changing the charge limit');
            res = {ok: false, error: "Couldn't change the charge limit."};
        }
        if (this._destroyed) return;

        this._busy = false;
        this._toggle.reactive = true;
        this._toggle.opacity = 255;
        this._error = res.ok ? null : res.error;
        this.update(); // the switch now follows what was read back
    }

    destroy() {
        this._destroyed = true;
        this.actor.destroy();
    }
}
