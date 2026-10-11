// Locate a Chromium for headless tests. Order: $CHROME, /usr/bin/chromium, a shared Playwright build in the workspace.
const fs = require('fs');
const alt = '/workspace/work/ascent-pro/.tools/pw';
const cands = [process.env.CHROME, '/usr/bin/chromium', '/usr/bin/chromium-browser', alt + '/browsers/chromium-1140/chrome-linux/chrome'].filter(Boolean);
const exe = cands.find((p) => fs.existsSync(p));
if (exe && exe.startsWith(alt)) process.env.LD_LIBRARY_PATH = [alt + '/libs/usr/lib/aarch64-linux-gnu', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
module.exports = exe;
