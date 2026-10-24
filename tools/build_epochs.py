"""Build per-second replay epochs + outages from a Google GnssLogger text log.

Usage: python -I build_epochs.py <gnss_log.txt> <out.json> "<display name>" [--flip-yaw]

yaw: per-second circular mean of the GameRotationVector azimuth computed like
Android SensorManager.getRotationMatrixFromVector + getOrientation
(azimuth = atan2(R[0][1], R[1][1]), clockwise-positive), unwrapped across the
recording. Zero is arbitrary (no magnetometer); only changes matter.
--flip-yaw negates it (only if validation shows it turns the wrong way).

The log is treated as untrusted data. Column positions come from the
'# <Type>,<col>,...' header lines (never hardcoded indexes).

Time binning
- Every row is assigned to an integer UTC second.
- Fix rows: floor(UnixTimeMillis / 1000). GPS-provider fixes are stamped at
  exactly .000, so floor == round for them.
- Raw / Agc rows (GNSS measurement epochs): round to the NEAREST second.
  Their utcTimeMillis is derived from the GNSS clock and truncated, so 1 Hz
  epochs land at x.994-x.999 (occasionally x+1.000). Flooring would put each
  measurement epoch one second before the GPS fix computed from it, and would
  leave some seconds empty / doubled when an epoch lands exactly on .000.
- Agc rows whose utcTimeMillis is empty (receiver lost GPS time, e.g. in a
  tunnel) are timed from the continuous hardware clock: nearest Raw/Agc
  reference with the same HardwareClockDiscontinuityCount,
  utc = ref_utc + (TimeNanos - ref_TimeNanos) / 1e6.
"""
import bisect
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

HEADER_RE = re.compile(r"^#\s*([A-Za-z][A-Za-z0-9_]*),(.*)$")
TIME_COLS = ("utcTimeMillis", "UnixTimeMillis")
GPS_L1_HZ = 1575.42e6
L1_TOL_HZ = 1.0e6
GPS_UNIX_OFFSET_S = 315964800  # 1980-01-06T00:00:00Z
COLS = ["t", "lat", "lon", "acc", "spd", "brg", "nsat", "cn0", "agc", "yaw"]
MIN_OUTAGE_S = 5
EARTH_R = 6371008.8


def wrap180(a):
    return (a + 180.0) % 360.0 - 180.0


def quat_azimuth_rad(x, y, z, w):
    """Android getRotationMatrixFromVector + getOrientation azimuth."""
    if w is None:
        w = 1.0 - x * x - y * y - z * z
        w = math.sqrt(w) if w > 0 else 0.0
    r01 = 2 * x * y - 2 * z * w          # R[1]  (row 0, col 1)
    r11 = 1 - 2 * x * x - 2 * z * z      # R[4]  (row 1, col 1)
    return math.atan2(r01, r11)


def destination(lat, lon, brg_deg, dist_m):
    d = dist_m / EARTH_R
    b = math.radians(brg_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def initial_bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    yv = math.sin(dl) * math.cos(p2)
    xv = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(yv, xv)) % 360.0


def fnum(s):
    if s is None:
        return None
    s = s.strip()
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def inum(s):
    v = fnum(s)
    return None if v is None else int(v)


