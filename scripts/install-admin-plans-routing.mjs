import fs from 'node:fs';

const path = 'src/index.js';
let source = fs.readFileSync(path, 'utf8');
const importLine = "import { handleAdminPlansRoute } from './admin-plans.js';";
const importAnchor = "import { sendFcm } from './fcm.js';";
const routeCall = 'const adminPlansResponse = await handleAdminPlansRoute(request, env, json);';
const fallback = "      return json({ error: 'Not found', path }, 404);";

if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('Could not find Worker import anchor. No files changed.');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}
if (!source.includes(routeCall)) {
  if (!source.includes(fallback)) throw new Error('Could not find the API 404 fallback. No files changed.');
  source = source.replace(fallback, `      ${routeCall}\n      if (adminPlansResponse) return adminPlansResponse;\n\n${fallback}`);
}
fs.writeFileSync(path, source);
console.log('Installed GET/POST /api/plans routes.');
