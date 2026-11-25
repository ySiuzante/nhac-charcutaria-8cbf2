ALTER TABLE nhac.products ADD COLUMN cut_options text[] NOT NULL DEFAULT ARRAY['original']
  CHECK (cardinality(cut_options)>0 AND cut_options <@ ARRAY['original','whole','sliced','diced']);
UPDATE nhac.products SET cut_options=CASE
  WHEN id IN ('SALA-ITAL','SALA-PEPP') THEN ARRAY['whole','sliced']
  WHEN id='BACN-FATI' THEN ARRAY['sliced','whole']
  WHEN id='BACN-CUBO' THEN ARRAY['diced']
  ELSE ARRAY['whole'] END
WHERE id IN ('LING-TOSC','LING-COAL','SALA-ITAL','SALA-PEPP','BACN-FATI','BACN-CUBO');

ALTER TABLE nhac.cart ADD COLUMN cut text NOT NULL DEFAULT 'original' CHECK(cut IN ('original','whole','sliced','diced'));
ALTER TABLE nhac.cart DROP CONSTRAINT cart_pkey, ADD PRIMARY KEY(user_id,channel,product_id,cut);
ALTER TABLE nhac.order_items ADD COLUMN cut text NOT NULL DEFAULT 'original' CHECK(cut IN ('original','whole','sliced','diced'));
ALTER TABLE nhac.order_items DROP CONSTRAINT order_items_pkey, ADD PRIMARY KEY(order_id,product_id,cut);
ALTER TABLE nhac.orders
  ADD COLUMN payment_method text NOT NULL DEFAULT 'unspecified' CHECK(payment_method IN ('unspecified','pix','card','cash','transfer')),
  ADD COLUMN payment_status text NOT NULL DEFAULT 'pending' CHECK(payment_status IN ('pending','confirmed')),
  ADD COLUMN paid_at timestamptz,
  ADD CONSTRAINT payment_consistency CHECK((payment_status='confirmed')=(paid_at IS NOT NULL)
    AND (payment_status='pending' OR payment_method<>'unspecified'));
CREATE INDEX nhac_orders_activity_idx ON nhac.orders(created_at) WHERE status<>'cancelled';
CREATE INDEX nhac_orders_receipt_idx ON nhac.orders(paid_at) WHERE status<>'cancelled' AND payment_status='confirmed';

