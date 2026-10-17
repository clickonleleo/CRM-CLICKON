-- Limite de usuários por organização (seat limit).
--
-- ANTES: nada controlava quantos usuários podiam ser convidados. Um admin
-- convidava 50 pessoas, subia a fatura do cliente, e a conta vinha na hora.
-- O limite é por ORGANIZAÇÃO, não por plano, porque plano e limite são duas
-- decisões: o plano é comercial, o limite é operacional. O admin plataforma
-- pode subir/descer a qualquer momento sem mexer no plano.
--
-- Default 5: cobre a esmagadora maioria das PMEs que adotam o produto
-- (1 dono + 1 gerente + 3 atendentes é o uso típico). Quem precisa de mais
-- pede, e o platform admin sobe pela tela.
--
-- A coluna mora em `organizations` (não em `settings` jsonb) porque o caminho
-- é o HOT path do convite — `issueInvite` chama `fn_count_active_members` em
-- TODA criação de convite, e contar a partir de uma coluna indexada é mais
-- barato que caminhar um jsonb.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS seat_limit integer NOT NULL DEFAULT 5
  CHECK (seat_limit >= 1);

COMMENT ON COLUMN public.organizations.seat_limit IS
  'Teto de usuários ativos por organização. Bloqueia convites quando atingido. Default 5.';

-- ----------------------------------------------------------------------------
-- Contador de membros ATIVOS (não revoked, com accepted_at não nulo).
-- ----------------------------------------------------------------------------
-- "Membro ativo" = alguém que aceitou convite e não foi revogado. O convite
-- pendente NÃO conta, porque ele ainda pode não ser aceito (vencer, ser
-- revogado pelo próprio owner, etc). Contar pendente como ativo faria o
-- admin plataforma achar que a org está cheia quando está cheia de gente
-- que nem entrou.
--
-- security definer + search_path travado: este contador é chamado por
-- `issueInvite` (que roda como o usuário autenticado, NÃO service_role), e
-- a policy de `user_organizations` esconde linhas de outras orgs. Sem
-- definer, o convite da org X tentaria contar membros da org X e bateria
-- em RLS que retorna 0 — e o `seat_limit` seria inútil, todo convite passa.
create or replace function public.fn_count_active_members(p_org uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select count(*)::integer
  from public.user_organizations
  where organization_id = p_org
    and accepted_at is not null
    and revoked_at is null;
$$;

revoke all on function public.fn_count_active_members(uuid) from public, anon;
grant execute on function public.fn_count_active_members(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- `fn_create_tenant_with_owner` aceita `seat_limit` opcional.
-- ----------------------------------------------------------------------------
-- O contrato é `jsonb` (p_request), e o banco lê com `->>`. Sem seat_limit no
-- body → usa o default da coluna (5). Com seat_limit no body → usa o que veio,
-- validado pelo CHECK da coluna.
--
-- ⚠️ Não troca a assinatura (sempre `uuid, uuid, jsonb, text`): RPC existente
-- no app já chama com 4 args, e adicionar um 5º quebraria todos os forks que
-- fizeram `git pull` recente. O ganho é "interpretar campo novo do jsonb" —
-- o forward, nunca a quebra.
create or replace function public.fn_create_tenant_with_owner(
  p_actor uuid, p_key uuid, p_request jsonb, p_hash text
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  v_seat_limit integer;
  result jsonb;
begin
  if not exists (select 1 from public.platform_admins where user_id = p_actor
    and revoked_at is null and scope = 'full') then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_actor::text || ':' || p_key::text, 0));
  select * into prior from public.idempotency_keys
    where key = p_key::text and endpoint = '/api/v1/admin/tenants:' || p_actor::text
      and expires_at > now();
  if found then
    if prior.request_hash <> decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    return prior.response_body || jsonb_build_object('created', false);
  end if;
  -- Lê seat_limit do body se vier, senão deixa a coluna aplicar o DEFAULT 5.
  -- `nullif` converte string vazia em NULL → DEFAULT; `case` protege contra
  -- body malicioso mandando string não-numérica (não chega a INTEGER).
  begin
    v_seat_limit := case
      when p_request->>'seat_limit' is null or p_request->>'seat_limit' = '' then null
      else (p_request->>'seat_limit')::integer
    end;
  exception when others then
    v_seat_limit := null;
  end;
  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by, seat_limit)
    values (p_request->>'display_name', p_request->>'slug', coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
      p_request->>'cnpj', 'active', jsonb_build_object('plan', p_request->>'plan'), p_actor, v_seat_limit)
    returning * into org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at)
    values (org.id, p_actor, 'admin', now());
  result := jsonb_build_object('id', org.id, 'slug', org.slug, 'display_name', org.display_name,
    'invite_id', gen_random_uuid(), 'issued_at', floor(extract(epoch from now()))::bigint);
  insert into public.idempotency_keys(organization_id, key, endpoint, request_hash, status_code, response_body)
    values (org.id, p_key::text, '/api/v1/admin/tenants:' || p_actor::text,
      decode(p_hash, 'hex'), 201, result);
  return result || jsonb_build_object('created', true);
end $$;
revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text) to service_role;
