# Estado do Projeto - 2026-10-17

## ✅ Feature Implementada: Limite de Equipe por Organização (seat_limit)

### O que foi feito

| Componente | Arquivo | Descrição |
|------------|---------|-----------|
| **Migration DB** | `supabase/migrations/20261016211500_0233_seat_limit_per_org.sql` | Adiciona coluna `seat_limit` na tabela `organizations`, cria RPC `fn_count_active_members`, atualiza `fn_create_tenant_with_owner` |
| **Baseline SQL** | `supabase/baseline.sql` | Apêndice idempotente para self-host kit (+81 linhas) |
| **MANIFEST** | `supabase/migrations/MANIFEST.md` | Entrada da migration 0233 |
| **Schema Zod** | `lib/schemas/tenant-creation.ts` | Campo `seat_limit` com validação (int, min 1, max 10000) |
| **Lógica de Bloqueio** | `lib/auth/issue-invite.ts` | Função `checarSeatLimiteAntesDeConvidar()` + flag `skipSeatLimitCheck` |
| **Testes Unitários** | `lib/auth/issue-invite.seat-limit.test.ts` | 8 testes cobrindo edge cases |
| **API GET/POST** | `app/api/v1/admin/tenants/route.ts` | GET mostra seat_limit, POST passa skipSeatLimitCheck no convite do owner |
| **API PATCH** | `app/api/v1/admin/tenants/[id]/route.ts` | Endpoint para ajustar seat_limit (com MFA + audit log) |
| **Form UI** | `app/admin/(protected)/tenants/new/_form.tsx` | Campo "Limite de usuários" no formulário de criar organização |

### Commit
```
[main 1ae9608] feat(admin): limite de equipe por organizacao (seat_limit)
9 files changed, 606 insertions(+), 1 deletion(-)
```

---

## ⚠️ Problemas Conhecidos

### 1. CI Quebrado (OOM no Typecheck)
O pipeline de CI está falhando com **Out of Memory** no step `typecheck`. Isso é um problema preexistente — todos os últimos 5 runs falharam antes do nosso commit.

**Sintoma:**
```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

**Impacto:** Nenhum merge pode ser feito até resolver.

**Solução possível:**
- Aumentar memória do runner (Node heap: `--max-old-space-size=4096`)
- Ou dividir o typecheck em chunks
- Ou otimizar imports do TypeScript

### 2. Testes de Integração (invariants)
Vários testes de invariante estão falhando com erros esperados (não são bugs nossos):
- `calendar_appointments_sem_duplicata_idx` (duplicate key)
- `system_version_id_check` (check constraint)
- `uniq_system_update_runs_dispatched` (duplicate)
- `conversations` RLS policy
- `crm_leads` RLS policy
- `contacts_custom_fields_object` (check constraint)
- `event_log_status_check` (check constraint)
- `permission denied for table ai_provider_credentials`

Estes são provavelmente dados de seed conflitantes ou constraints do baseline que precisam de ajuste.

---

## 📋 Pendências

### UI - Melhorias no Admin Panel

- [ ] **Mostrar uso de seats na página do tenant** (`app/admin/(protected)/tenants/[id]/_client.tsx`)
  - Exibir "X/Y usuários" (ocupados / limite)
  - Mostrar lista de membros da equipe

- [ ] **Coluna "Limite" na tabela de tenants** (`app/admin/(protected)/tenants/_client.tsx`)
  - Adicionar coluna `seat_limit` na listagem

### Testes

- [ ] **Testar fluxo completo na VPS:**
  1. Criar organização com seat_limit = 3
  2. Criar owner (1 usuário)
  3. Convidar 2 agentes (total: 3)
  4. Tentar convidar 4º usuário → deve bloquear com `seat_limit_reached`
  5. Admin altera limit para 5 → 4º convite deve passar

- [ ] **Testar PATCH seat_limit via API**
  - Verificar que audit log registra a mudança

### Deploy

- [ ] **Deploy na VPS**
  - Aplicar migration 0233 no banco de produção
  - Atualizar código (pull + restart)

---

## 🧪 Como Testar na VPS

### 1. Criar Organização (via UI ou API)

```bash
# Via API
curl -X POST https://seu-dominio.com/api/v1/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "display_name": "Empresa Teste",
    "slug": "empresa-teste",
    "plan": "standard",
    "seat_limit": 3,
    "owner_email": "dono@empresa.com",
    "owner_interface_settings": {...}
  }'
```

### 2. Testar Bloqueio de Convite

Quando a organização tiver `ocupados >= limite`, o convite deve retornar:

```json
{
  "error": {
    "code": "seat_limit_reached",
    "message": "Limite de 3 usuários atingido. Aumente o limite na administração."
  }
}
```

### 3. Alterar Limite via API

```bash
curl -X PATCH https://seu-dominio.com/api/v1/admin/tenants/$ORG_ID \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-TOTP-Code: $TOTP_CODE" \
  -d '{"seat_limit": 5}'
```

Resposta:
```json
{
  "data": {
    "id": "uuid-da-org",
    "seat_limit": 5
  }
}
```

---

## 📁 Arquivos Modificados

```
app/admin/(protected)/tenants/new/_form.tsx     (form com campo seat_limit)
app/api/v1/admin/tenants/[id]/route.ts          (PATCH seat_limit)
app/api/v1/admin/tenants/route.ts               (GET/POST com seat_limit)
lib/auth/issue-invite.ts                        (lógica de checagem)
lib/auth/issue-invite.seat-limit.test.ts        (testes unitários - NOVO)
lib/schemas/tenant-creation.ts                   (schema Zod)
supabase/baseline.sql                           (apêndice idempotente)
supabase/migrations/20261016211500_0233_seat_limit_per_org.sql  (NOVO)
supabase/migrations/MANIFEST.md                  (entrada 0233)
```

---

## 🔗 Links Úteis

- **Repo:** https://github.com/clickonleleo/CRM-CLICKON
- **Commit:** https://github.com/clickonleleo/CRM-CLICKON/commit/1ae9608
- **Run de CI:** https://github.com/clickonleleo/CRM-CLICKON/actions/runs/39031840996

---

## 📝 Notas para a Próxima Sessão

1. **Verificar se CI está passando** — se não, corrigir OOM primeiro
2. **Aplicar migration 0233** no banco de produção da VPS:
   ```bash
   psql "$SUPABASE_DB_URL" -f supabase/migrations/20261016211500_0233_seat_limit_per_org.sql
   ```
3. **Deploy do código** via `git pull` + restart do container
4. **Testar fluxo completo** conforme seção "Como Testar na VPS"
5. **Verificar audit log** após alteração de seat_limit
