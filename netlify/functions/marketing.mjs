import { createHash } from 'node:crypto';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const headers = {'Cache-Control': 'no-store', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'no-referrer'};
const reply = (status, json) => Response.json(json, {status, headers});
const authService = 'https://gdhxxdjuvsvygtrdaaxu.supabase.co';

export default async function marketing(request) {
  if (request.method !== 'POST') return reply(405, {error:'Método indisponível.'});
  const auth = request.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) return reply(401, {error:'Entre novamente na sua conta.'});
  const raw = await request.text();
  if (raw.length > 7000) return reply(413, {error:'A mensagem excede o limite permitido.'});
  let data;
  try { data = JSON.parse(raw); } catch { return reply(400, {error:'Revise os dados da mensagem.'}); }
  if (!data || typeof data !== 'object') return reply(400, {error:'Preencha os dados da mensagem.'});
  const {contactId, requestId} = data;
  const subject = typeof data.subject === 'string' ? data.subject.trim() : '';
  const message = typeof data.message === 'string' ? data.message.trim() : '';
  if (![contactId, requestId].every(value => typeof value === 'string' && uuid.test(value)) ||
      !subject || subject.length > 120 || /[\r\n]/.test(subject) || !message || message.length > 4000) {
    return reply(400, {error:'Revise o contato, o assunto e a mensagem.'});
  }
  if (!process.env.NHAC_SUPABASE_PUBLISHABLE_KEY || !process.env.NHAC_MARKETING_FROM || !process.env.RESEND_API_KEY) {
    return reply(503, {error:'Envio indisponível. A loja precisa configurar um remetente verificado no serviço de e-mail.'});
  }
  try {
    const recipientResponse = await fetch(authService + '/rest/v1/rpc/nhac_api', {
      method: 'POST',
      headers: {apikey:process.env.NHAC_SUPABASE_PUBLISHABLE_KEY, Authorization:auth, 'Content-Type':'application/json'},
      body: JSON.stringify({operation:'admin_marketing_recipient', payload:{contactId}}),
      signal: AbortSignal.timeout(4500)
    });
    if (!recipientResponse.ok) return reply(403, {error:'Acesso restrito à administração ou contato sem autorização de envio.'});
    const recipient = await recipientResponse.json();
    if (!recipient.email || !uuid.test(recipient.unsubscribeToken)) return reply(403, {error:'O contato não autorizou o envio.'});
    const unsubscribe = 'https://monumental-sopapillas-07c96f.netlify.app/.netlify/functions/unsubscribe?code=' + recipient.unsubscribeToken;
    const dedupe = createHash('sha256').update(JSON.stringify([requestId, contactId, subject, message])).digest('hex');
    const provider = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {Authorization:'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type':'application/json', 'Idempotency-Key':'nhac/' + dedupe},
      body: JSON.stringify({
        from:process.env.NHAC_MARKETING_FROM, to:[recipient.email], subject,
        text: message + '\n\nPara deixar de receber ofertas da Nhac!, acesse\n' + unsubscribe,
        headers:{'List-Unsubscribe':'<' + unsubscribe + '>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}
      }),
      signal: AbortSignal.timeout(9000)
    });
    if (!provider.ok) return reply(502, {error:'O serviço de e-mail não aceitou a mensagem. Confira a configuração ou tente novamente.'});
    return reply(200, {accepted:true});
  } catch {
    return reply(502, {error:'Não foi possível verificar o envio. Tente novamente com a mesma mensagem.'});
  }
}
