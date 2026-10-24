"""How good is the phone compass for heading and turns, compared with the gyroscope?

Usage: python -I compass_test.py <gnss_log.txt> <expected |B| uT> <expected dip deg> [out.json]

Truth = GPS bearing while moving (> 5 m/s). Sources compared, all per-second circular means:
  gyro    GameRotationVector azimuth (gyro + accel, no magnetometer; zero is arbitrary)
  compass OrientationDeg yaw (Android's own compass heading)
  rawmag  tilt-compensated heading from UncalMag - bias and UncalAccel - bias (no gyro smoothing)
  fop     FOP headingDegrees (Google fused orientation, with its own error estimate)
The phone may sit at any angle to the vehicle, so a constant offset per source is removed (circular median).
"""
import json
import math
import re
import sys
from collections import defaultdict

import numpy as np

HEADER_RE = re.compile(r"^#\s*([A-Za-z][A-Za-z0-9_]*),(.*)$")
path, B_EXP, DIP_EXP = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
out_path = sys.argv[4] if len(sys.argv) > 4 else None


def wrap(a):
    return (np.asarray(a, dtype=float) + 180.0) % 360.0 - 180.0


def f(s):
    try:
        v = float(s)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


hdr = {}
fix = {}
acc_sc = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0]))   # src -> sec -> [sin, cos, n]
vec = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0, 0.0, 0]))  # 'mag'/'acc' -> sec -> [x, y, z, n]
bmag = defaultdict(list)
fop_err = defaultdict(list)


def add_angle(src, sec, deg):
    a = acc_sc[src][sec]
    r = math.radians(deg)
    a[0] += math.sin(r)
    a[1] += math.cos(r)
    a[2] += 1


