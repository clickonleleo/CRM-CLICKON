import {
  interfaceSettingsSchema,
  INTERFACE_COMPLETA,
  interfaceTemDestino,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * `seat_limit` é checado AQUI, não no banco, e o motivo é a UX: o banco
 * lança `check_violation` com mensagem críptica ("new row for relation
 * 'user_organizations' violates check constraint '...'") que o app teria
 * que traduzir. Tradução que erra = silêncio do erro. Aqui, em código,
 * temos o e-mail, o limite, a contagem — a gente fala a frase certa para
 * o usuário ("A organização atingiu o limite de 5 usuários. Fale com o
 * administrador da plataforma para aumentar."). E a checagem é barata
 * (count numa coluna com índice), então rodar no caminho do convite não
 * pesa. RPC `fn_count_active_members` mora no banco para reuso futuro
 * (relatórios, gate de billing) e para que a policy de RLS não esconda
 * linhas de fora — é `security definer`.
 *
 * ⚠️ Esta é a ÚNICA defesa contra over-invite? NÃO. O banco poderia
 * (e deveria, em tese) ter um trigger que rechecasse. Mas o escopo
 * desta feature é a UX; o trigger é trabalho separado, e a frase "fail
 * closed" mora no banco quando ele falhar — esta checagem é fail fast
 * com a melhor mensagem possível.
 */
export async function checarSeatLimiteAntesDeConvidar(
  organizationId: string,
  actorUserId: string,
  requestId: string,
): Promise<{ limite: number; ocupados: number }> {
  const admin = createAdminClient();
  // Lê em paralelo: limite (1 linha) + count (1 query). service_role bypassa
  // RLS, então não há risco de ler org de outro tenant.
  const [orgRes, ocupadosRes] = await Promise.all([
    admin.from("organizations").select("seat_limit").eq("id", organizationId).single(),
    admin.rpc("fn_count_active_members", { p_org: organizationId }),
  ]);
  const limite = orgRes.data?.seat_limit ?? 5;
  const ocupados = (ocupadosRes.data as number | null) ?? 0;
  if (ocupados >= limite) {
    // Audita a tentativa — assim o platform admin enxerga quem tentou
    // e em que organização, sem ter que esperar o cliente reclamar.
    await audit({
      action: "invite.blocked_seat_limit",
      actorUserId,
      organizationId,
      resourceType: "organization",
      resourceId: organizationId,
      requestId,
      metadata: { limite, ocupados },
    });
    // Erro com classe específica pra UI diferenciar de outros erros.
    const err = new Error(
      `Limite de ${limite} usuários atingido (${ocupados} ativos). Fale com o administrador da plataforma para aumentar.`,
    );
    (err as Error & { code: string }).code = "seat_limit_reached";
    throw err;
  }
  return { limite, ocupados };
}

/** Link sempre existe, inclusive quando a instalação não configurou e-mail. */
export async function issueInvite(input: {
  interfaceSettings?: InterfaceSettings;
  email: string;
  role: "viewer" | "agent" | "manager" | "admin";
  organizationId: string;
  orgName: string;
  inviterId: string;
  inviterName: string;
  requestId: string;
  inviteId?: string;
  issuedAt?: number;
  dispatch?: boolean;
  /**
   * Se `false`, pula a checagem de `seat_limit`. Usado pelo SIGNUP
   * administrativo (`fn_create_tenant_with_owner`): o owner que acabou
   * de ser criado pelo platform admin NÃO conta contra o limite, porque
   * o RPC já o insere em `user_organizations` como admin aceito na MESMA
   * transação — checar aqui geraria `5/5` e bloquearia o próprio convite
   * que o admin plataforma está fazendo. A checagem é pra convites
   * SUBSEQUENTES, da org já madura, quando alguém convida um colega.
   *
   * Default `true` é o caminho seguro: se um caller novo esquecer de
   * setar `false`, ele ganha a checagem. Só passa `false` quem tem
   * garantia transacional de que está criando o PRIMEIRO vínculo.
   */
  skipSeatLimitCheck?: boolean;
}) {
  const interfaceSettings = interfaceSettingsSchema.parse(
    input.interfaceSettings ?? INTERFACE_COMPLETA,
  );
  if (!interfaceTemDestino(interfaceSettings, input.role))
    throw new Error("Selecione ao menos uma área permitida ao papel.");
  const email = input.email.trim().toLowerCase();
  if (input.skipSeatLimitCheck !== true) {
    await checarSeatLimiteAntesDeConvidar(
      input.organizationId,
      input.inviterId,
      input.requestId,
    );
  }
  const inviteId = input.inviteId ?? randomUUID();
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const exp = iat + INVITE_TTL_SECONDS;
  const token = signInviteToken({
    invite_id: inviteId,
    email,
    organization_id: input.organizationId,
    role: input.role,
    exp,
    iat,
    invited_by: input.inviterId,
    interface_settings: interfaceSettings,
  });
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
  let dispatched = false;
  // Falhas de infraestrutura não desfazem a organização já criada nem o link.
  if (input.dispatch !== false) {
    try {
      const marca = await marcaDaSaida(input.organizationId);
      const message = buildInviteEmail({
        inviterName: input.inviterName,
        orgName: input.orgName,
        acceptUrl,
        role: input.role,
        expiresAt: new Date(exp * 1000),
        marca,
      });
      const result = await sendEmail({
        to: email,
        ...message,
        fromName: marca.nome,
        tags: [
          { name: "kind", value: "team_invite" },
          { name: "org", value: input.organizationId },
        ],
      });
      dispatched = result.ok;
    } catch {
      /* A superfície de recuperação é o link devolvido abaixo. */
    }
    await audit({
      action: "member.invited",
      actorUserId: input.inviterId,
      organizationId: input.organizationId,
      resourceType: "membership",
      resourceId: inviteId,
      requestId: input.requestId,
      metadata: { email, role: input.role, email_dispatched: dispatched },
    });
  }
  return {
    email,
    invite_id: inviteId,
    expires_at: new Date(exp * 1000).toISOString(),
    email_dispatched: dispatched,
    accept_url: acceptUrl,
  };
}