CREATE TABLE nhac.marketing_preferences (
  user_id uuid PRIMARY KEY REFERENCES nhac.profiles(id) ON DELETE CASCADE,
  email text NOT NULL, consent_at timestamptz NOT NULL DEFAULT now(),
  unsubscribe_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
ALTER TABLE nhac.marketing_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nhac.marketing_preferences FROM PUBLIC,anon,authenticated;

CREATE FUNCTION nhac.remove_marketing_subscription(code uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  DELETE FROM nhac.marketing_preferences WHERE unsubscribe_token=code
$$;
CREATE FUNCTION public.nhac_unsubscribe(code uuid) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path = '' AS $$ SELECT nhac.remove_marketing_subscription(code) $$;
REVOKE ALL ON FUNCTION nhac.remove_marketing_subscription(uuid),public.nhac_unsubscribe(uuid) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA nhac TO anon;
GRANT EXECUTE ON FUNCTION nhac.remove_marketing_subscription(uuid),public.nhac_unsubscribe(uuid) TO anon;

DROP FUNCTION nhac.cart_rows(uuid,text);
CREATE FUNCTION nhac.cart_rows(viewer uuid,sales_channel text)
RETURNS TABLE(id text,name text,stock integer,quantity integer,unit_cents integer,minimum integer,cut text)
LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT p.id,p.name,p.stock,c.quantity,
    CASE WHEN sales_channel='wholesale' THEN p.wholesale_cents ELSE p.retail_cents END,
    CASE WHEN sales_channel='wholesale' THEN p.wholesale_minimum ELSE 1 END,c.cut
  FROM nhac.cart c JOIN nhac.products p ON c.product_id=p.id
  WHERE c.user_id=viewer AND c.channel=sales_channel
$$;
REVOKE ALL ON FUNCTION nhac.cart_rows(uuid,text) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION nhac.sales_metrics(days integer) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
  WITH boundaries AS (
    SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS today
  ), span AS (
    SELECT today-greatest(1,least(days,90))+1 AS start_day,today FROM boundaries
  ), placed AS (
    SELECT o.*,(o.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS day
    FROM nhac.orders o CROSS JOIN span s
    WHERE o.status<>'cancelled' AND o.created_at >= (s.start_day::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND o.created_at < ((s.today+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
  ), received AS (
    SELECT o.* FROM nhac.orders o CROSS JOIN span s
    WHERE o.status<>'cancelled' AND o.payment_status='confirmed'
      AND o.paid_at >= (s.start_day::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND o.paid_at < ((s.today+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
  ), totals AS (
    SELECT day,count(*) AS orders,sum(total_cents) AS cents FROM placed GROUP BY day
  )
  SELECT jsonb_build_object(
    'count',(SELECT count(*) FROM placed),
    'total',(SELECT coalesce(sum(total_cents),0) FROM placed),
    'average',(SELECT coalesce(round(avg(total_cents)),0) FROM placed),
    'received',(SELECT coalesce(sum(total_cents),0) FROM received),
    'pending',(SELECT count(*) FROM placed WHERE payment_status='pending'),
    'daily',(SELECT jsonb_agg(jsonb_build_object('day',s.start_day+n,'orders',coalesce(t.orders,0),'cents',coalesce(t.cents,0)) ORDER BY n)
      FROM span s CROSS JOIN LATERAL generate_series(0,s.today-s.start_day) n LEFT JOIN totals t ON t.day=s.start_day+n),
    'channels',(SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb)
      FROM (SELECT channel,count(*) AS count,sum(total_cents) AS cents FROM placed GROUP BY channel ORDER BY sum(total_cents) DESC) c),
    'methods',(SELECT coalesce(jsonb_agg(to_jsonb(m)),'[]'::jsonb)
      FROM (SELECT payment_method AS method,count(*) AS count,sum(total_cents) AS cents FROM received GROUP BY payment_method ORDER BY sum(total_cents) DESC) m)
  )
$$;
REVOKE ALL ON FUNCTION nhac.sales_metrics(integer) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION nhac.dispatch(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  viewer uuid := auth.uid();
  cut_value text := coalesce(payload->>'cut','original');
  payment_value text := coalesce(payload->>'paymentMethod','unspecified');
  account_email text;
  display_name text;
  admin boolean;
  wholesale_access boolean;
  sales_channel text := coalesce(payload->>'channel','retail');
  item_id text := payload->>'productId';
  quantity_value integer;
  retail_value integer;
  wholesale_value integer;
  row_product nhac.products%ROWTYPE;
  order_row nhac.orders%ROWTYPE;
  request_key uuid;
  next_status text := payload->>'status';
  company_name text := trim(payload->>'company');
  total bigint;
  response jsonb;
BEGIN
  SELECT lower(u.email), left(coalesce(nullif(trim(u.raw_user_meta_data->>'name'),''),split_part(u.email,'@',1)),120)
    INTO account_email,display_name
    FROM auth.users u WHERE u.id=viewer AND u.email_confirmed_at IS NOT NULL;
  IF account_email IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Entre com um e-mail confirmado.'; END IF;
  SELECT EXISTS(SELECT 1 FROM nhac.administrators a WHERE a.email=account_email) INTO admin;
  IF operation='profile' THEN
    INSERT INTO nhac.profiles VALUES (viewer,display_name,account_email) ON CONFLICT(id) DO UPDATE
      SET full_name=excluded.full_name,email=excluded.email
      WHERE (profiles.full_name,profiles.email) IS DISTINCT FROM (excluded.full_name,excluded.email);
    RETURN jsonb_build_object('user',jsonb_build_object('id',viewer,'name',display_name,'email',account_email,
      'role',CASE WHEN admin THEN 'MAIN' ELSE 'CUSTOMER' END));
  END IF;
  IF admin AND coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Confirme o código do autenticador.';
  END IF;
  IF operation LIKE 'admin_%' AND NOT admin THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Acesso restrito à administração.';
  END IF;
  IF operation LIKE 'shop_%' AND admin AND operation <> 'shop_products' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Entre como cliente para usar a loja.';
  END IF;
  INSERT INTO nhac.profiles VALUES (viewer,display_name,account_email) ON CONFLICT(id) DO NOTHING;
  SELECT EXISTS(SELECT 1 FROM nhac.wholesale w WHERE w.user_id=viewer AND w.approved) INTO wholesale_access;

  IF operation='shop_marketing' THEN
    IF payload ? 'optIn' THEN
      IF jsonb_typeof(payload->'optIn') <> 'boolean' THEN RAISE EXCEPTION 'Informe sua preferência.'; END IF;
      IF (payload->>'optIn')::boolean THEN
        INSERT INTO nhac.marketing_preferences(user_id,email) VALUES(viewer,account_email)
        ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, unsubscribe_token=gen_random_uuid(), consent_at=now()
        WHERE marketing_preferences.email IS DISTINCT FROM excluded.email;
      ELSE
        DELETE FROM nhac.marketing_preferences WHERE user_id=viewer;
      END IF;
    END IF;
    RETURN jsonb_build_object('optIn',EXISTS(SELECT 1 FROM nhac.marketing_preferences WHERE user_id=viewer AND email=account_email));
  END IF;
  IF operation='admin_marketing' THEN
    RETURN jsonb_build_object('contacts',coalesce((
      SELECT jsonb_agg(jsonb_build_object('id',c.user_id,'email',c.email,'name',c.full_name,'since',c.consent_at)
        ORDER BY c.consent_at DESC)
      FROM (SELECT m.user_id,m.email,p.full_name,m.consent_at
        FROM nhac.marketing_preferences m JOIN auth.users u ON u.id=m.user_id
        JOIN nhac.profiles p ON p.id=m.user_id
        LEFT JOIN nhac.administrators a ON a.email=m.email
        WHERE u.email_confirmed_at IS NOT NULL AND lower(u.email)=m.email AND a.email IS NULL
        ORDER BY m.consent_at DESC,m.user_id LIMIT 200) c
    ),'[]'::jsonb));
  END IF;
  IF operation='admin_marketing_recipient' THEN
    SELECT jsonb_build_object('email',m.email,'unsubscribeToken',m.unsubscribe_token) INTO response
      FROM nhac.marketing_preferences m JOIN auth.users u ON u.id=m.user_id
      LEFT JOIN nhac.administrators a ON a.email=m.email
      WHERE m.user_id=(payload->>'contactId')::uuid AND u.email_confirmed_at IS NOT NULL
        AND lower(u.email)=m.email AND a.email IS NULL;
    IF response IS NULL THEN RAISE EXCEPTION 'O contato não autorizou o envio.'; END IF;
    RETURN response;
  END IF;
  IF operation='admin_metrics' THEN
    RETURN nhac.sales_metrics(coalesce((payload->>'days')::int,30));
  END IF;
  IF operation='admin_order_payment' THEN
    SELECT * INTO order_row FROM nhac.orders WHERE id=(payload->>'id')::uuid FOR UPDATE;
    IF NOT FOUND OR order_row.status='cancelled' THEN RAISE EXCEPTION 'Pedido indisponível.'; END IF;
    IF payment_value NOT IN ('pix','card','cash','transfer') THEN RAISE EXCEPTION 'Selecione um meio de pagamento.'; END IF;
    IF order_row.payment_status='confirmed' THEN
      IF order_row.payment_method=payment_value THEN RETURN jsonb_build_object('ok',true); END IF;
      RAISE EXCEPTION 'O pagamento já foi registrado.';
    END IF;
    UPDATE nhac.orders SET payment_method=payment_value,payment_status='confirmed',paid_at=now() WHERE id=order_row.id;
    INSERT INTO nhac.audit(actor,action,target,data) VALUES(viewer,'order_payment',order_row.id::text,jsonb_build_object('method',payment_value));
    RETURN jsonb_build_object('ok',true);
  END IF;
  IF operation='shop_products' THEN
    SELECT coalesce(jsonb_agg(
      CASE WHEN admin OR wholesale_access THEN to_jsonb(p)
      ELSE to_jsonb(p)-'wholesale_cents'-'wholesale_minimum' END ORDER BY p.category,p.name),'[]'::jsonb)
      INTO response FROM nhac.products p;
    RETURN jsonb_build_object('products',response,'wholesale',wholesale_access,'demo',true,'signedIn',true);
  END IF;
  IF operation='admin_users' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,
      'role',CASE WHEN a.email IS NULL THEN 'CUSTOMER' ELSE 'MAIN' END,'active',true) ORDER BY p.full_name),'[]'::jsonb)
      INTO response FROM nhac.profiles p LEFT JOIN nhac.administrators a ON p.email=a.email;
    RETURN jsonb_build_object('users',response);
  END IF;
  IF operation='admin_prices' THEN
    retail_value := (payload->>'retail_cents')::integer;
    wholesale_value := (payload->>'wholesale_cents')::integer;
    IF retail_value IS NULL OR wholesale_value IS NULL OR retail_value NOT BETWEEN 1 AND 99999999
      OR wholesale_value NOT BETWEEN 1 AND 99999999 THEN RAISE EXCEPTION 'Informe preços válidos.'; END IF;
    SELECT * INTO row_product FROM nhac.products WHERE id=item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Produto não encontrado.'; END IF;
    UPDATE nhac.products SET retail_cents=retail_value,wholesale_cents=wholesale_value WHERE id=item_id;
    INSERT INTO nhac.audit(actor,action,target,data) VALUES(viewer,'prices',item_id,jsonb_build_object(
      'retail_before',row_product.retail_cents,'retail_after',retail_value,
      'wholesale_before',row_product.wholesale_cents,'wholesale_after',wholesale_value));
    RETURN jsonb_build_object('ok',true);
  END IF;
  IF operation='shop_wholesale_request' THEN
    IF company_name IS NULL OR char_length(company_name) NOT BETWEEN 2 AND 120 THEN RAISE EXCEPTION 'Informe o nome da empresa.'; END IF;
    INSERT INTO nhac.wholesale(user_id,company) VALUES(viewer,company_name)
    ON CONFLICT(user_id) DO UPDATE SET company=excluded.company WHERE NOT wholesale.approved;
  END IF;
  IF operation IN ('shop_wholesale','shop_wholesale_request') THEN
    SELECT to_jsonb(w)-'user_id' INTO response FROM nhac.wholesale w WHERE w.user_id=viewer;
    RETURN jsonb_build_object('account',response);
  END IF;
  IF operation='admin_wholesale' THEN
    UPDATE nhac.wholesale SET approved=(payload->>'approved')::boolean WHERE user_id=(payload->>'userId')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Solicitação não encontrada.'; END IF;
    INSERT INTO nhac.audit(actor,action,target,data) VALUES(viewer,'wholesale',payload->>'userId',payload);
    RETURN jsonb_build_object('ok',true);
  END IF;
  IF operation IN ('shop_orders','admin_orders') THEN
    SELECT coalesce(jsonb_agg(to_jsonb(o) - 'user_id' - 'request_id' ORDER BY o.created_at DESC),'[]'::jsonb)
      INTO response FROM (
        SELECT o.*,p.full_name AS customer,
          (SELECT jsonb_agg(to_jsonb(i)-'order_id' ORDER BY product_name) FROM nhac.order_items i WHERE i.order_id=o.id) AS items
        FROM nhac.orders o JOIN nhac.profiles p ON p.id=o.user_id
        WHERE admin OR o.user_id=viewer ORDER BY o.created_at DESC LIMIT 100
      ) o;
    IF operation='admin_orders' THEN
      RETURN jsonb_build_object('orders',response,
        'products',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.name),'[]'::jsonb) FROM nhac.products p),
        'wholesale',(SELECT coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object('name',p.full_name)),'[]'::jsonb)
          FROM nhac.wholesale w JOIN nhac.profiles p ON p.id=w.user_id));
    END IF;
    RETURN jsonb_build_object('orders',response);
  END IF;
  IF operation='admin_order_status' THEN
    SELECT * INTO order_row FROM nhac.orders WHERE id=(payload->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Pedido não encontrado.'; END IF;
    IF next_status=order_row.status THEN RETURN jsonb_build_object('ok',true); END IF;
    IF next_status IS NULL OR NOT (
      (order_row.status='received' AND next_status IN ('preparing','cancelled'))
      OR (order_row.status='preparing' AND next_status IN ('ready','cancelled'))
    ) THEN RAISE EXCEPTION 'Alteração de status indisponível.'; END IF;
    IF next_status='cancelled' THEN
      IF order_row.payment_status='confirmed' THEN RAISE EXCEPTION 'Pedidos com recebimento registrado não podem ser cancelados por este fluxo.'; END IF;
      PERFORM p.id FROM nhac.products p
        WHERE p.id IN (SELECT i.product_id FROM nhac.order_items i WHERE i.order_id=order_row.id)
        ORDER BY p.id FOR UPDATE OF p;
      UPDATE nhac.products p SET stock=p.stock+i.quantity FROM (
        SELECT product_id,sum(quantity)::int AS quantity FROM nhac.order_items
        WHERE order_id=order_row.id GROUP BY product_id
      ) i WHERE i.product_id=p.id;
    END IF;
    UPDATE nhac.orders SET status=next_status WHERE id=order_row.id;
    INSERT INTO nhac.audit(actor,action,target,data) VALUES(viewer,'order_status',order_row.id::text,jsonb_build_object('status',next_status));
    RETURN jsonb_build_object('ok',true);
  END IF;
  IF operation NOT IN ('shop_cart','shop_cart_change','shop_checkout') THEN RAISE EXCEPTION 'Operação indisponível.'; END IF;
  IF sales_channel NOT IN ('retail','wholesale') THEN RAISE EXCEPTION 'Modalidade inválida.'; END IF;
  IF sales_channel='wholesale' AND NOT wholesale_access THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Atacado disponível para contas aprovadas.';
  END IF;
  IF operation IN ('shop_cart_change','shop_checkout') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(viewer::text,0));
  END IF;
  IF operation='shop_cart_change' THEN
    quantity_value := (payload->>'quantity')::integer;
    IF quantity_value IS NULL OR quantity_value NOT BETWEEN 0 AND 999 THEN RAISE EXCEPTION 'Informe uma quantidade válida.'; END IF;
    IF quantity_value=0 THEN
      DELETE FROM nhac.cart WHERE user_id=viewer AND channel=sales_channel AND product_id=item_id AND cut=cut_value;
    ELSE
      SELECT * INTO row_product FROM nhac.products WHERE id=item_id;
      IF NOT FOUND OR (NOT (cut_value=ANY(row_product.cut_options)) AND NOT (cut_value='original' AND (NOT (payload ? 'cut') OR EXISTS(SELECT 1 FROM nhac.cart WHERE user_id=viewer AND channel=sales_channel AND product_id=item_id AND cut='original')))) THEN RAISE EXCEPTION 'Selecione um corte disponível.'; END IF;
      IF (sales_channel='wholesale' AND quantity_value<row_product.wholesale_minimum)
        OR quantity_value+coalesce((SELECT sum(c.quantity) FROM nhac.cart c WHERE c.user_id=viewer
          AND c.channel=sales_channel AND c.product_id=item_id AND c.cut<>cut_value),0)>row_product.stock THEN
        RAISE EXCEPTION 'Revise o estoque ou a quantidade mínima por corte.';
      END IF;
      INSERT INTO nhac.cart(user_id,channel,product_id,quantity,cut) VALUES(viewer,sales_channel,item_id,quantity_value,cut_value)
      ON CONFLICT(user_id,channel,product_id,cut) DO UPDATE SET quantity=excluded.quantity;
    END IF;
  END IF;
  IF operation='shop_checkout' THEN
    request_key := (payload->>'requestId')::uuid;
    IF request_key IS NULL THEN RAISE EXCEPTION 'Identificador de pedido obrigatório.'; END IF;
    SELECT * INTO order_row FROM nhac.orders WHERE user_id=viewer AND request_id=request_key;
    IF FOUND THEN
      IF order_row.channel<>sales_channel THEN RAISE EXCEPTION 'Identificador utilizado em outra modalidade.'; END IF;
      RETURN jsonb_build_object('id',order_row.id,'channel',order_row.channel,'total_cents',order_row.total_cents);
    END IF;
    IF payment_value NOT IN ('unspecified','pix','card','cash','transfer') THEN RAISE EXCEPTION 'Meio de pagamento inválido.'; END IF;
    PERFORM p.id FROM nhac.products p
      WHERE p.id IN (SELECT c.product_id FROM nhac.cart c WHERE c.user_id=viewer AND c.channel=sales_channel)
      ORDER BY p.id FOR UPDATE OF p;
    IF EXISTS(SELECT 1 FROM nhac.cart_rows(viewer,sales_channel) r JOIN nhac.products p ON p.id=r.id
        WHERE r.quantity<r.minimum OR NOT (r.cut=ANY(p.cut_options)) AND r.cut<>'original')
      OR EXISTS(SELECT 1 FROM nhac.cart_rows(viewer,sales_channel) r GROUP BY r.id,r.stock HAVING sum(r.quantity)>r.stock) THEN
      RAISE EXCEPTION 'Estoque ou quantidade mínima mudou. Revise o carrinho.';
    END IF;
    SELECT sum(r.quantity*r.unit_cents::bigint) INTO total FROM nhac.cart_rows(viewer,sales_channel) r;
    IF total IS NULL THEN RAISE EXCEPTION 'Adicione produtos ao carrinho.'; END IF;
    INSERT INTO nhac.orders(user_id,request_id,channel,total_cents,payment_method)
      VALUES(viewer,request_key,sales_channel,total,payment_value) RETURNING * INTO order_row;
    INSERT INTO nhac.order_items(order_id,product_id,product_name,quantity,unit_cents,cut)
      SELECT order_row.id,r.id,r.name,r.quantity,r.unit_cents,r.cut FROM nhac.cart_rows(viewer,sales_channel) r;
    UPDATE nhac.products p SET stock=p.stock-c.quantity FROM (
      SELECT product_id,sum(quantity)::int AS quantity FROM nhac.cart
      WHERE user_id=viewer AND channel=sales_channel GROUP BY product_id
    ) c WHERE c.product_id=p.id;
    DELETE FROM nhac.cart WHERE user_id=viewer AND channel=sales_channel;
    RETURN jsonb_build_object('id',order_row.id,'channel',sales_channel,'total_cents',total);
  END IF;
  SELECT jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.name),'[]'::jsonb),
    'total_cents',coalesce(sum(r.quantity*r.unit_cents::bigint),0)) INTO response
    FROM nhac.cart_rows(viewer,sales_channel) r;
  RETURN response;
END $$;
