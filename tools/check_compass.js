// Feed fake phone orientation events into js/sensors.js and check the compass-vs-gyroscope check
// Usage: node tools/check_compass.js .
const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = process.argv[2] || '.';

function run(label, compassExtra, opts = {}) {
  let now = 0;
  const handlers = {};
  const ctx = { console, Math, Date, Array, Object, JSON, isNaN, performance: { now: () => now } };
  ctx.window = ctx;
  ctx.addEventListener = (type, fn) => { handlers[type] = fn; };
  ctx.DeviceOrientationEvent = function () {};
  vm.createContext(ctx);
  for (const f of ['geo.js', 'sensors.js']) vm.runInContext(fs.readFileSync(path.join(dir, 'js', f), 'utf8'), ctx);
  if (opts.android) ctx.ondeviceorientationabsolute = null;
  const S = ctx.Alibi.sensors;
  S.start();
  // 12 s at 60 Hz: the user sweeps the phone left and right while holding it upright (beta 90 = camera level)
  for (let i = 0; i < 720; i++) {
    now = i * 1000 / 60;
    const turn = 40 * Math.sin(now / 1500);          // real heading change, degrees
    const gyro = 200 + turn;                          // gyroscope: own zero, follows the turn exactly
    const compass = 120 + turn + compassExtra(now);   // compass: true heading plus any magnetic error
    if (opts.android) {
      handlers.deviceorientationabsolute({ alpha: (360 - compass) % 360, beta: 90, gamma: 0 });
      handlers.deviceorientation({ alpha: (360 - gyro) % 360, beta: 90, gamma: 0, absolute: false });
    } else {
      handlers.deviceorientation({ alpha: (360 - gyro) % 360, beta: 90, gamma: 0, webkitCompassHeading: (compass + 360) % 360, webkitCompassAccuracy: opts.acc ?? 10 });
    }
  }
  const c = S.compassCheck(10000);
  console.log(`${label.padEnd(44)} drift ${c.drift == null ? '-' : c.drift.toFixed(1)}°  accuracy ${c.accuracy}`);
  return c;
}

const ok = [];
ok.push(run('Android, clean compass', () => 0, { android: true }).drift < 2);
ok.push(run('Android, compass pulled 15° by metal', (t) => Math.min(15, t / 400), { android: true }).drift > 5);
ok.push(run('Android, compass jitter ±2°', (t) => 2 * Math.sin(t / 37), { android: true }).drift < 5);
ok.push(run('iPhone, clean compass', () => 0).drift < 2);
ok.push(run('iPhone, compass swings 20° near a car', (t) => 20 * Math.sin(t / 2000)).drift > 5);
ok.push(run('iPhone, uncalibrated', () => 0, { acc: -1 }).accuracy === -1);
console.log(ok.every(Boolean) ? 'all compass checks passed' : 'SOME COMPASS CHECKS FAILED');
process.exitCode = ok.every(Boolean) ? 0 : 1;
