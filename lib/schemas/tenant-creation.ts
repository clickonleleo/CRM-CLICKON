import { z } from "zod";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

/** Mesmo vocabulário no formulário e no limite HTTP. */
export const tenantCreationFields = {
  display_name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Apenas letras minúsculas, números e hífens"),
  legal_name: z.string().max(255).optional(),
  cnpj: z.string().max(18).optional(),
  plan: z.enum(["standard", "pro", "enterprise"]),
  /**
   * Teto de usuários ativos por organização. Default 5 quando ausente
   * (cobrir o uso típico: 1 dono + 1 gerente + 3 atendentes). Mínimo 1, sem
   * teto máximo — quem precisa de 500 usuários, precisa.
   *
   * ⚠️ NÃO confunde com `plan`: o plano é comercial, este limite é operacional.
   * O admin plataforma pode subir/descer sem mexer no plano, e o plano pode
   * mudar sem mexer no limite. A dupla vive separada por design.
   */
  seat_limit: z.coerce
    .number()
    .int()
    .min(1, "Mínimo 1 usuário")
    .max(10000, "Máximo 10.000 usuários")
    .optional(),
  owner_interface_settings: interfaceSettingsSchema.optional(),
  owner_email: z.string().trim().email(),
};
export const createTenantSchema = z
  .object({
    ...tenantCreationFields,
    plan: tenantCreationFields.plan.default("standard"),
    // Default 5 quando o body omite: cobre a esmagadora maioria das PMEs.
    // A coluna `seat_limit` no banco tem `not null default 5`, então o
    // RPC cria a org mesmo se o campo for null no body — o Zod só
    // documenta a intenção e uniformiza o caminho que vem do form.
    seat_limit: tenantCreationFields.seat_limit.default(5),
  })
  .refine(
    (v) => !v.owner_interface_settings || interfaceTemDestino(v.owner_interface_settings, "admin"),
    { message: "Selecione ao menos uma área de trabalho.", path: ["owner_interface_settings"] },
  );
