// Lightweight structured JSON logger — no external dependencies.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] || LEVELS.info;

function createLogger(component) {
  function emit(level, msg, extra) {
    if (LEVELS[level] < currentLevel) return;
    const entry = { level, msg, component, time: new Date().toISOString(), ...extra };
    const out = level === 'error' ? process.stderr : process.stdout;
    out.write(JSON.stringify(entry) + '\n');
  }
  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info:  (msg, extra) => emit('info',  msg, extra),
    warn:  (msg, extra) => emit('warn',  msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}

module.exports = createLogger;
