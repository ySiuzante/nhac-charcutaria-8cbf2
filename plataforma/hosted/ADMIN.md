# Painel de administração Nhac!

O painel publicado usa o mesmo login por e-mail e senha da loja. O servidor exige e-mail confirmado e verifica o nível de acesso da conta em cada operação administrativa. As abas incluem visão geral, pedidos, catálogo, atacado, clientes, remarketing, Minha conta e Acessos.

Os indicadores de pedidos usam a data de registro e excluem pedidos cancelados. Recebimentos e meios de pagamento usam a data da confirmação manual. A loja registra a preferência do cliente e gera pedidos de teste sem cobrança. Confirme recebimentos no painel somente após identificá-los fora da plataforma. O painel não integra um gateway, estornos ou conciliação bancária.

Cada variedade é um produto no catálogo. O corte é guardado na linha do carrinho e no histórico. O estoque continua compartilhado entre os cortes do mesmo produto.

## Implantação

Após o esquema original, aplique as migrações em ordem: `20261125_admin_dashboard.sql`, `20261125_staff_accounts.sql` e `20261125_staff_password_sign_in.sql`. O site publicado pelo Netlify usa a pasta de funções padrão `netlify/functions`.

## Habilitar envio de ofertas

Configure estas variáveis para as funções no Netlify e execute um novo deploy.

| Variável | Valor |
|---|---|
| `NHAC_SUPABASE_PUBLISHABLE_KEY` | Chave publicável do projeto Supabase |
| `RESEND_API_KEY` | Chave de envio do Resend |
| `NHAC_MARKETING_FROM` | Remetente de domínio verificado no Resend |

O envio é individual. A aba exibe até 200 contatos com consentimento ativo e e-mail verificado. Cada mensagem contém link de descadastro. O cliente também pode revogar a autorização na aba Preferências. Se trocar o domínio público ou o projeto Supabase, atualize os endereços das funções juntamente com a configuração pública da plataforma.
