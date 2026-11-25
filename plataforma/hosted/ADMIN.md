# Painel de administração Nhac!

O painel usa a mesma autenticação da loja. A conta precisa estar na lista administrativa e completar o segundo fator. As abas incluem visão geral, pedidos, catálogo, atacado, clientes e remarketing.

Os indicadores de pedidos usam a data de registro e excluem pedidos cancelados. Recebimentos e meios de pagamento usam a data da confirmação manual. A loja registra a preferência do cliente e gera pedidos de teste sem cobrança. Confirme recebimentos no painel somente após identificá-los fora da plataforma. O painel não integra um gateway, estornos ou conciliação bancária.

Cada variedade é um produto no catálogo. O corte é guardado na linha do carrinho e no histórico. O estoque continua compartilhado entre os cortes do mesmo produto.

## Implantação

Aplique `migrations/20261125_admin_dashboard.sql` uma única vez no banco Supabase após o esquema original. O site publicado pelo Netlify usa a pasta de funções padrão `netlify/functions`.

## Habilitar envio de ofertas

Configure estas variáveis para as funções no Netlify e execute um novo deploy.

| Variável | Valor |
|---|---|
| `NHAC_SUPABASE_PUBLISHABLE_KEY` | Chave publicável do projeto Supabase |
| `RESEND_API_KEY` | Chave de envio do Resend |
| `NHAC_MARKETING_FROM` | Remetente de domínio verificado no Resend |

O envio é individual. A aba exibe até 200 contatos com consentimento ativo e e-mail verificado. Cada mensagem contém link de descadastro. O cliente também pode revogar a autorização na aba Preferências. Se trocar o domínio público ou o projeto Supabase, atualize os endereços das funções juntamente com a configuração pública da plataforma.
