import fs from 'node:fs';

const path = 'src/index.js';
let source = fs.readFileSync(path, 'utf8');
const importLine = "import { ensureAdminTables, getRequestAdmin, handleAdminRoute, isAdminProtectedPath } from './admin-auth.js';";
if (!source.includes(importLine)) {
  const importAnchor = "import { sendFcm } from './fcm.js';";
  if (!source.includes(importAnchor)) throw new Error('Could not find Worker import anchor. No files changed.');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

const fetchAnchor = "    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });";
const integration = `    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    if (path.startsWith('/api/admin/') || isAdminProtectedPath(path, request.method)) {
      await ensureAdminTables(env);
    }
    const adminResponse = await handleAdminRoute(request, env);
    if (adminResponse) return adminResponse;
    if (isAdminProtectedPath(path, request.method) && !(await getRequestAdmin(request, env))) {
      return json({ error: 'Unauthorized' }, 401);
    }`;

if (source.includes('const adminResponse = await handleAdminRoute(request, env);')) {
  console.log('Admin auth routing already installed; no changes made.');
  process.exit(0);
}
if (!source.includes(fetchAnchor)) throw new Error('Could not find fetch preflight anchor. No files changed.');
source = source.replace(fetchAnchor, integration);
fs.writeFileSync(path, source);
console.log('Installed admin OTP/session routing and auth checks.');
console.log('Existing global CORS behavior was intentionally preserved to avoid changing retailer/client API CORS.');
