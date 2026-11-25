import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '../..');
const output = resolve(workspace, 'dist-netlify');
const platform = resolve(output, 'plataforma');
const publicDir = resolve(workspace, 'plataforma/public');
await mkdir(platform, { recursive: true });
for (const file of ['app.js', 'estilo.css', 'assets']) {
  await cp(resolve(workspace, file), resolve(output, file), { recursive: true });
}
for (const file of ['client.js', 'shop.js', 'styles.css', 'dashboard.js', 'dashboard.css', 'staff.js']) {
  await cp(resolve(publicDir, file), resolve(platform, file));
}
for (const file of ['config.js', 'supabase-client.js']) {
  await cp(resolve(import.meta.dirname, file), resolve(platform, file));
}
const portal = (await readFile(resolve(publicDir, 'index.html'), 'utf8'))
  .replace('href="/styles.css"', 'href="/plataforma/styles.css"')
  .replace('  <script src="/client.js" defer></script>', [
    '  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.89.0/dist/umd/supabase.js" defer></script>',
    '  <script src="/plataforma/config.js" defer></script>',
    '  <script src="/plataforma/supabase-client.js" defer></script>',
    '  <script src="/plataforma/client.js" defer></script>',
  ].join('\n'))
  .replace('src="/shop.js"', 'src="/plataforma/shop.js"')
  .replace('src="/dashboard.js"', 'src="/plataforma/dashboard.js"')
  .replace('src="/staff.js"', 'src="/plataforma/staff.js"')
  .replace('href="/dashboard.css"', 'href="/plataforma/dashboard.css"')
  .replace('href="https://ysiuzante.github.io/nhac-charcutaria/"', 'href="/"')
  .replace('Os acessos são disponibilizados pela equipe responsável pela Nhac!.', 'Use o mesmo acesso para a loja e o painel administrativo.');
await writeFile(resolve(platform, 'index.html'), portal);

const html = await readFile(resolve(workspace, 'index.html'), 'utf8');
const navigationEnd = '</nav>';
if (!html.includes(navigationEnd)) throw new Error('Menu institucional não encontrado.');
await writeFile(resolve(output, 'index.html'), html.replace(navigationEnd,
  '<a class="nav-biz nav-account" href="/plataforma/">Minha conta <span aria-hidden="true">↗</span></a>' + navigationEnd));
