CREATE TABLE nhac.access_levels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 50 AND lower(name) NOT IN ('main','cliente','customer')),
  permissions text[] NOT NULL CHECK (cardinality(permissions)>0 AND array_position(permissions,NULL) IS NULL
    AND permissions <@ ARRAY['overview','orders','catalog','wholesale','clients','marketing'])
);
CREATE UNIQUE INDEX nhac_access_level_name_idx ON nhac.access_levels(lower(name));
CREATE TABLE nhac.staff_access (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email=lower(email)),
  level_id uuid NOT NULL REFERENCES nhac.access_levels(id)
);
CREATE TABLE nhac.staff_profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name text CHECK (name IS NULL OR char_length(name) BETWEEN 2 AND 120),
  phone text,
  avatar bytea,
  avatar_mime text,
  CHECK ((avatar IS NULL AND avatar_mime IS NULL) OR (avatar IS NOT NULL AND
    avatar_mime IS NOT NULL AND avatar_mime='image/jpeg' AND octet_length(avatar) BETWEEN 5 AND 180000 AND
    encode(substring(avatar FROM 1 FOR 3),'hex')='ffd8ff'))
);
ALTER TABLE nhac.access_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE nhac.staff_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE nhac.staff_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON nhac.access_levels,nhac.staff_access,nhac.staff_profiles FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION nhac.dispatch(operation text, payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  viewer uuid := auth.uid();
  cut_value text := coalesce(payload->>'cut','original');
  payment_value text := coalesce(payload->>'paymentMethod','unspecified');
  account_email text;
  display_name text;
  admin boolean;
  main_access boolean;
  level_id uuid;
  level_name text;
  grants text[];
  photo_bytes bytea;
  photo_mime text;
  profile_name text;
  profile_phone text;
  target_email text;
  target_id uuid;
  requested_role text;
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
    FROM auth.users u WHERE u.id=viewer AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL;
  IF account_email IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Entre com um e-mail confirmado.'; END IF;
  SELECT EXISTS(SELECT 1 FROM nhac.administrators a WHERE a.email=account_email) INTO main_access;
  SELECT s.level_id,l.name,l.permissions INTO level_id,level_name,grants
    FROM nhac.staff_access s JOIN nhac.access_levels l ON l.id=s.level_id
    WHERE s.user_id=viewer AND s.email=account_email;
  admin := main_access OR level_id IS NOT NULL;
  grants := CASE WHEN main_access THEN ARRAY['overview','orders','catalog','wholesale','clients','marketing'] ELSE coalesce(grants,ARRAY[]::text[]) END;
  IF operation='profile' THEN
    INSERT INTO nhac.profiles VALUES (viewer,display_name,account_email) ON CONFLICT(id) DO UPDATE
      SET full_name=excluded.full_name,email=excluded.email
      WHERE (profiles.full_name,profiles.email) IS DISTINCT FROM (excluded.full_name,excluded.email);
    RETURN jsonb_build_object('user',jsonb_build_object('id',viewer,'name',display_name,'email',account_email,
      'role',CASE WHEN main_access THEN 'MAIN' WHEN admin THEN 'STAFF' ELSE 'CUSTOMER' END,
      'roleName',CASE WHEN main_access THEN 'MAIN' ELSE level_name END,
      'permissions',grants));
  END IF;
  IF admin AND coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Confirme o código do autenticador.';
  END IF;
  IF operation LIKE 'admin_%' AND NOT (main_access OR (admin AND CASE operation
    WHEN 'admin_my_account' THEN true
    WHEN 'admin_my_account_save' THEN true
    WHEN 'admin_metrics' THEN 'overview'=ANY(grants)
    WHEN 'admin_orders' THEN grants && ARRAY['orders','catalog','wholesale']
    WHEN 'admin_order_status' THEN 'orders'=ANY(grants)
    WHEN 'admin_order_payment' THEN 'orders'=ANY(grants)
    WHEN 'admin_prices' THEN 'catalog'=ANY(grants)
    WHEN 'admin_wholesale' THEN 'wholesale'=ANY(grants)
    WHEN 'admin_users' THEN 'clients'=ANY(grants)
    WHEN 'admin_marketing' THEN 'marketing'=ANY(grants)
    WHEN 'admin_marketing_recipient' THEN 'marketing'=ANY(grants)
    ELSE false
  END)) THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Sem permissão para esta área.';
  END IF;
  IF operation LIKE 'shop_%' AND admin AND operation <> 'shop_products' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Entre como cliente para usar a loja.';
  END IF;
  INSERT INTO nhac.profiles VALUES (viewer,display_name,account_email) ON CONFLICT(id) DO NOTHING;
  SELECT EXISTS(SELECT 1 FROM nhac.wholesale w WHERE w.user_id=viewer AND w.approved) INTO wholesale_access;

  IF operation IN ('admin_my_account','admin_my_account_save') THEN
    IF operation='admin_my_account_save' THEN
      profile_name := btrim(payload->>'name');
      profile_phone := nullif(btrim(payload->>'phone'),'');
      IF profile_name IS NULL OR char_length(profile_name) NOT BETWEEN 2 AND 120 THEN
        RAISE EXCEPTION 'Informe um nome de 2 a 120 caracteres.';
      END IF;
      IF profile_phone IS NOT NULL AND (profile_phone !~ '^[+0-9() .-]{8,26}$'
        OR char_length(regexp_replace(profile_phone,'[^0-9]','','g')) NOT BETWEEN 8 AND 15) THEN
        RAISE EXCEPTION 'Informe um telefone válido com DDD.';
      END IF;
      IF payload ? 'photo' AND jsonb_typeof(payload->'photo') <> 'null' THEN
        photo_mime := payload->>'mime';
        IF photo_mime IS DISTINCT FROM 'image/jpeg' OR char_length(coalesce(payload->>'photo','')) NOT BETWEEN 8 AND 240000 THEN
          RAISE EXCEPTION 'Selecione uma foto JPEG de até 180 KB.';
        END IF;
        BEGIN
          photo_bytes := decode(payload->>'photo','base64');
        EXCEPTION WHEN invalid_parameter_value OR invalid_text_representation THEN
          RAISE EXCEPTION 'Arquivo de imagem inválido.';
        END;
        IF encode(substring(photo_bytes FROM 1 FOR 3),'hex') <> 'ffd8ff' THEN
          RAISE EXCEPTION 'Arquivo de imagem inválido.';
        END IF;
      END IF;
      INSERT INTO nhac.staff_profiles AS existing(user_id,name,phone,avatar,avatar_mime)
        VALUES(viewer,profile_name,profile_phone,photo_bytes,photo_mime)
      ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,phone=excluded.phone,
        avatar=CASE WHEN payload ? 'photo' THEN excluded.avatar ELSE existing.avatar END,
        avatar_mime=CASE WHEN payload ? 'photo' THEN excluded.avatar_mime ELSE existing.avatar_mime END;
    END IF;
    SELECT jsonb_build_object('name',coalesce(p.name,display_name),'phone',p.phone,'email',account_email,'role',CASE WHEN main_access THEN 'MAIN' ELSE level_name END,
      'photo',encode(p.avatar,'base64'),'mime',p.avatar_mime) INTO response
      FROM (SELECT 1) root LEFT JOIN nhac.staff_profiles p ON p.user_id=viewer;
    RETURN response;
  END IF;
  IF operation='admin_access' THEN
    RETURN jsonb_build_object(
      'levels',coalesce((SELECT jsonb_agg(to_jsonb(l) ORDER BY lower(l.name)) FROM nhac.access_levels l),'[]'::jsonb),
      'staff',coalesce((SELECT jsonb_agg(x ORDER BY x.email) FROM (
        SELECT a.email, 'main'::text AS level, 'MAIN'::text AS name, a.email=account_email AS self
        FROM nhac.administrators a
        UNION ALL
        SELECT s.email,s.level_id::text,l.name,false
        FROM nhac.staff_access s JOIN nhac.access_levels l ON l.id=s.level_id
        WHERE NOT EXISTS (SELECT 1 FROM nhac.administrators a WHERE a.email=s.email)
      ) x),'[]'::jsonb));
  END IF;
  IF operation='admin_access_level' THEN
    level_name := btrim(payload->>'name');
    IF level_name IS NULL OR char_length(level_name) NOT BETWEEN 2 AND 50 OR lower(level_name) IN ('main','cliente','customer') THEN
      RAISE EXCEPTION 'Informe um nome de nível válido.';
    END IF;
    IF jsonb_typeof(payload->'permissions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Selecione as áreas permitidas.'; END IF;
    SELECT array_agg(DISTINCT p.permission ORDER BY p.permission) INTO grants
      FROM jsonb_array_elements_text(payload->'permissions') p(permission);
    IF grants IS NULL OR array_position(grants,NULL) IS NOT NULL OR NOT (grants <@ ARRAY['overview','orders','catalog','wholesale','clients','marketing']) THEN
      RAISE EXCEPTION 'Selecione ao menos uma área válida.';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('nhac.staff_access',0));
    IF NOT EXISTS(SELECT 1 FROM nhac.administrators a WHERE a.email=account_email) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Acesso restrito a MAIN.';
    END IF;
    IF nullif(payload->>'id','') IS NULL THEN
      INSERT INTO nhac.access_levels(name,permissions) VALUES(level_name,grants) RETURNING id INTO level_id;
    ELSE
      UPDATE nhac.access_levels SET name=level_name,permissions=grants WHERE id=(payload->>'id')::uuid RETURNING id INTO level_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Nível não encontrado.'; END IF;
    END IF;
    INSERT INTO nhac.audit(actor,action,target,data) VALUES(viewer,'access_level',level_id::text,jsonb_build_object('name',level_name,'permissions',grants));
    RETURN jsonb_build_object('ok',true,'id',level_id);
  END IF;
  IF operation='admin_access_assign' THEN
    target_email := lower(btrim(payload->>'email'));
    requested_role := payload->>'level';
    IF requested_role IS NULL OR target_email IS NULL OR char_length(target_email)>254 THEN
      RAISE EXCEPTION 'Informe o e-mail e o nível de acesso.';
    END IF;
    IF target_email=account_email THEN RAISE EXCEPTION 'Você não pode alterar o próprio acesso.'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('nhac.staff_access',0));
    IF NOT EXISTS(SELECT 1 FROM nhac.administrators a WHERE a.email=account_email) THEN
      RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Acesso restrito a MAIN.';
    END IF;
    SELECT u.id INTO target_id FROM auth.users u
      WHERE lower(u.email)=target_email AND u.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL;
    IF target_id IS NULL THEN RAISE EXCEPTION 'A conta precisa estar cadastrada e ter e-mail confirmado.'; END IF;
    IF requested_role='main' THEN
      INSERT INTO nhac.administrators(email) VALUES(target_email) ON CONFLICT DO NOTHING;
      DELETE FROM nhac.staff_access WHERE user_id=target_id;
    ELSE
      DELETE FROM nhac.administrators WHERE email=target_email;
      IF requested_role='customer' THEN
        DELETE FROM nhac.staff_access WHERE user_id=target_id;
      ELSE
        level_id := requested_role::uuid;
        IF NOT EXISTS (SELECT 1 FROM nhac.access_levels WHERE id=level_id) THEN RAISE EXCEPTION 'Nível não encontrado.'; END IF;
        INSERT INTO nhac.staff_access(user_id,email,level_id) VALUES(target_id,target_email,level_id)
          ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,level_id=excluded.level_id;
      END IF;
    END IF;
    INSERT INTO nhac.audit(actor,action,target,data) VALUES(viewer,'access_assignment',target_id::text,jsonb_build_object('level',requested_role));
    RETURN jsonb_build_object('ok',true);
  END IF;
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
        WHERE u.email_confirmed_at IS NOT NULL AND lower(u.email)=m.email AND a.email IS NULL AND NOT EXISTS (SELECT 1 FROM nhac.staff_access s WHERE s.user_id=m.user_id AND s.email=m.email)
        ORDER BY m.consent_at DESC,m.user_id LIMIT 200) c
    ),'[]'::jsonb));
  END IF;
  IF operation='admin_marketing_recipient' THEN
    SELECT jsonb_build_object('email',m.email,'unsubscribeToken',m.unsubscribe_token) INTO response
      FROM nhac.marketing_preferences m JOIN auth.users u ON u.id=m.user_id
      LEFT JOIN nhac.administrators a ON a.email=m.email
      WHERE m.user_id=(payload->>'contactId')::uuid AND u.email_confirmed_at IS NOT NULL
        AND lower(u.email)=m.email AND a.email IS NULL AND NOT EXISTS (SELECT 1 FROM nhac.staff_access s WHERE s.user_id=m.user_id AND s.email=m.email);
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
    IF admin AND NOT ('catalog'=ANY(grants)) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Sem permissão para o catálogo.'; END IF;
    SELECT coalesce(jsonb_agg(
      CASE WHEN admin OR wholesale_access THEN to_jsonb(p)
      ELSE to_jsonb(p)-'wholesale_cents'-'wholesale_minimum' END ORDER BY p.category,p.name),'[]'::jsonb)
      INTO response FROM nhac.products p;
    RETURN jsonb_build_object('products',response,'wholesale',wholesale_access,'demo',true,'signedIn',true);
  END IF;
  IF operation='admin_users' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.full_name,'email',p.email,
      'role',CASE WHEN a.email IS NOT NULL THEN 'MAIN' WHEN l.id IS NOT NULL THEN 'STAFF' ELSE 'CUSTOMER' END,
      'roleName',l.name,'active',true) ORDER BY p.full_name),'[]'::jsonb)
      INTO response FROM nhac.profiles p LEFT JOIN nhac.administrators a ON p.email=a.email
      LEFT JOIN nhac.staff_access s ON s.user_id=p.id AND s.email=p.email LEFT JOIN nhac.access_levels l ON l.id=s.level_id;
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
        WHERE (operation='admin_orders' AND 'orders'=ANY(grants)) OR (operation='shop_orders' AND o.user_id=viewer)
        ORDER BY o.created_at DESC LIMIT 100
      ) o;
    IF operation='admin_orders' THEN
      RETURN jsonb_build_object('orders',response,
        'products',CASE WHEN 'catalog'=ANY(grants) THEN
          (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.name),'[]'::jsonb) FROM nhac.products p) ELSE '[]'::jsonb END,
        'wholesale',CASE WHEN 'wholesale'=ANY(grants) THEN
          (SELECT coalesce(jsonb_agg(to_jsonb(w)||jsonb_build_object('name',p.full_name)),'[]'::jsonb)
           FROM nhac.wholesale w JOIN nhac.profiles p ON p.id=w.user_id) ELSE '[]'::jsonb END);
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
