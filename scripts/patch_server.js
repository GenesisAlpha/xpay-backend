const fs = require('fs');
const path = 'src/server.ts';
let code = fs.readFileSync(path, 'utf8');

if (!code.includes('startCronJobs')) {
  code = "import { startCronJobs } from './cron';\n" + code;
  code = code.replace(/app\.listen\(/, "startCronJobs();\n  app.listen(");
  fs.writeFileSync(path, code);
  console.log('✅ Cron injetado no server.ts!');
}
