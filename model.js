// Turns raw sensor readings into one "snapshot" per tick: smoothed, reconciled, ready to display or log.
import GLib from 'gi://GLib';
import {Sensors} from './sensors.js';

const SMOOTHING = 0.35;   // battery readings jump around; ease them a little
const DEVICES = ['screen', 'wifi', 'storage', 'ram'];

export class PowerModel {
    constructor() {
        this._sensors = new Sensors();
        this._ema = {};
    }

    destroy() {
        this._sensors.destroy();
    }

    _smooth(key, v) {
        if (v === null || v === undefined) { delete this._ema[key]; return null; }
        const prev = this._ema[key];
        this._ema[key] = prev === undefined ? v : prev + SMOOTHING * (v - prev);
        return this._ema[key];
    }

    /** @returns {Snapshot} see docs/ARCHITECTURE.md */
    read() {
        const r = this._sensors.read();
        const total = this._smooth('total', r.total);
        // Smooth the package exactly like the total so "rest = total - package" stays sensible when
        // load changes, and never let the package exceed the whole-laptop figure it is part of.
        let socket = this._smooth('socket', r.socket);
        if (socket !== null && total !== null) socket = Math.min(socket, total);

        // The package total is a firmware average, but the CPU/graphics/memory parts are instant
        // samples: one busy core can briefly read 7 W while the package average says 4 W. Smooth the
        // parts, then scale them down if together they still exceed the package they belong to.
        const parts = {cpu: this._smooth('cpu', r.cpu), gfx: this._smooth('gfx', r.gfx), soc: this._smooth('soc', r.soc)};
        const partSum = (parts.cpu ?? 0) + (parts.gfx ?? 0) + (parts.soc ?? 0);
        if (socket !== null && partSum > socket && partSum > 0) {
            const f = socket / partSum;
            for (const k of ['cpu', 'gfx', 'soc']) if (parts[k] !== null) parts[k] *= f;
        }
        let rest = total !== null && socket !== null ? Math.max(0, total - socket) : null;

        // Estimated devices. On battery, fit them inside the measured remainder; the gap is "other".
        const est = {};
        let estSum = 0;
        for (const k of DEVICES) {
            est[k] = this._smooth(k, r.devices?.[k] ?? null);
            if (est[k] !== null) estSum += est[k];
        }
        let other = null, restApprox = false;
        if (rest !== null) {
            if (estSum > rest && estSum > 0) {
                const f = rest / estSum;
                for (const k of DEVICES) if (est[k] !== null) est[k] *= f;
                other = 0;
            } else {
                other = rest - estSum;
            }
        } else if (estSum > 0) {
            rest = estSum;
            restApprox = true;
        }

        // On the charger an estimate is only meaningful when the processor is measured; without it
        // the "total" would leave out the biggest consumer.
        const system = total ?? (socket !== null ? socket + (rest ?? 0) : null);

        return {
            monotonic: GLib.get_monotonic_time() / 1e6,
            wall: GLib.get_real_time() / 1e6,
            status: r.status,
            percent: r.percent,
            hoursLeft: r.hoursLeft,
            total,
            socket,
            cpu: parts.cpu,
            gfx: parts.gfx,
            soc: parts.soc,
            rest,
            restApprox,
            screen: est.screen,
            wifi: est.wifi,
            storage: est.storage,
            ram: est.ram,
            other,
            system,
            systemMeasured: total !== null,
        };
    }
}
