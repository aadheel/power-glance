import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PowerModel} from './model.js';
import {HistoryStore} from './history.js';
import {AppTracker} from './apps.js';
import {BatteryInfo} from './battery.js';
import {fmtW} from './ui/common.js';
import {NowTab} from './ui/nowTab.js';
import {AppsTab} from './ui/appsTab.js';
import {HistoryTab} from './ui/historyTab.js';
import {BatteryTab} from './ui/batteryTab.js';

const REFRESH_SECONDS = 2;
const TABS = [
    ['now', 'Now'],
    ['apps', 'Apps'],
    ['history', 'History'],
    ['battery', 'Battery'],
];

// Run one module's step; log and swallow its error so the others keep working.
function guard(what, fn) {
    try {
        return fn();
    } catch (e) {
        console.error(`Power Glance: ${what} failed: ${e.message}\n${e.stack}`);
        return null;
    }
}

const PowerIndicator = GObject.registerClass(
class PowerIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Power Glance');

        this._model = new PowerModel();
        this._history = new HistoryStore();
        this._apps = new AppTracker();
        this._battery = new BatteryInfo();
        this._last = null;
        this._active = 'now';

        this._panelLabel = new St.Label({
            text: '– W',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'pg-panel-label',
        });
        this.add_child(this._panelLabel);

        this._buildMenu();
        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            guard('apps', () => this._apps.setViewActive(open && this._active === 'apps'));
            if (open) this._updatePage(this._active);
        });

        // First reading on the next idle, so enabling (which happens on every unlock) stays quick.
        this._firstTick = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._firstTick = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
        // Always keep the timer alive: one module failing must not freeze the whole indicator.
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _updatePage(id) {
        if (this._last) guard(`${id} tab`, () => this._pages[id].update(this._last));
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'pg-box'});
        item.add_child(box);
        this.menu.addMenuItem(item);

        const tabBar = new St.BoxLayout({style_class: 'pg-tabs', x_expand: true});
        box.add_child(tabBar);
        this._tabButtons = {};
        for (const [id, label] of TABS) {
            const b = new St.Button({label, style_class: 'pg-tab', can_focus: true, x_expand: true});
            b.connect('clicked', () => this._select(id));
            tabBar.add_child(b);
            this._tabButtons[id] = b;
        }

        this._pages = {
            now: new NowTab(),
            apps: new AppsTab(this._apps),
            history: new HistoryTab(this._history),
            battery: new BatteryTab(this._battery),
        };
        for (const [id] of TABS) box.add_child(this._pages[id].actor);
        this._select(this._active);
    }

    _select(id) {
        this._active = id;
        for (const [tid] of TABS) {
            const on = tid === id;
            this._pages[tid].actor.visible = on;
            if (on) this._tabButtons[tid].add_style_pseudo_class('checked');
            else this._tabButtons[tid].remove_style_pseudo_class('checked');
        }
        guard('apps', () => this._apps.setViewActive(this.menu.isOpen && id === 'apps'));
        this._updatePage(id);
    }

    _tick() {
        const s = guard('model', () => this._model.read());
        if (!s) return;
        this._last = s;

        this._panelLabel.text = (s.systemMeasured || s.system === null ? '' : '≈ ') + fmtW(s.system);
        if (s.systemMeasured) this._panelLabel.remove_style_class_name('pg-on-ac');
        else this._panelLabel.add_style_class_name('pg-on-ac');

        guard('history', () => this._history.record(s));
        guard('apps', () => this._apps.feed(s));
        if (this.menu.isOpen) this._updatePage(this._active);
    }

    destroy() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._firstTick) {
            GLib.source_remove(this._firstTick);
            this._firstTick = 0;
        }
        // Destroying the button closes the menu, which emits open-state-changed; disconnect first so
        // the handler never runs against torn-down pages.
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = 0;
        }
        for (const page of Object.values(this._pages ?? {})) guard('tab cleanup', () => page.destroy());
        this._pages = null;
        this._model?.destroy();
        this._history?.destroy();
        this._apps?.destroy();
        this._battery?.destroy();
        this._model = this._history = this._apps = this._battery = null;
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
