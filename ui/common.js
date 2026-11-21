// Shared look and helpers for every tab. Keep tabs visually identical by using these.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

export const DIM = 150;            // opacity for secondary text; works on light and dark shell themes
export const CONTENT_W = 248;      // matches .pg-box width in stylesheet.css
export const CHILD_INDENT = 14;    // matches .pg-row-child padding-left
export const ACCENT = [0x62 / 255, 0xa0 / 255, 0xea / 255];   // #62a0ea as cairo RGB
export const NEUTRAL = [0.5, 0.5, 0.5];                         // mid grey as cairo RGB

export const fmtW = w => (w === null || w === undefined || !Number.isFinite(w)) ? '–' : `${w.toFixed(1)} W`;

export function fmtWh(wh) {
    if (wh === null || wh === undefined || !Number.isFinite(wh)) return '–';
    return wh < 10 ? `${wh.toFixed(1)} Wh` : `${Math.round(wh)} Wh`;
}

/** 3725 -> "1 h 2 min", 150 -> "2 min", 20 -> "under 1 min" */
export function fmtDuration(seconds) {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '–';
    const total = Math.round(seconds / 60);
    if (total < 1) return 'under 1 min';
    const h = Math.floor(total / 60), m = total % 60;
    return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function fmtHoursLeft(h) {
    if (!h || !Number.isFinite(h) || h > 48) return null;
    return `${fmtDuration(h * 3600)} left`;
}

/** St labels ellipsize by default, which wins over line_wrap; use this for any multi-line text. */
export function wrapLabel(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

/** Secondary text (captions, hints). */
export function dimLabel(text, styleClass = 'pg-hint', wrap = true) {
    const l = new St.Label({text, style_class: styleClass});
    l.opacity = DIM;
    if (wrap) wrapLabel(l);
    return l;
}

/** Small uppercase heading above a group of rows, e.g. "RIGHT NOW". */
export function sectionLabel(text) {
    const l = new St.Label({text, style_class: 'pg-eyebrow'});
    l.opacity = DIM;
    return l;
}

/**
 * One line with a name on the left, a value on the right and a thin proportional bar below.
 * Optional gicon draws a 16 px app icon before the name.
 */
export class BarRow {
    constructor({name, child = false, hint = null, gicon = null, trackWidth = null}) {
        this.actor = new St.BoxLayout({vertical: true, style_class: child ? 'pg-row pg-row-child' : 'pg-row'});
        const line = new St.BoxLayout({x_expand: true, style_class: 'pg-row-line'});

        this.icon = new St.Icon({icon_size: 16, style_class: 'pg-row-icon', y_align: Clutter.ActorAlign.CENTER});
        this.icon.visible = false;
        line.add_child(this.icon);
        if (gicon) this.setIcon(gicon);

        this.nameLabel = new St.Label({text: name, x_expand: true, style_class: 'pg-row-name', y_align: Clutter.ActorAlign.CENTER});
        this.nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        if (child) this.nameLabel.opacity = 210;
        this.value = new St.Label({text: '–', style_class: 'pg-row-value', y_align: Clutter.ActorAlign.CENTER});
        line.add_child(this.nameLabel);
        line.add_child(this.value);
        this.actor.add_child(line);

        if (hint) this.actor.add_child(dimLabel(hint));

        this.trackW = trackWidth ?? (child ? CONTENT_W - CHILD_INDENT : CONTENT_W);
        const track = new St.Widget({style_class: 'pg-track', width: this.trackW, x_expand: false});
        this.fill = new St.Widget({style_class: child ? 'pg-fill pg-fill-child' : 'pg-fill'});
        track.add_child(this.fill);
        this.actor.add_child(track);
    }

    setName(text) { this.nameLabel.text = text; }

    setIcon(gicon) {
        this.icon.gicon = gicon ?? null;
        this.icon.visible = !!gicon;
    }

    /** fraction is 0..1 of the bar. */
    set(valueText, fraction) {
        this.actor.visible = true;
        this.value.text = valueText;
        const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
        this.fill.width = Math.max(2, Math.round(f * this.trackW));
    }

    /** Hides the row when watts is null. */
    setWatts(watts, base, approx = false) {
        if (watts === null || watts === undefined) { this.hide(); return; }
        this.set((approx ? '≈ ' : '') + fmtW(watts), base > 0 ? watts / base : 0);
    }

    hide() { this.actor.visible = false; }
}

/** A plain "label ........ value" line without a bar, for stats. */
export class StatRow {
    constructor(name) {
        this.actor = new St.BoxLayout({x_expand: true, style_class: 'pg-stat'});
        this.nameLabel = new St.Label({text: name, x_expand: true, style_class: 'pg-row-name', y_align: Clutter.ActorAlign.CENTER});
        this.value = new St.Label({text: '–', style_class: 'pg-row-value', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this.nameLabel);
        this.actor.add_child(this.value);
    }

    set(text) { this.actor.visible = true; this.value.text = text; }
    hide() { this.actor.visible = false; }
}