with open(path, encoding='utf-8', errors='replace') as fh:
    for line in fh:
        line = line.rstrip('\r\n')
        if not line:
            continue
        if line[0] == '#':
            m = HEADER_RE.match(line)
            if m:
                hdr[m.group(1)] = {c.strip(): i + 1 for i, c in enumerate(m.group(2).split(','))}
            continue
        p = line.split(',')
        h = hdr.get(p[0])
        if not h:
            continue

        def g(c, _h=h, _p=p):
            i = _h.get(c)
            return _p[i] if i is not None and i < len(_p) else None

        t = p[0]
        if t == 'Fix':
            if (g('Provider') or '').strip().lower() != 'gps':
                continue
            ms = f(g('UnixTimeMillis'))
            if ms is None:
                continue
            fix[int(ms // 1000)] = dict(lat=f(g('LatitudeDegrees')), lon=f(g('LongitudeDegrees')), spd=f(g('SpeedMps')),
                                        brg=f(g('BearingDegrees')), bacc=f(g('BearingAccuracyDegrees')))
            continue
        ms = f(g('utcTimeMillis'))
        if ms is None:
            continue
        sec = int(ms // 1000)
        if t == 'GameRotationVector':
            x, y, z, w = (f(g(c)) for c in ('x', 'y', 'z', 'w'))
            if None in (x, y, z):
                continue
            if w is None:
                w = math.sqrt(max(0.0, 1 - x * x - y * y - z * z))
            add_angle('gyro', sec, math.degrees(math.atan2(2 * x * y - 2 * z * w, 1 - 2 * x * x - 2 * z * z)))
        elif t == 'OrientationDeg':
            v = f(g('yawDeg'))
            if v is not None:
                add_angle('compass', sec, v)
        elif t == 'FOP':
            v, e, ce = f(g('headingDegrees')), f(g('headingErrorDegrees')), f(g('conservativeHeadingErrorDegrees'))
            if v is not None:
                add_angle('fop', sec, v)
                fop_err[sec].append((e, ce))
        elif t in ('UncalMag', 'UncalAccel'):
            unit = 'MicroT' if t == 'UncalMag' else 'Mps2'
            xyz = [f(g(f'{t}{a}{unit}')) for a in 'XYZ']
            bias = [f(g(f'Bias{a}{unit}')) or 0.0 for a in 'XYZ']
            if None in xyz:
                continue
            v3 = [xyz[i] - bias[i] for i in range(3)]
            k = 'mag' if t == 'UncalMag' else 'acc'
            a = vec[k][sec]
            a[0] += v3[0]
            a[1] += v3[1]
            a[2] += v3[2]
            a[3] += 1
            if k == 'mag':
                bmag[sec].append(math.sqrt(sum(c * c for c in v3)))


def circ(src):
    return {s: math.degrees(math.atan2(v[0], v[1])) for s, v in acc_sc[src].items() if v[2]}


gyro, compass, fop = circ('gyro'), circ('compass'), circ('fop')
rawmag, B, dip = {}, {}, {}
for s, m in vec['mag'].items():
    a = vec['acc'].get(s)
    if not a or not m[3] or not a[3]:
        continue
    E = np.array(m[:3]) / m[3]
    A = np.array(a[:3]) / a[3]
    H = np.cross(E, A)
    if np.linalg.norm(H) < 1e-6:
        continue
    H /= np.linalg.norm(H)
    An = A / np.linalg.norm(A)
    M = np.cross(An, H)
    rawmag[s] = math.degrees(math.atan2(H[1], M[1]))
    B[s] = float(np.median(bmag[s]))
    dip[s] = math.degrees(math.asin(max(-1.0, min(1.0, -float(np.dot(E, An)) / float(np.linalg.norm(E))))))

secs = sorted(set(gyro) | set(fix))
t0, t1 = secs[0], secs[-1]
moving = {s for s, fx in fix.items()
          if fx['spd'] and fx['spd'] > 5 and fx['brg'] is not None and (fx['bacc'] is None or fx['bacc'] < 5)}
res = {'file': path.replace('\\', '/').split('/')[-1], 'durationS': t1 - t0, 'gpsSeconds': len(fix),
       'movingSeconds': len(moving)}


def circ_median(vals):
    vals = np.asarray(vals, dtype=float)
    cands = np.arange(-180, 180, 0.5)
    cost = [np.abs(wrap(vals - c)).sum() for c in cands]
    return float(cands[int(np.argmin(cost))])


def stats(e):
    e = np.abs(np.asarray(e, dtype=float))
    if not e.size:
        return None
    return dict(n=int(e.size), median=round(float(np.median(e)), 1), p95=round(float(np.percentile(e, 95)), 1),
                over20=round(float((e > 20).mean() * 100), 1))


# 1) absolute heading after removing one constant offset (mounting angle + declination)
absr = {}
for name, src in (('compass', compass), ('rawmag', rawmag), ('fop', fop)):
    ss = sorted(s for s in moving if s in src)
    if not ss:
        continue
    d = wrap([src[s] - fix[s]['brg'] for s in ss])
    off = circ_median(d)
    r = wrap(d - off)
    absr[name] = dict(offset=off, **stats(r))
    absr[name]['_resid'] = {s: float(v) for s, v in zip(ss, r)}
res['absoluteHeading'] = {k: {kk: vv for kk, vv in v.items() if kk != '_resid'} for k, v in absr.items()}

# offset per 120 s block: a jump in the gyro offset means the phone was turned in the hand
for name, src in (('gyro', gyro), ('compass', compass), ('rawmag', rawmag), ('fop', fop)):
    blocks = defaultdict(list)
    for s in sorted(moving):
        if s in src:
            blocks[(s - t0) // 120].append(float(wrap(fix[s]['brg'] - src[s])))
    res[f'{name}OffsetPer120s'] = [round(circ_median(v), 1) for _, v in sorted(blocks.items()) if len(v) >= 20]


# 2) turn detection: heading change over W seconds vs GPS bearing change
def unwrap_series(src):
    out, prev, acc = {}, None, 0.0
    for s in sorted(src):
        acc = src[s] if prev is None else acc + float(wrap(src[s] - src[prev]))
        out[s] = acc
        prev = s
    return out


uw = {k: unwrap_series(v) for k, v in (('gyro', gyro), ('compass', compass), ('rawmag', rawmag), ('fop', fop)) if v}
turns = {}
for W in (10, 30, 60):
    rows = [s for s in sorted(moving) if all(x in moving for x in range(s, s + W + 1))]
    tw = {}
    for name, u in uw.items():
        errs, big = [], []
        for s in rows:
            if s in u and s + W in u:
                db = float(wrap(fix[s + W]['brg'] - fix[s]['brg']))
                e = (u[s + W] - u[s]) - db
                errs.append(e)
                if abs(db) >= 15:
                    big.append(e)
        tw[name] = dict(all=stats(errs), realTurnsOver15deg=stats(big))
    turns[f'{W}s'] = dict(windows=len(rows), **tw)
res['turnDetection'] = turns

# 3) across GPS outages > 5 s: heading change from each source minus the GPS heading change
outs = []
fs = sorted(fix)
for a, b in zip(fs, fs[1:]):
    if b - a > 5 and a in moving and b in moving:
        db = float(wrap(fix[b]['brg'] - fix[a]['brg']))
        row = dict(start=a, gapS=b - a, gpsTurn=round(db, 1))
        for name, u in uw.items():
            if a in u and b in u:
                row[name + 'Err'] = round((u[b] - u[a]) - db, 1)
        outs.append(row)
res['outages'] = outs

# 4) magnetic field: is it the Earth's field? (expected values given on the command line)
Bv = np.array([B[s] for s in sorted(B)])
Dv = np.array([dip[s] for s in sorted(dip)])
res['field'] = dict(expectedUT=B_EXP, expectedDip=DIP_EXP, medianUT=round(float(np.median(Bv)), 1),
                    p5UT=round(float(np.percentile(Bv, 5)), 1), p95UT=round(float(np.percentile(Bv, 95)), 1),
                    medianDip=round(float(np.median(Dv)), 1), p5Dip=round(float(np.percentile(Dv, 5)), 1),
                    p95Dip=round(float(np.percentile(Dv, 95)), 1),
                    pctOff10pct=round(float((np.abs(Bv / B_EXP - 1) > 0.10).mean() * 100), 1),
                    pctDipOff5=round(float((np.abs(Dv - DIP_EXP) > 5).mean() * 100), 1))


# 5) does a field check (|B| within 10 %, dip within 5 deg) pick out the good compass seconds?
def clean(s):
    return s in B and abs(B[s] / B_EXP - 1) <= 0.10 and abs(dip[s] - DIP_EXP) <= 5


res['fieldCheck'] = {}
for name in ('compass', 'rawmag'):
    r = absr.get(name, {}).get('_resid', {})
    res['fieldCheck'][name] = dict(clean=stats([v for s, v in r.items() if clean(s)]),
                                   disturbed=stats([v for s, v in r.items() if not clean(s)]))

# 6) gyro-vs-compass check (what a browser can do: it has no raw magnetometer)
#    over the last 10 s, did the compass turn by the same amount as the gyro?
gc = {}
for name in ('compass', 'rawmag'):
    r = absr.get(name, {}).get('_resid', {})
    u = uw.get(name, {})
    ok, bad = [], []
    for s, v in r.items():
        if s - 10 in u and s in u and s - 10 in uw['gyro'] and s in uw['gyro']:
            mism = abs((u[s] - u[s - 10]) - (uw['gyro'][s] - uw['gyro'][s - 10]))
            (ok if mism <= 5 else bad).append(v)
    gc[name] = dict(agree=stats(ok), disagree=stats(bad))
res['gyroCompassCheck'] = gc

# 7) is the phone's own compass accuracy honest? (FOP error estimates vs real error)
r = absr.get('fop', {}).get('_resid', {})
if r:
    def mean_of(s, k):
        v = [x[k] for x in fop_err[s] if x[k] is not None]
        return float(np.mean(v)) if v else float('nan')
    claimed = np.array([mean_of(s, 0) for s in r])
    cons = np.array([mean_of(s, 1) for s in r])
    err = np.abs(np.array(list(r.values())))
    res['fopHonesty'] = dict(medianClaimedDeg=round(float(np.nanmedian(claimed)), 1),
                             medianConservativeDeg=round(float(np.nanmedian(cons)), 1),
                             pctInsideClaimed=round(100 * float(np.mean(err <= claimed)), 1),
                             pctInsideConservative=round(100 * float(np.mean(err <= cons)), 1))

print(json.dumps(res, indent=1))
if out_path:
    with open(out_path, 'w') as fh:
        json.dump(res, fh, indent=1)
