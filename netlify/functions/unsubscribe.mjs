const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const headers = {
  'Content-Type':'text/html; charset=utf-8',
  'Cache-Control':'no-store',
  'Content-Security-Policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy':'no-referrer',
  'X-Robots-Tag':'noindex'
};
const page = (body, status = 200) => new Response(
  '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preferências de e-mail | Nhac!</title>' +
  '<main><h1>Preferências de e-mail da Nhac!</h1>' + body + '</main></html>',
  {status, headers}
);

export default async function unsubscribe(request) {
  const code = new URL(request.url).searchParams.get('code');
  if (!code || !uuid.test(code)) return page('<p>O link de descadastro é inválido.</p>', 400);
  if (request.method === 'GET') return page(
    '<form method="post" action="?code=' + code + '"><p>Confirme se quer parar de receber ofertas por e-mail.</p><button>Parar de receber ofertas</button></form>'
  );
  if (request.method !== 'POST') return page('<p>Método indisponível.</p>', 405);
  try {
    const response = await fetch('https://gdhxxdjuvsvygtrdaaxu.supabase.co/rest/v1/rpc/nhac_unsubscribe', {
      method:'POST',
      headers:{apikey:process.env.NHAC_SUPABASE_PUBLISHABLE_KEY || '', 'Content-Type':'application/json'},
      body:JSON.stringify({code}),
      signal:AbortSignal.timeout(5000)
    });
    if (!response.ok) return page('<p>O descadastro está indisponível. Tente novamente em alguns instantes.</p>', 503);
    return page('<p>Você não receberá novas ofertas neste endereço.</p>');
  } catch {
    return page('<p>O descadastro está indisponível. Tente novamente em alguns instantes.</p>', 503);
  }
}
