// "History" tab: the last 24 hours as a bar graph, and energy totals.
import St from 'gi://St';
import {StatRow, dimLabel, sectionLabel, fmtW, fmtWh, fmtDuration, ACCENT, NEUTRAL, CONTENT_W} from './common.js';

const GRAPH_H = 72;
const MIN_SCALE = 5;      // W; keeps a quiet day from looking busy
const MIN_FILLED = 4;     // fewer filled buckets (an hour of use) shows the "collecting" note
const BAR_GAP = 0.6;      // px between bars; 96 bars in 248 px leaves ~2.6 px each
const BAR_STYLES = [[1, ACCENT, 1], [2, NEUTRAL, 0.45]];   // [kind, rgb, alpha]

export class HistoryTab {
    constructor(store) {
        this._store = store;
        this.actor = new St.BoxLayout({vertical: true, style_class: 'pg-page'});

        const graph = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        const head = new St.BoxLayout({style_class: 'pg-hist-head'});
        const eyebrow = sectionLabel('LAST 24 HOURS');
        eyebrow.x_expand = true;
        this._max = dimLabel('', 'pg-hint', false);
        head.add_child(eyebrow);
        head.add_child(this._max);
        graph.add_child(head);

        const plot = new St.BoxLayout({vertical: true, style_class: 'pg-hist-plot'});
        this._area = new St.DrawingArea({width: CONTENT_W, height: GRAPH_H});
        this._repaintId = this._area.connect('repaint', area => this._draw(area));
        plot.add_child(this._area);
        const axis = new St.BoxLayout({style_class: 'pg-hist-axis'});
        const from = dimLabel('24 h ago', 'pg-hint', false);
        from.x_expand = true;
        axis.add_child(from);
        axis.add_child(dimLabel('now', 'pg-hint', false));
        plot.add_child(axis);
        graph.add_child(plot);

        // Same height as the legend, so swapping them doesn't move the rows below.
        this._legend = dimLabel('Blue: measured on battery. Grey: estimated on charger.');
        this._empty = dimLabel('Collecting data. The graph fills in as you use the laptop.');
        this._legend.visible = false;
        graph.add_child(this._legend);
        graph.add_child(this._empty);
        this.actor.add_child(graph);

        const energy = new St.BoxLayout({vertical: true, style_class: 'pg-section'});
        energy.add_child(sectionLabel('ENERGY'));
        const rows = new St.BoxLayout({vertical: true, style_class: 'pg-hist-rows'});
        this._today = new StatRow('Used today');
        rows.add_child(this._today.actor);
        this._avg = new StatRow('Average on battery');
        const avgBox = new St.BoxLayout({vertical: true, style_class: 'pg-hist-stat'});
        avgBox.add_child(this._avg.actor);
        avgBox.add_child(dimLabel('last 24 hours'));
        rows.add_child(avgBox);
        this._since = new StatRow('Since unplugged');
        this._since.hide();
        rows.add_child(this._since.actor);
        // Energy is only recorded while the shell runs, so say when locked/asleep time is missing.
        this._sinceGap = dimLabel('');
        this._sinceGap.visible = false;
        rows.add_child(this._sinceGap);
        energy.add_child(rows);
        this.actor.add_child(energy);

        // What the graph shows, per bar: 0 empty, 1 measured, 2 estimated; height in px.
        this._kinds = new Uint8Array(0);
        this._px = new Uint8Array(0);
    }

    update(_snapshot) {
        const buckets = this._store.buckets(24, 15);
        const n = buckets.length;
        if (this._kinds.length !== n) {
            this._kinds = new Uint8Array(n);
            this._px = new Uint8Array(n);
        }

        let max = 0, filled = 0;
        for (const b of buckets) {
            if (b.watts === null) continue;
            filled++;
            max = Math.max(max, b.watts);
        }
        const scale = Math.max(MIN_SCALE, max);

        // Repaint only when a bar visibly changes; the partial minute moves the last bar every tick.
        let changed = false;
        for (let i = 0; i < n; i++) {
            const w = buckets[i].watts;
            const kind = w === null ? 0 : buckets[i].measured ? 1 : 2;
            const px = kind ? Math.max(1, Math.round(Math.min(1, w / scale) * GRAPH_H)) : 0;
            if (kind !== this._kinds[i] || px !== this._px[i]) {
                this._kinds[i] = kind;
                this._px[i] = px;
                changed = true;
            }
        }
        if (changed) this._area.queue_repaint();

        this._max.text = `${Math.round(scale)} W`;
        this._max.visible = filled > 0;
        const empty = filled < MIN_FILLED;
        this._empty.visible = empty;
        this._legend.visible = !empty;

        const s = this._store.stats();
        this._today.set((s.todayApprox ? '≈ ' : '') + fmtWh(s.todayWh));
        this._avg.set(fmtW(s.avgOnBattery));
        const u = s.sinceUnplug;
        if (u) this._since.set(`${fmtWh(u.wh)} · ${fmtDuration(u.seconds)}`);
        else this._since.hide();
        const missing = u && Number.isFinite(u.covered) ? u.seconds - u.covered : 0;
        this._sinceGap.visible = missing > 300;
        if (this._sinceGap.visible)
            this._sinceGap.text = `Not counting ${fmtDuration(missing)} while locked or asleep.`;
    }

    _draw(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        // Faint baseline, so an empty graph still reads as one.
        cr.setSourceRGBA(...NEUTRAL, 0.3);
        cr.rectangle(0, h - 1, w, 1);
        cr.fill();

        const n = this._kinds.length;
        const slot = w / n, k = h / GRAPH_H;
        for (const [kind, rgb, alpha] of BAR_STYLES) {
            let any = false;
            for (let i = 0; i < n; i++) {
                if (this._kinds[i] !== kind) continue;
                const bh = this._px[i] * k;
                cr.rectangle(i * slot + BAR_GAP / 2, h - bh, slot - BAR_GAP, bh);
                any = true;
            }
            if (any) {
                cr.setSourceRGBA(...rgb, alpha);
                cr.fill();
            }
        }
        cr.$dispose();
    }

    destroy() {
        if (this._repaintId) {
            this._area.disconnect(this._repaintId);
            this._repaintId = 0;
        }
        this._area.destroy();
        this.actor.destroy();
        this._area = null;
        this._store = null;
    }
}