def iso(t):
    return datetime.fromtimestamp(t, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def haversine_m(lat1, lon1, lat2, lon2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def r1(v):
    return None if v is None else round(v, 1)


def parse(path):
    headers = {}
    counts = Counter()
    tmin_ms = tmax_ms = None

    # Raw per rounded second
    raw_sats = defaultdict(set)              # sec -> {(const, svid)}
    raw_sig = defaultdict(dict)              # sec -> {(const, svid, freqkey): max cn0}
    raw_agc_l1 = defaultdict(list)           # sec -> [AgcDb] (GPS L1 Raw rows)
    raw_epochs_round = defaultdict(set)      # sec -> {utc ms of epoch}
    raw_epochs_floor = defaultdict(set)
    agc_l1 = defaultdict(list)               # sec -> [AgcDb] from Agc rows
    agc_l1_inferred = defaultdict(list)
    clock_refs = defaultdict(list)           # hwdisc -> [(TimeNanos, utc_ms)]
    pending_agc = []                         # (hwdisc, TimeNanos, agcdb)
    agc_timeless_total = 0
    clock_check = []                         # |utc_ms - computed| samples

    gps_fix = {}                             # sec -> (ms, fields)
    gps_dupes = 0
    yaw_sc = defaultdict(lambda: [0.0, 0.0, 0])   # sec -> [sum sin, sum cos, n]
    grv_w_missing = 0
    other_fix = Counter()
    other_fix_span = {}

    with open(path, "r", encoding="utf-8", errors="replace", newline=None) as fh:
        for line in fh:
            line = line.rstrip("\r\n")
            if not line:
                continue
            if line[0] == "#":
                m = HEADER_RE.match(line)
                if m:
                    cols = [c.strip() for c in m.group(2).split(",")]
                    headers[m.group(1)] = {c: i + 1 for i, c in enumerate(cols)}
                continue
            parts = line.split(",")
            rtype = parts[0]
            counts[rtype] += 1
            h = headers.get(rtype)
            if h is None:
                continue
            n = len(parts)

            def g(col, _h=h, _p=parts, _n=n):
                i = _h.get(col)
                return _p[i] if i is not None and i < _n else None

            ms = None
            for tc in TIME_COLS:
                if tc in h:
                    ms = fnum(g(tc))
                    break
            if ms is not None:
                if tmin_ms is None or ms < tmin_ms:
                    tmin_ms = ms
                if tmax_ms is None or ms > tmax_ms:
                    tmax_ms = ms

            if rtype == "Raw":
                if ms is None:
                    continue
                sec = int(math.floor((ms + 500) / 1000))
                raw_epochs_round[sec].add(ms)
                raw_epochs_floor[int(ms // 1000)].add(ms)
                const = inum(g("ConstellationType"))
                svid = inum(g("Svid"))
                cn0 = fnum(g("Cn0DbHz"))
                freq = fnum(g("CarrierFrequencyHz"))
                if cn0 is not None and cn0 > 0 and const is not None and svid is not None:
                    raw_sats[sec].add((const, svid))
                    key = (const, svid, None if freq is None else round(freq / 1e5), g("CodeType"))
                    prev = raw_sig[sec].get(key)
                    if prev is None or cn0 > prev:
                        raw_sig[sec][key] = cn0
                agc = fnum(g("AgcDb"))
                if agc is not None and const == 1 and freq is not None and abs(freq - GPS_L1_HZ) <= L1_TOL_HZ:
                    raw_agc_l1[sec].append(agc)
                tn = fnum(g("TimeNanos"))
                hw = inum(g("HardwareClockDiscontinuityCount"))
                if tn is not None and hw is not None:
                    clock_refs[hw].append((tn, ms))
                fb = fnum(g("FullBiasNanos"))
                bn = fnum(g("BiasNanos")) or 0.0
                ls = fnum(g("LeapSecond"))
                if tn is not None and fb is not None and ls is not None and len(clock_check) < 50000:
                    gps_ns = tn - (fb + bn)
                    utc_ms_calc = gps_ns / 1e6 + (GPS_UNIX_OFFSET_S - ls) * 1000
                    clock_check.append(utc_ms_calc - ms)

            elif rtype == "Agc":
                const = inum(g("ConstellationType"))
                freq = fnum(g("CarrierFrequencyHz"))
                agc = fnum(g("AgcDb"))
                tn = fnum(g("TimeNanos"))
                hw = inum(g("HardwareClockDiscontinuityCount"))
                is_l1 = const == 1 and freq is not None and abs(freq - GPS_L1_HZ) <= L1_TOL_HZ
                if ms is None:
                    agc_timeless_total += 1
                    if is_l1 and agc is not None and tn is not None and hw is not None:
                        pending_agc.append((hw, tn, agc))
                    continue
                if tn is not None and hw is not None:
                    clock_refs[hw].append((tn, ms))
                if is_l1 and agc is not None:
                    agc_l1[int(math.floor((ms + 500) / 1000))].append(agc)

            elif rtype == "Fix":
                prov = (g("Provider") or "").strip()
                if prov.lower() != "gps":
                    other_fix[prov] += 1
                    if ms is not None:
                        lo, hi = other_fix_span.get(prov, (ms, ms))
                        other_fix_span[prov] = (min(lo, ms), max(hi, ms))
                    continue
                if ms is None:
                    continue
                lat = fnum(g("LatitudeDegrees"))
                lon = fnum(g("LongitudeDegrees"))
                if lat is None or lon is None:
                    continue
                sec = int(ms // 1000)
                fields = {
                    "lat": lat, "lon": lon,
                    "acc": fnum(g("AccuracyMeters")),
                    "spd": fnum(g("SpeedMps")),
                    "brg": fnum(g("BearingDegrees")),
                    "used": inum(g("NumberOfUsedSignals")),
                }
                if sec in gps_fix:
                    gps_dupes += 1
                    if ms < gps_fix[sec][0]:
                        continue
                gps_fix[sec] = (ms, fields)

            elif rtype == "GameRotationVector":
                if ms is None:
                    continue
                x, y, z = fnum(g("x")), fnum(g("y")), fnum(g("z"))
                if x is None or y is None or z is None:
                    continue
                w = fnum(g("w")) if "w" in h else None
                if w is None:
                    grv_w_missing += 1
                az = quat_azimuth_rad(x, y, z, w)
                acc_ = yaw_sc[int(ms // 1000)]
                acc_[0] += math.sin(az)
                acc_[1] += math.cos(az)
                acc_[2] += 1

    # Resolve Agc rows without utcTimeMillis via the hardware clock.
    for hw in clock_refs:
        clock_refs[hw].sort()
    resolved = unresolved = 0
    for hw, tn, agc in pending_agc:
        refs = clock_refs.get(hw)
        if not refs:
            unresolved += 1
            continue
        i = bisect.bisect_left(refs, (tn, -math.inf))
        cands = [refs[j] for j in (i - 1, i) if 0 <= j < len(refs)]
        rtn, rms = min(cands, key=lambda r: abs(r[0] - tn))
        ms = rms + (tn - rtn) / 1e6
        agc_l1_inferred[int(math.floor((ms + 500) / 1000))].append(agc)
        if tmax_ms is not None and ms > tmax_ms + 1000:
            pass  # stays inside span check below
        resolved += 1

    return {
        "headers": headers, "counts": counts, "tmin_ms": tmin_ms, "tmax_ms": tmax_ms,
        "raw_sats": raw_sats, "raw_sig": raw_sig, "raw_agc_l1": raw_agc_l1,
        "raw_epochs_round": raw_epochs_round, "raw_epochs_floor": raw_epochs_floor,
        "agc_l1": agc_l1, "agc_l1_inferred": agc_l1_inferred,
        "agc_timeless_total": agc_timeless_total, "agc_resolved": resolved,
        "agc_unresolved": unresolved, "clock_check": clock_check,
        "gps_fix": gps_fix, "gps_dupes": gps_dupes,
        "other_fix": other_fix, "other_fix_span": other_fix_span,
        "yaw_sc": yaw_sc, "grv_w_missing": grv_w_missing,
    }


def build(d, yaw_sign=1.0):
    start = int(d["tmin_ms"] // 1000)
    end = int(d["tmax_ms"] // 1000)
    # make sure rounded Raw/Agc seconds are inside the span
    for k in ("raw_epochs_round", "agc_l1", "agc_l1_inferred"):
        if d[k]:
            start = min(start, min(d[k]))
            end = max(end, max(d[k]))

    # Per-second circular mean of the azimuth, unwrapped across the recording.
    yaw_un = {}
    prev_az = prev_un = None
    for t in range(start, end + 1):
        sc = d["yaw_sc"].get(t)
        if not sc or sc[2] == 0:
            continue
        az = math.degrees(math.atan2(sc[0], sc[1]))
        un = az if prev_un is None else prev_un + wrap180(az - prev_az)
        prev_az, prev_un = az, un
        yaw_un[t] = yaw_sign * un

    epochs = []
    agc_src = Counter()
    agc_disagree = 0
    used_by_sec = {}
    for t in range(start, end + 1):
        lat = lon = acc = spd = brg = None
        f = d["gps_fix"].get(t)
        if f:
            fx = f[1]
            lat = round(fx["lat"], 6)
            lon = round(fx["lon"], 6)
            acc = r1(fx["acc"])
            spd = r1(fx["spd"])
            brg = None if fx["brg"] is None else int(round(fx["brg"])) % 360
            used_by_sec[t] = fx["used"]
        nsat = len(d["raw_sats"].get(t, ()))
        sig = sorted(d["raw_sig"].get(t, {}).values(), reverse=True)[:4]
        cn0 = round(sum(sig) / len(sig), 1) if sig else None
        a_rows = d["agc_l1"].get(t) or d["agc_l1_inferred"].get(t)
        a_raw = d["raw_agc_l1"].get(t)
        if a_rows:
            agc = round(statistics.median(a_rows), 1)
            agc_src["Agc rows" if d["agc_l1"].get(t) else "Agc rows (clock-inferred time)"] += 1
            if a_raw and round(statistics.median(a_raw), 1) != agc:
                agc_disagree += 1
        elif a_raw:
            agc = round(statistics.median(a_raw), 1)
            agc_src["Raw AgcDb fallback"] += 1
        else:
            agc = None
        yaw = None
        if t in yaw_un:
            yaw = round(yaw_un[t], 1)
            if yaw == 0:
                yaw = 0.0  # avoid "-0.0"
        epochs.append([t, lat, lon, acc, spd, brg, nsat, cn0, agc, yaw])
    return start, end, epochs, agc_src, agc_disagree, used_by_sec, yaw_un


def fix_point(e):
    return {"t": e[0], "lat": e[1], "lon": e[2], "spd": e[4], "brg": e[5], "nsat": e[6], "cn0": e[7]}


def find_outages(epochs):
    out = []
    n = len(epochs)
    i = 0
    while i < n:
        if epochs[i][1] is not None:
            i += 1
            continue
        j = i
        while j + 1 < n and epochs[j + 1][1] is None:
            j += 1
        dur = j - i + 1
        if dur >= MIN_OUTAGE_S:
            before = epochs[i - 1] if i > 0 else None
            after = epochs[j + 1] if j + 1 < n else None
            seg = epochs[i:j + 1]
            ns = [e[6] for e in seg]
            cs = [e[7] for e in seg if e[7] is not None]
            o = {
                "start": epochs[i][0],
                "end": epochs[j][0],
                "dur": dur,
                "before": fix_point(before) if before else None,
                "after": fix_point(after) if after else None,
                "distM": None,
                "gapS": None,
                "avgSpd": None,
                "nsat": {"min": min(ns), "max": max(ns), "mean": round(sum(ns) / len(ns), 1),
                         "zeroS": sum(1 for x in ns if x == 0)},
                "cn0": {"min": min(cs) if cs else None, "max": max(cs) if cs else None,
                        "mean": round(sum(cs) / len(cs), 1) if cs else None,
                        "nullS": sum(1 for e in seg if e[7] is None)},
            }
            if before is None:
                o["edge"] = "start"
            if after is None:
                o["edge"] = "end"
            if before and after:
                dist = haversine_m(before[1], before[2], after[1], after[2])
                gap = after[0] - before[0]
                o["distM"] = round(dist, 1)
                o["gapS"] = gap
                o["avgSpd"] = round(dist / gap, 1)
            out.append(o)
        i = j + 1
    return out


def odd_events(epochs, used_by_sec):
    """Diagnostics only (printed, not written to JSON)."""
    jumps = []
    prev = None
    for e in epochs:
        if e[1] is None:
            continue
        if prev is not None and e[0] - prev[0] <= 3:
            dt = e[0] - prev[0]
            dist = haversine_m(prev[1], prev[2], e[1], e[2])
            v = dist / dt
            rep = max(prev[4] or 0.0, e[4] or 0.0)
            jumps.append((v - rep, v, rep, dist, dt, prev[0], e[0], prev[3], e[3]))
        prev = e
    jumps.sort(reverse=True)

    drops = []
    hist = []
    for e in epochs:
        if e[1] is None:
            continue
        if e[7] is not None and len(hist) >= 5:
            base = statistics.median(hist[-10:])
            if base - e[7] >= 8:
                drops.append((e[0], base, e[7], e[6]))
        if e[7] is None or e[6] < 4:
            drops.append((e[0], None, e[7], e[6]))
        if e[7] is not None:
            hist.append(e[7])
    return jumps, drops


def circ_mean_deg(vals):
    s = sum(math.sin(math.radians(v)) for v in vals)
    c = sum(math.cos(math.radians(v)) for v in vals)
    return math.degrees(math.atan2(s, c))


def dead_reckon(lat, lon, spd, brg0, t_last, t_after, yaw=None):
    """One step per second from t_last to t_after at constant speed.
    yaw=None -> constant bearing; else bearing(t) = brg0 + (yaw(t) - yaw(t_last)),
    with yaw(t) the mean over [t, t+1) (held if a second is missing)."""
    y0 = None if yaw is None else yaw.get(t_last)
    yl = y0
    for t in range(t_last, t_after):
        h = brg0
        if yaw is not None:
            yl = yaw.get(t, yl)
            h = brg0 + (yl - y0)
        lat, lon = destination(lat, lon, h, spd)
    return lat, lon


def yaw_report(d, epochs, yaw_un):
    """Diagnostics: validate yaw against GPS bearing, and DR across outages."""
    fixes = {t: f[1] for t, f in d["gps_fix"].items()}
    cover = sum(1 for e in epochs if e[9] is not None)
    print(f"-- yaw: {cover}/{len(epochs)} seconds have GameRotationVector rows "
          f"(rows with w missing: {d['grv_w_missing']})")

    def moving(t):
        fx = fixes.get(t)
        return fx is not None and fx["brg"] is not None and fx["spd"] is not None and fx["spd"] > 5.0

    rows = []
    for t in sorted(fixes):
        if t in yaw_un and t + 10 in yaw_un and all(moving(s) for s in range(t, t + 11)):
            db = wrap180(fixes[t + 10]["brg"] - fixes[t]["brg"])
            dy = wrap180(yaw_un[t + 10] - yaw_un[t])
            rows.append((t, db, dy))
    if rows:
        ad = [abs(wrap180(db - dy)) for _, db, dy in rows]
        adf = [abs(wrap180(db + dy)) for _, db, dy in rows]
        turning = [(db, dy) for _, db, dy in rows if abs(db) >= 5]
        agree = sum(1 for db, dy in turning if (db > 0) == (dy > 0))
        sxy = sum(db * dy for _, db, dy in rows)
        sxx = sum(db * db for _, db, dy in rows)
        print(f"-- 10 s windows (fix + spd>5 throughout): n={len(rows)}; median |dBrg-dYaw| {statistics.median(ad):.2f} deg "
              f"(p90 {sorted(ad)[int(0.9 * len(ad))]:.2f}); if yaw flipped: median {statistics.median(adf):.2f}")
        print(f"   turning windows |dBrg|>=5: {len(turning)}, same sign {agree}; slope dYaw/dBrg {sxy / sxx if sxx else float('nan'):.3f}; "
              f"max |dBrg| {max(abs(db) for _, db, _ in rows):.1f}")
    # drift: offset brg - yaw over time (circular mean per block)
    offs = [(t, wrap180(fixes[t]["brg"] - yaw_un[t])) for t in sorted(fixes) if moving(t) and t in yaw_un]
    if offs:
        t0 = offs[0][0]
        blocks = defaultdict(list)
        for t, o in offs:
            blocks[(t - t0) // 120].append((t, o))
        print("-- offset (GPS bearing - yaw), circular mean per 120 s block of moving fixes:")
        for k in sorted(blocks):
            v = blocks[k]
            print(f"   {iso(v[0][0])[11:19]}..{iso(v[-1][0])[11:19]}  n={len(v):3d}  offset {circ_mean_deg([o for _, o in v]):7.1f}")
    # DR across outages with fixes on both sides
    jidx = {e[0]: e for e in epochs}
    for o in find_outages(epochs):
        if not o["before"] or not o["after"]:
            continue
        tl, ta = o["before"]["t"], o["after"]["t"]
        fl, fa = fixes[tl], fixes[ta]
        dbrg = wrap180(fa["brg"] - fl["brg"]) if fa["brg"] is not None and fl["brg"] is not None else None
        dyaw = (yaw_un[ta] - yaw_un[tl]) if ta in yaw_un and tl in yaw_un else None
        print(f"-- outage {iso(o['start'])[11:19]}..{iso(o['end'])[11:19]} ({o['dur']} s, {ta - tl} steps): "
              f"last fix spd {fl['spd']:.2f} brg {fl['brg']:.1f}; GPS bearing change {dbrg:.1f}, yaw change {dyaw:.1f}"
              if dbrg is not None and dyaw is not None else f"-- outage {o['start']}: missing brg/yaw")
        for label, use_yaw in (("const bearing", False), ("bearing+yaw", True)):
            for src, (lat0, lon0, v, b0, yw) in (
                ("precise", (fl["lat"], fl["lon"], fl["spd"], fl["brg"], yaw_un)),
                ("json", (jidx[tl][1], jidx[tl][2], jidx[tl][4], jidx[tl][5],
                          {e[0]: e[9] for e in epochs if e[9] is not None})),
            ):
                lat, lon = dead_reckon(lat0, lon0, v, b0, tl, ta, yw if use_yaw else None)
                err = haversine_m(fa["lat"], fa["lon"], lat, lon)
                rel = math.radians(initial_bearing(fa["lat"], fa["lon"], lat, lon) - fa["brg"])
                print(f"   {label:13s} [{src:7s}] end error {err:7.1f} m  (along {err * math.cos(rel):7.1f}, cross {err * math.sin(rel):7.1f}); "
                      f"DR path {v * (ta - tl):.0f} m, chord {o['distM']} m")


def group_runs(secs):
    runs = []
    for s in sorted(secs):
        if runs and s - runs[-1][1] <= 1:
            runs[-1][1] = s
        else:
            runs.append([s, s])
    return runs


def main():
    args = sys.argv[1:]
    flip = "--flip-yaw" in args
    args = [a for a in args if a != "--flip-yaw"]
    if len(args) != 3:
        print(__doc__)
        return 2
    src, dst, name = args
    d = parse(src)
    start, end, epochs, agc_src, agc_disagree, used_by_sec, yaw_un = build(d, -1.0 if flip else 1.0)
    outages = find_outages(epochs)

    doc = {"name": name, "start": start, "cols": COLS, "epochs": epochs, "outages": outages}
    text = json.dumps(doc, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    with open(dst, "w", encoding="ascii", newline="\n") as fh:
        fh.write(text)

    # ---------------- diagnostics ----------------
    print(f"==== {name}  ({src})")
    print("Row counts:", dict(d["counts"].most_common()))
    print(f"Span: {iso(start)} .. {iso(end)}  -> {len(epochs)} epochs ({end - start} s)")
    nfix = sum(1 for e in epochs if e[1] is not None)
    print(f"GPS fixes used: {nfix} (duplicate GPS fixes within a second: {d['gps_dupes']})")
    print("Other providers:", {p: (c, iso(d['other_fix_span'][p][0] / 1000), iso(d['other_fix_span'][p][1] / 1000))
                               for p, c in d["other_fix"].items()})
    rr, rf = d["raw_epochs_round"], d["raw_epochs_floor"]
    print(f"Raw epochs: {sum(len(v) for v in rr.values())}; seconds with >1 epoch: round={sum(1 for v in rr.values() if len(v) > 1)} "
          f"floor={sum(1 for v in rf.values() if len(v) > 1)}")
    # seconds inside Raw coverage with no Raw epoch, round vs floor
    def holes(m):
        if not m:
            return 0
        lo, hi = min(m), max(m)
        return sum(1 for s in range(lo, hi + 1) if s not in m)
    print(f"Seconds without a Raw epoch inside Raw coverage: round={holes(rr)} floor={holes(rf)}")
    fix_secs = set(d["gps_fix"])
    print(f"GPS-fix seconds with Raw data: round={len(fix_secs & set(rr))}/{len(fix_secs)} floor={len(fix_secs & set(rf))}/{len(fix_secs)}")
    cc = d["clock_check"]
    if cc:
        print(f"Raw utcTimeMillis vs TimeNanos-(FullBias+Bias) -> UTC: diff ms min {min(cc):.3f} max {max(cc):.3f}")
    print(f"Agc rows without time: {d['agc_timeless_total']} (GPS L1 resolved via HW clock: {d['agc_resolved']}, unresolved: {d['agc_unresolved']})")
    print("AGC source per second:", dict(agc_src), f"| Agc-vs-Raw median disagreements: {agc_disagree}")
    agcs = [e[8] for e in epochs if e[8] is not None]
    if agcs:
        print(f"AGC values: {len(agcs)} s, range {min(agcs)}..{max(agcs)}, distinct {sorted(set(agcs))}")
    ns = [e[6] for e in epochs]
    cn = [e[7] for e in epochs if e[7] is not None]
    print(f"nsat range {min(ns)}..{max(ns)}; cn0 range {min(cn) if cn else None}..{max(cn) if cn else None}")
    print(f"Outages (>= {MIN_OUTAGE_S} s): {len(outages)}")
    for o in outages:
        print("  ", json.dumps(o, separators=(",", ":")))
        print(f"     {iso(o['start'])} .. {iso(o['end'])}")
    # all no-fix runs (any length) for context
    runs = group_runs([e[0] for e in epochs if e[1] is None])
    print("All no-fix runs (start, len):", [(iso(a)[11:19], b - a + 1) for a, b in runs])
    jumps, drops = odd_events(epochs, used_by_sec)
    print("Top position-jump candidates (excess m/s, implied v, reported v, dist m, dt, t0, t1, acc0, acc1):")
    for j in jumps[:8]:
        print(f"   +{j[0]:.1f}  v={j[1]:.1f}  rep={j[2]:.1f}  d={j[3]:.1f}  dt={j[4]}  {iso(j[5])[11:19]}->{iso(j[6])[11:19]}  acc {j[7]}->{j[8]}")
    print("C/N0 drop / weak-signal-with-fix candidates (t, base, cn0, nsat, usedSignals):")
    for t, base, c, nsat in drops[:60]:
        print(f"   {iso(t)[11:19]} base={base if base is None else round(base, 1)} cn0={c} nsat={nsat} used={used_by_sec.get(t)}")
    print(f"   ... total candidates: {len(drops)}")
    print(f"Yaw sign: {'FLIPPED (-azimuth)' if flip else 'as computed (+azimuth)'}")
    yaw_report(d, epochs, yaw_un)
    print("First 3 epochs:", json.dumps(epochs[:3], separators=(",", ":")))
    print(f"Wrote {dst}: {len(text.encode('ascii'))} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
