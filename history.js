// Power history: one record per wall-clock minute, kept for a week in a JSON Lines file.
// Only uses GLib/Gio so it can be tested with plain gjs.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const KEEP_SECONDS = 7 * 86400;
const DAY = 86400;
const FLUSH_SECONDS = 60;      // the shell never calls disable() at logout, so this bounds the loss
const MAX_GAP = 10;            // seconds; a longer pause between ticks is a break, not data
const PARSE_CHUNK = 150;       // lines per idle callback while loading (well under 1 ms)
const WRITE_CHUNK = 1000;      // records serialized per idle callback when rewriting (about 1 ms)
const OVERLAP = 120;           // seconds; a clock step back up to this only repeats minutes
const STATUS_CODES = {Discharging: 'D', Charging: 'C', Full: 'F'};
const VALID_STATUS = new Set(['D', 'C', 'F', 'N']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Keyed by data directory. Survives the destroy + new store of every lock/unlock, so the loaded log
// and the partial minute are not lost or re-read. Plain data only.
const shared = new Map();

function stateFor(dir) {
    let st = shared.get(dir);
    if (!st) {
        st = {
            records: [],        // finished minutes, sorted by t
            pending: [],        // finished minutes not yet on disk
            cur: null,          // minute being filled: {t, e: watt-seconds, cov: seconds, m, s, p}
            last: null,         // previous snapshot {wall, mono}
            status: null,       // status code of the newest snapshot
            loaded: false,
            rewrite: false,     // the file holds lines memory doesn't (old, bad or wrongly dated)
            trimmed: 0,         // minutes aged out of memory since the file was last rewritten
            busy: false,        // a write is in flight; writes never overlap
            newline: false,     // last append failed and may have left half a line
            rev: 0,             // bumps whenever records change, for the caches
        };
        shared.set(dir, st);
    }
    return st;
}

const minuteOf = wall => Math.floor(wall / 60) * 60;
const round2 = x => Math.round(x * 100) / 100;
const isCancel = e => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

function lowerBound(recs, t) {
    let lo = 0, hi = recs.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (recs[mid].t < t) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function localMidnight(now) {
    const d = GLib.DateTime.new_from_unix_local(Math.floor(now));
    const m = GLib.DateTime.new_local(d.get_year(), d.get_month(), d.get_day_of_month(), 0, 0, 0);
    return m ? m.to_unix() : Math.floor(now) - d.get_hour() * 3600 - d.get_minute() * 60 - d.get_second();
}

function parseLine(line) {
    let r;
    try {
        r = JSON.parse(line);
    } catch (e) {
        return null;
    }
    if (!r || !Number.isInteger(r.t) || r.t % 60 !== 0 || !Number.isFinite(r.w) ||
        !Number.isInteger(r.c) || r.c < 1 || r.c > 60)
        return null;
    return {
        t: r.t, w: r.w, c: r.c, m: r.m ? 1 : 0,
        s: VALID_STATUS.has(r.s) ? r.s : 'N',
        p: Number.isFinite(r.p) ? Math.round(r.p) : null,
    };
}

const toText = recs => recs.map(r => `${JSON.stringify(r)}\n`).join('');

// True when the battery level rose between two battery minutes that have a gap between them,
// which means it was charged while the shell wasn't recording (screen locked or asleep).
function chargedBetween(older, newer) {
    return newer.t - older.t > 120 && older.p !== null && newer.p !== null &&
        older.p !== undefined && newer.p !== undefined && newer.p > older.p + 1;
}

export class HistoryStore {
    constructor({dataDir} = {}) {
        this._dir = dataDir ?? GLib.build_filenamev([GLib.get_user_data_dir(), 'power-glance']);
        this._file = Gio.File.new_for_path(GLib.build_filenamev([this._dir, 'history.jsonl']));
        this._st = stateFor(this._dir);
        this._cancellable = new Gio.Cancellable();
        this._destroyed = false;
        this._idleId = 0;
        this._writeIdle = 0;
        this._bucketCache = null;
        this._statsCache = null;

        if (!this._st.loaded) {
            this._makeDir();
            this._file.load_contents_async(this._cancellable, (f, res) => this._onLoaded(f, res));
        }
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, FLUSH_SECONDS, () => {
            this._flush();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get ready() {
        return this._st.loaded;
    }

    // Newest snapshot time, so results line up with what was recorded.
    _now() {
        return this._st.last?.wall ?? GLib.get_real_time() / 1e6;
    }

    record(s) {
        if (this._destroyed) return;
        const st = this._st;
        const prev = st.last;
        st.last = {wall: s.wall, mono: s.monotonic};
        const code = STATUS_CODES[s.status] ?? 'N';
        const pct = Number.isFinite(s.percent) ? Math.round(s.percent) : null;
        st.status = code;

        const minute = minuteOf(s.wall);
        const watts = Number.isFinite(s.system) ? Math.max(0, s.system) : null;
        const dt = prev ? s.monotonic - prev.mono : 0;
        // Lock, suspend or a clock change: monotonic and wall time disagree, or the tick came late.
        const joined = prev && dt > 0 && dt <= MAX_GAP && Math.abs(s.wall - prev.wall - dt) <= MAX_GAP;
        let cur;
        if (joined && watts !== null) {
            // A sample covers the dt before it; split it where that straddles a minute boundary
            // (only into the minute being filled, should the wall clock have been nudged).
            const from = s.wall - dt;
            if (minuteOf(from) < minute && st.cur?.t === minuteOf(from)) {
                this._add(minuteOf(from), minute - from, watts, s.systemMeasured, code, pct);
                cur = this._add(minute, s.wall - minute, watts, s.systemMeasured, code, pct);
            } else {
                cur = this._add(minute, dt, watts, s.systemMeasured, code, pct);
            }
        } else {
            cur = this._add(minute, 0, 0, true, code, pct);
        }
        // A minute's status is that of the last snapshot taken inside it.
        cur.s = code;
        cur.p = pct;
    }

    _add(t, seconds, watts, measured, code, pct) {
        const st = this._st;
        let c = st.cur;
        if (!c || c.t !== t) {
            if (c) this._finish();
            c = st.cur = {t, e: 0, cov: 0, m: true, s: code, p: pct};
        }
        if (seconds > 0) {
            c.e += watts * seconds;
            c.cov += seconds;
            if (!measured) c.m = false;
        }
        return c;
    }

    _finish() {
        const st = this._st, c = st.cur;
        st.cur = null;
        if (!c || c.cov < 0.5) return;
        const n = st.records.length;
        if (n && st.records[n - 1].t >= c.t) {
            // The wall clock went backwards. A small step only repeats a minute or two: drop the repeat.
            if (st.records[n - 1].t - c.t <= OVERLAP) return;
            // A big step means the newer minutes were stamped by a wrong clock: drop those instead.
            const bad = new Set(st.records.splice(lowerBound(st.records, c.t)));
            const pending = st.pending.filter(r => !bad.has(r));
            if (pending.length + bad.size > st.pending.length) st.rewrite = true;   // some are on disk
            st.pending = pending;
        }
        const rec = {t: c.t, w: round2(c.e / c.cov), c: Math.min(60, Math.round(c.cov)), m: c.m ? 1 : 0, s: c.s, p: c.p};
        st.records.push(rec);
        st.pending.push(rec);
        st.rev++;
    }

    buckets(hours = 24, bucketMinutes = 15) {
        const st = this._st;
        const size = bucketMinutes * 60;
        const n = Math.max(1, Math.round(hours * 60 / bucketMinutes));
        const end = (Math.floor(this._now() / size) + 1) * size;
        const start = end - n * size;

        // Finished minutes change once a minute; only the partial minute is added on every call.
        let k = this._bucketCache;
        if (!k || k.rev !== st.rev || k.end !== end || k.n !== n || k.size !== size) {
            k = this._bucketCache = {
                rev: st.rev, end, n, size,
                ws: new Float64Array(n), cov: new Float64Array(n), mcov: new Float64Array(n),
            };
            const recs = st.records;
            for (let i = lowerBound(recs, start); i < recs.length && recs[i].t < end; i++) {
                const r = recs[i], b = Math.floor((r.t - start) / size);
                k.ws[b] += r.w * r.c;
                k.cov[b] += r.c;
                if (r.m) k.mcov[b] += r.c;
            }
        }

        const cur = st.cur;
        const curB = cur && cur.cov > 0 && cur.t >= start && cur.t < end ? Math.floor((cur.t - start) / size) : -1;
        const out = new Array(n);
        for (let b = 0; b < n; b++) {
            let ws = k.ws[b], cov = k.cov[b], mcov = k.mcov[b];
            if (b === curB) {
                ws += cur.e;
                cov += cur.cov;
                if (cur.m) mcov += cur.cov;
            }
            out[b] = {start: start + b * size, watts: cov > 0 ? ws / cov : null, measured: cov > 0 && mcov * 2 >= cov};
        }
        return out;
    }

    stats() {
        const st = this._st, now = this._now();
        const midnight = localMidnight(now);
        const dayAgo = minuteOf(now - DAY);

        let k = this._statsCache;
        if (!k || k.rev !== st.rev || k.midnight !== midnight || k.dayAgo !== dayAgo)
            k = this._statsCache = this._sumRecords(midnight, dayAgo);

        let {todayWs, todayCov, todayApprox, batWs, batCov} = k;
        const cur = st.cur?.cov > 0 ? st.cur : null;
        if (cur && cur.t >= midnight) {
            todayWs += cur.e;
            todayCov += cur.cov;
            if (!cur.m) todayApprox = true;
        }
        if (cur && cur.t >= dayAgo && cur.m && cur.s === 'D') {
            batWs += cur.e;
            batCov += cur.cov;
        }

        let sinceUnplug = null;
        if (st.status === 'D') {
            let {runWs, runCov, runSince} = k;
            const last = st.records.length ? st.records[st.records.length - 1] : null;
            if (cur && last && last.s === 'D' && chargedBetween(last, cur)) {
                runWs = 0;
                runCov = 0;
                runSince = null;
            }
            if (cur) {
                runWs += cur.e;
                runCov += cur.cov;
                // Unplugged during this minute: its covered seconds are the most recent ones.
                runSince ??= Math.max(cur.t, Math.min(cur.t + 60, now) - cur.cov);
            }
            if (runCov > 0)
                sinceUnplug = {since: runSince, wh: runWs / 3600, seconds: Math.max(0, now - runSince), covered: runCov, avgW: runWs / runCov};
        }

        return {
            todayWh: todayCov > 0 ? todayWs / 3600 : null,
            todayApprox: todayCov > 0 && todayApprox,
            avgOnBattery: batCov > 0 ? batWs / batCov : null,
            sinceUnplug,
        };
    }

    _sumRecords(midnight, dayAgo) {
        const recs = this._st.records;
        const k = {
            rev: this._st.rev, midnight, dayAgo,
            todayWs: 0, todayCov: 0, todayApprox: false, batWs: 0, batCov: 0,
            runWs: 0, runCov: 0, runSince: null,
        };
        for (let i = lowerBound(recs, Math.min(midnight, dayAgo)); i < recs.length; i++) {
            const r = recs[i], ws = r.w * r.c;
            if (r.t >= midnight) {
                k.todayWs += ws;
                k.todayCov += r.c;
                if (!r.m) k.todayApprox = true;
            }
            if (r.t >= dayAgo && r.m && r.s === 'D') {
                k.batWs += ws;
                k.batCov += r.c;
            }
        }
        // Lock and suspend leave holes in the log but don't end the run; a minute on the charger does,
        // and so does a battery level that went up across a hole (charged while locked or asleep).
        let newer = null;
        for (let i = recs.length - 1; i >= 0 && recs[i].s === 'D'; i--) {
            const r = recs[i];
            if (newer && chargedBetween(r, newer)) break;
            newer = r;
            k.runWs += r.w * r.c;
            k.runCov += r.c;
            k.runSince = r.t + 60 - r.c;
        }
        return k;
    }

    _makeDir() {
        this._file.get_parent().make_directory_async(GLib.PRIORITY_DEFAULT, this._cancellable, (dir, res) => {
            try {
                dir.make_directory_finish(res);
            } catch (e) {
                // Parent missing too: only on a brand-new account, so a blocking mkdir is fine.
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    GLib.mkdir_with_parents(dir.get_path(), 0o755);
            }
        });
    }

    _onLoaded(file, res) {
        const st = this._st;
        let bytes = null;
        try {
            [, bytes] = file.load_contents_finish(res);
        } catch (e) {
            if (isCancel(e)) return;
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`Power Glance: cannot read ${file.get_path()}: ${e.message}`);
        }
        if (this._destroyed) return;
        if (!bytes) {
            this._finishLoad([], [], 0);
            return;
        }

        // Decoding and parsing a week of lines takes a few ms; do both a chunk of lines at a time so the
        // shell never stalls.
        const len = bytes.length;
        const now = this._now();
        const cutoff = now - KEEP_SECONDS, future = now + 60;
        const recs = [];
        let pos = 0, dropped = 0, sorted = true;
        // A cut-off last line: rewrite the file so the next append starts on a line of its own.
        if (len && bytes[len - 1] !== 10) {
            dropped++;
            st.newline = true;
        }
        this._idleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            let end = pos;
            for (let n = 0; n < PARSE_CHUNK && end < len; n++) {
                const nl = bytes.indexOf(10, end);
                end = nl < 0 ? len : nl + 1;
            }
            const lines = decoder.decode(bytes.subarray(pos, end)).split('\n');
            pos = end;
            for (const raw of lines) {
                const line = raw.trim();
                if (!line) continue;
                const r = parseLine(line);
                if (!r || r.t < cutoff || r.t > future) {
                    dropped++;
                    continue;
                }
                if (recs.length && r.t <= recs[recs.length - 1].t) sorted = false;
                recs.push(r);
            }
            if (pos < len) return GLib.SOURCE_CONTINUE;

            this._idleId = 0;
            if (sorted) {
                this._finishLoad(recs, dropped);
            } else {
                // Only after a clock change or a damaged file.
                recs.sort((a, b) => a.t - b.t);
                const r2 = recs.filter((r, j) => j === 0 || r.t !== recs[j - 1].t);
                this._finishLoad(r2, dropped + 1);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _finishLoad(recs, dropped) {
        const st = this._st;
        const lastT = recs.length ? recs[recs.length - 1].t : -Infinity;
        // Minutes recorded while loading: anything not newer than the file is already in it.
        st.records = recs.concat(st.records.filter(r => r.t > lastT));
        st.pending = st.pending.filter(r => r.t > lastT);
        st.loaded = true;
        st.rev++;
        if (dropped > 0) {
            st.rewrite = true;
            this._pump();
        }
    }

    _flush() {
        const st = this._st;
        const cutoff = this._now() - KEEP_SECONDS;
        let n = 0;
        while (n < st.records.length && st.records[n].t < cutoff) n++;
        if (n) {
            st.records.splice(0, n);
            st.rev++;
            // Keep the file near a week as well, rewriting it about once a day of aged-out minutes.
            st.trimmed += n;
            if (st.trimmed >= DAY / 60) st.rewrite = true;
        }
        this._pump();
    }

    // One write at a time: a pending rewrite first, then new minutes.
    _pump() {
        const st = this._st;
        if (this._destroyed || st.busy) return;
        // Never rewrite before the load: the file still holds lines memory hasn't seen.
        if (st.rewrite && st.loaded) this._rewrite();
        else if (st.pending.length) this._append();
    }

    // The file becomes every record not pending (those are what is on disk), serialized in slices
    // since a week of lines takes over 10 ms.
    _rewrite() {
        const st = this._st;
        st.rewrite = false;
        st.trimmed = 0;
        st.busy = true;
        const pend = new Set(st.pending);
        const recs = st.records.slice();
        const chunks = [];   // encoded per slice too: one encode of the whole week alone takes ms
        let i = 0, size = 0;
        this._writeIdle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            let text = '';
            for (const stop = Math.min(recs.length, i + WRITE_CHUNK); i < stop; i++) {
                if (!pend.has(recs[i])) text += `${JSON.stringify(recs[i])}\n`;
            }
            if (text) {
                chunks.push(encoder.encode(text));
                size += chunks[chunks.length - 1].length;
            }
            if (i < recs.length) return GLib.SOURCE_CONTINUE;
            this._writeIdle = 0;
            if (size) {
                const all = new Uint8Array(size);
                let at = 0;
                for (const c of chunks) {
                    all.set(c, at);
                    at += c.length;
                }
                this._replace(new GLib.Bytes(all));
            } else {
                this._remove();     // empty GBytes has no buffer, which replace_contents rejects
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _replace(bytes) {
        this._file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE,
            this._cancellable, (f, res) => this._rewritten(() => f.replace_contents_finish(res)));
    }

    _remove() {
        this._file.delete_async(GLib.PRIORITY_LOW, this._cancellable,
            (f, res) => this._rewritten(() => {
                try {
                    f.delete_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) throw e;
                }
            }));
    }

    _rewritten(finish) {
        const st = this._st;
        st.busy = false;
        try {
            finish();
            st.newline = false;
        } catch (e) {
            if (isCancel(e)) {
                st.rewrite = true;     // the next store retries
                return;
            }
            // Extra lines stay on disk; the next load prunes them.
            console.warn(`Power Glance: cannot rewrite ${this._file.get_path()}: ${e.message}`);
        }
        this._pump();
    }

    _append() {
        const st = this._st;
        const batch = st.pending.slice();
        const text = (st.newline ? '\n' : '') + toText(batch);
        const bytes = new GLib.Bytes(encoder.encode(text));

        st.busy = true;
        const done = e => {
            st.busy = false;
            if (!e) {
                const written = new Set(batch);
                st.pending = st.pending.filter(r => !written.has(r));
                st.newline = false;
            } else if (!isCancel(e)) {
                st.newline = true;
                console.warn(`Power Glance: cannot write ${this._file.get_path()}: ${e.message}`);
            }
            // A rewrite that was waiting for this append.
            if (st.rewrite) this._pump();
        };
        this._file.append_to_async(Gio.FileCreateFlags.NONE, GLib.PRIORITY_LOW, this._cancellable, (f, res) => {
            let stream;
            try {
                stream = f.append_to_finish(res);
            } catch (e) {
                done(e);
                return;
            }
            const source = Gio.MemoryInputStream.new_from_bytes(bytes);
            const flags = Gio.OutputStreamSpliceFlags.CLOSE_SOURCE | Gio.OutputStreamSpliceFlags.CLOSE_TARGET;
            stream.splice_async(source, flags, GLib.PRIORITY_LOW, this._cancellable, (s, r) => {
                try {
                    s.splice_finish(r);
                    done(null);
                } catch (e) {
                    done(e);
                }
            });
        });
    }

    // Small blocking append, only from destroy().
    _appendSync() {
        const st = this._st;
        if (!st.pending.length) return;
        try {
            GLib.mkdir_with_parents(this._dir, 0o755);
            const stream = this._file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write_all(encoder.encode((st.newline ? '\n' : '') + toText(st.pending)), null);
            stream.close(null);
            st.pending = [];
            st.newline = false;
        } catch (e) {
            st.newline = true;
            console.warn(`Power Glance: cannot write ${this._file.get_path()}: ${e.message}`);
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        if (this._timerId) GLib.source_remove(this._timerId);
        if (this._idleId) GLib.source_remove(this._idleId);
        if (this._writeIdle) {
            // A rewrite still being prepared never touched the file; the next store redoes it.
            GLib.source_remove(this._writeIdle);
            this._st.busy = false;
            this._st.rewrite = true;
        }
        this._timerId = this._idleId = this._writeIdle = 0;
        this._cancellable.cancel();
        // A write still in flight owns the file; its minutes stay pending for the next store.
        if (!this._st.busy) this._appendSync();
        this._bucketCache = this._statsCache = null;
    }
}
