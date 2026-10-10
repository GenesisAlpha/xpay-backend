import { Injectable, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { supabase } from '../../lib/supabase.client';
import { StorageService } from '../../lib/storage.service';

// ============================================================================
// SPEI — validação do comprovante de transferência
// ----------------------------------------------------------------------------
// ⚠️⚠️ O QUE ISTO É, E O QUE ISTO NÃO É.
//
// NÃO É uma verificação de que o dinheiro chegou. Não existe verificação de
// que o dinheiro chegou: a Clip não tem endpoint de saldo, não manda webhook de
// transferência, e o SPEI aqui não passa pela API dela. A ÚNICA evidência que
// nos alcança é uma imagem que o próprio comprador escolheu enviar.
//
// O que isto é: uma leitura estruturada dessa imagem, comparada contra a
// reserva. Comprovante editado, comprovante de outra transferência e
// transferência estornada depois continuam passando — nenhuma leitura de
// imagem resolve isso, e prometer que resolve é o erro mais caro possível aqui.
//
// O backstop real é a DERIVA NO SAQUE (gw_spei_withdraw): aprovação sem
// dinheiro vira saldo que o extrato não confirma, e aparece como deriva
// negativa. Este serviço reduz fricção; o saque é que descobre a verdade.
//
// ─────────────────────────────────────────────────────────────────────────────
// O DESENHO: O MODELO EXTRAI, O CÓDIGO DECIDE.
//
// A tentação é mandar a imagem + os dados esperados e perguntar "isto confere?".
// Não faça. Duas razões, as duas fatais:
//
//   1. VIÉS DE CONFIRMAÇÃO. Um modelo que sabe que o valor esperado é
//      $1.247,63 encontra $1.247,63 numa imagem borrada. A extração aqui é
//      CEGA de propósito — o prompt não contém valor, CLABE nem beneficiário.
//   2. PERSUASÃO. "Isto é válido?" é uma pergunta de julgamento, e julgamento
//      é o que uma imagem bem feita ataca. "Que número está escrito aqui?" é
//      uma pergunta de leitura, muito mais difícil de virar.
//
// A comparação acontece em `avaliar()`, em código determinístico e auditável.
// Se você for mexer neste arquivo, essa é a linha que não pode cair.
// ============================================================================

const MODEL = process.env.SPEI_RECEIPT_MODEL ?? 'gpt-5.6-terra';

// ⚠️ EFFORT BAIXO É DELIBERADO, E É A MAIOR ALAVANCA DE CUSTO DESTE ARQUIVO.
// ~75% do custo por validação é token de SAÍDA, e a maior parte disso era
// raciocínio. Mas isto aqui é EXTRAÇÃO, não raciocínio: os campos são rotulados
// no documento ("Importe transferido", "Clave de rastreo"), o schema é estrito,
// e a decisão — que é onde o julgamento moraria — acontece em código, não no
// modelo. Pagar raciocínio profundo para ler um número rotulado é desperdício.
//
// Se a taxa de erro de LEITURA subir (mede-se em gw_spei_receipts.checks contra
// revisão humana), suba para 'medium' antes de trocar de modelo: o degrau de
// qualidade é maior e o de custo é menor.
const EFFORT = (process.env.SPEI_RECEIPT_EFFORT ?? 'low') as 'low' | 'medium' | 'high';

// ── Provedor de inferência ──────────────────────────────────────────────────
//
// 'fal'       → fal.run/fal-ai/any-llm/vision. Uma chave só, uma fatura só.
// 'openai'    → Responses API direta, com schema estrito.
//
// ⚠️ O FAL CUSTA TRÊS COISAS, E VOCÊ PRECISA SABER QUAIS ANTES DE ESCOLHER:
//
//   1. SEM SCHEMA ESTRITO. O any-llm devolve texto livre, então a garantia de
//      que voltam os 16 campos com os tipos certos e nulls explícitos deixa de
//      ser da API e passa a ser nossa (validarExtracao + 1 retry). É a perda
//      mais séria: num caminho que decide pagamento, schema imposto pela API é
//      diferente de schema pedido no prompt.
//   2. SEM CONTAGEM DE TOKENS. A resposta não traz usage, então
//      gw_spei_receipt_cost fica cega para estas linhas. Justo depois de você
//      pedir para medir custo — o custo do fal tem que sair da fatura dele.
//   3. A IMAGEM VAI POR URL. O bucket é privado, então assinamos uma URL curta
//      e mandamos para um terceiro. O arquivo sai do nosso perímetro.
//
const PROVIDER = (process.env.SPEI_RECEIPT_PROVIDER ?? 'openai') as 'fal' | 'openai';
// ⚠️ `openrouter/router/vision`, NÃO `fal-ai/any-llm/vision`.
// O any-llm está DEPRECIADO ("no longer supported") — construir o caminho de
// pagamento sobre um endpoint que o fornecedor já aposentou é dívida com data
// marcada. Além de ativo, o router resolve duas coisas que o any-llm não tinha:
//   • devolve `usage` COM `cost` real → o custo por comprovante deixa de ser
//     estimativa e vira medição (ver gw_spei_receipts.cost_usd)
//   • aceita `pdf_urls` → comprovante em PDF passa a ter caminho
const FAL_URL = process.env.SPEI_RECEIPT_FAL_URL ?? 'https://fal.run/openrouter/router/vision';
const FAL_MODEL = process.env.SPEI_RECEIPT_FAL_MODEL ?? 'openai/gpt-5.6-terra';

// Piso de confiança para aprovar sozinho. Abaixo disso vai para revisão humana
// — que NÃO é rejeição: é o pedido esperando um par de olhos.
const CONFIANCA_MINIMA = Number(process.env.SPEI_RECEIPT_MIN_CONFIDENCE ?? 0.85);

// ⚠️ JANELA: ÚLTIMAS 24 HORAS, E O LIMITE SUPERIOR É O QUE IMPORTA.
// A versão anterior aceitava data até 48h NO FUTURO — o que deixava passar
// transferência AGENDADA, que mostra valor certo, conta certa e dinheiro que
// ainda não saiu. Fechar o futuro é o que elimina esse caso sem precisar de um
// cheque separado de tipo de documento.
//
// ⚠️ A FOLGA PARA FRENTE COBRE FUSO, NÃO AGENDAMENTO.
// O México NÃO tem um fuso só. Desde o fim do horário de verão em 2022 são
// quatro: Centro (UTC-6), Pacífico (UTC-7), Noroeste (UTC-8) e Sureste
// (UTC-5 — Quintana Roo: Cancún, Playa del Carmen).
//
// Comprovante sem fuso é lido como Centro (o default abaixo). Para Quintana
// Roo isso o coloca 1 HORA NO FUTURO, e com folga de 10 min todo cliente de lá
// cairia em revisão manual, sempre, sem ninguém entender por quê.
//
// 2h cobre esse desvio mais relógio de celular adiantado. E não reabre a brecha
// do agendamento: transferência programada é marcada para DIAS à frente, não
// para daqui a 90 minutos.
const JANELA_MS = 24 * 60 * 60 * 1000;
const SKEW_FUTURO_MS = 2 * 60 * 60 * 1000;
// Fuso assumido quando o documento não declara nenhum. Os outros três ficam
// dentro da folga acima; assumir o Centro acerta a maioria do volume.
const FUSO_PADRAO = '-06:00';

const MAX_BYTES = 10 * 1024 * 1024;

// Bucket privado criado na migration. Só a service_role lê.
const RECEIPT_BUCKET = process.env.SPEI_RECEIPT_BUCKET ?? 'spei-receipts';

const MIME_ACEITOS = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Schema da extração. `strict` + `additionalProperties: false` garantem que o
// que volta é exatamente isto — sem campo inventado e sem prosa no meio.
// Todo campo é anulável: um comprovante ruim precisa poder dizer "não vi",
// porque um modelo obrigado a preencher um campo PREENCHE, e um valor
// alucinado num campo de dinheiro é pior que um nulo.
// ─────────────────────────────────────────────────────────────────────────────
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'es_comprobante', 'tipo_documento', 'monto', 'moneda', 'clabe_destino',
    'beneficiario', 'banco_destino', 'banco_emisor', 'fecha_hora', 'fecha_hora_texto',
    'clave_rastreo', 'referencia', 'estado_declarado', 'senales_de_edicion',
    'confianza_lectura', 'observaciones',
  ],
  properties: {
    es_comprobante: {
      type: 'boolean',
      description: 'true solo si el documento es un comprobante/recibo de una transferencia bancaria ya ejecutada.',
    },
    tipo_documento: {
      type: 'string',
      description: 'Qué es realmente el documento: comprobante_spei | captura_de_saldo | orden_no_ejecutada | otro.',
    },
    monto: {
      type: ['number', 'null'],
      description: 'Importe transferido, como número decimal en la moneda del documento. Ejemplo: 1247.63. null si no se lee con certeza.',
    },
    moneda: {
      type: ['string', 'null'],
      description: 'Copia el código tal cual aparece: MXN, MN (moneda nacional) o similar. null si el documento no muestra ninguno — es común que solo aparezca el símbolo $.',
    },
    clabe_destino: {
      type: ['string', 'null'],
      description: 'CLABE o cuenta DESTINO (a quién se envió), solo dígitos. Puede venir enmascarada; copia lo que se ve.',
    },
    beneficiario: {
      type: ['string', 'null'],
      description: 'Nombre o alias del destinatario tal como aparece. Suele ser el alias que el remitente guardó (ej. "Tik Tok Shop"), no la razón social.',
    },
    banco_destino: {
      type: ['string', 'null'],
      description: 'Institución DESTINO, si aparece: ej. "Clip", "Cuenta CLIP", "STP". No la confundas con el banco que emite el comprobante.',
    },
    banco_emisor: { type: ['string', 'null'], description: 'Banco o app que EMITE el comprobante (BBVA, Banorte, Banamex, Santander, Mercado Pago...).' },
    fecha_hora: {
      type: ['string', 'null'],
      description: 'Fecha y hora de la operación en ISO 8601 (YYYY-MM-DDTHH:MM:SS). El día va antes del mes en los formatos con barras (18/08/2026 = 18 de agosto). Algunos comprobantes separan fecha y hora en dos campos: combínalos. Incluye el huso SOLO si el documento lo muestra.',
    },
    fecha_hora_texto: {
      type: ['string', 'null'],
      description: 'La fecha y hora copiadas LITERALMENTE como aparecen, sin convertir. Permite auditar la conversión anterior.',
    },
    clave_rastreo: {
      type: ['string', 'null'],
      description: 'Clave de rastreo SPEI. Si se muestra partida en dos líneas, únela SIN espacios ni guiones. Si el documento no la trae (algunos la ocultan tras "Ver más detalles"), devuelve null — no uses el folio ni la referencia en su lugar.',
    },
    referencia: { type: ['string', 'null'] },
    estado_declarado: {
      type: ['string', 'null'],
      description: 'Estado que declara el documento: ej. "Completada", "En proceso", "Programada".',
    },
    senales_de_edicion: {
      type: 'array',
      items: { type: 'string' },
      description: 'Indicios objetivos de manipulación: tipografías inconsistentes, alineación rota, bordes de recorte, píxeles alrededor de las cifras, sombras que no coinciden. Lista vacía si no ves ninguno.',
    },
    confianza_lectura: {
      type: 'number',
      description: 'De 0 a 1: qué tan seguro estás de haber LEÍDO bien los campos (nitidez, oclusión, resolución). No es tu opinión sobre si el pago es legítimo.',
    },
    observaciones: { type: ['string', 'null'] },
  },
} as const;

// ⚠️ O prompt NÃO contém valor esperado, CLABE esperada nem beneficiário
// esperado. Ver a nota de VIÉS DE CONFIRMAÇÃO no topo.
const SYSTEM_PROMPT = `Eres un perito documental. Tu única tarea es LEER lo que el documento dice y reportarlo con exactitud.

REGLAS:
- Reporta únicamente lo que está escrito o es visualmente evidente. Nunca infieras, completes ni corrijas un dato.
- Si un campo no es legible o no aparece, devuélvelo como null. Un null es una respuesta correcta; un dato inventado no lo es.
- Copia los importes con TODOS sus decimales, exactamente como aparecen. Los centavos son significativos.
- Para la CLABE destino, copia los dígitos tal como se ven, incluso si están parcialmente enmascarados.
- Distingue un comprobante de una operación YA EJECUTADA de: una captura de saldo, una transferencia programada, una orden no confirmada o una pantalla de confirmación previa al envío. Solo la primera es un comprobante.
- En senales_de_edicion, reporta solo observaciones visuales objetivas. No especules sobre intención.
- NO son señales de edición y NUNCA debes reportarlas: la barra de estado del teléfono, el marco de WhatsApp o de otra app de mensajería, los botones del navegador, el modo oscuro, la compresión de la captura, ni el recorte de los bordes de la pantalla. Un comprobante reenviado por chat sigue siendo una captura normal.
- confianza_lectura mide tu certeza de LECTURA, no la legitimidad del pago.
- El destinatario suele aparecer como el ALIAS que el remitente guardó en su agenda ("Tik Tok Shop", "CLIP", un nombre propio). Cópialo tal cual; no intentes deducir la razón social real.

No emitas juicio sobre si el pago debe aceptarse. Esa decisión no es tuya.`;

export type ExtractedReceipt = {
  es_comprobante: boolean;
  tipo_documento: string;
  monto: number | null;
  moneda: string | null;
  clabe_destino: string | null;
  beneficiario: string | null;
  banco_destino: string | null;
  banco_emisor: string | null;
  fecha_hora: string | null;
  fecha_hora_texto: string | null;
  clave_rastreo: string | null;
  referencia: string | null;
  estado_declarado: string | null;
  senales_de_edicion: string[];
  confianza_lectura: number;
  observaciones: string | null;
};

export type ReceiptVerdict = {
  verdict: 'approved' | 'review' | 'rejected';
  confidence: number;
  checks: Record<string, boolean>;
  reasons: string[];
  extracted: ExtractedReceipt | null;
  receiptId?: string;
  captured?: boolean;
};

/** Clave de rastreo comparável: só letras e números, maiúscula. Curta demais não identifica nada. */
export function normalizarClave(value: unknown): string | null {
  const clave = String(value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return clave.length >= 8 ? clave : null;
}

@Injectable()
export class SpeiReceiptService {
  constructor(private readonly storage: StorageService) { }

  // ───────────────────────────────────────────────────────────────────────────
  // Entrada principal
  // ───────────────────────────────────────────────────────────────────────────

  async validate(args: {
    reservationId: string;
    /** Caminho no bucket privado ("spei-receipts/..."), ou URL completa para
     *  comprovantes de fora dele. É ISTO que fica gravado — nunca uma URL assinada. */
    fileRef: string;
    fileType?: string;
  }): Promise<ReceiptVerdict> {
    const reserva = await this.carregarReserva(args.reservationId);

    const { bytes, mime } = await this.baixar(args.fileRef, args.fileType);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

    // Dedupe barato ANTES de gastar uma chamada de modelo. Não substitui o
    // índice único do banco — aquele é a trava; este é só economia.
    const jaUsado = await this.arquivoJaAprovado(sha256, args.reservationId);
    if (jaUsado) {
      return this.registrarRecusa(args, reserva, sha256, mime, null, {
        verdict: 'rejected',
        confidence: 1,
        checks: { nao_duplicado: false },
        reasons: ['Este comprovante já foi usado para aprovar outro pedido.'],
      });
    }

    let extracted: ExtractedReceipt;
    let usage: { input: number | null; output: number | null };
    // Qual provedor/modelo de fato leu esta imagem. Gravado para que o custo e
    // a taxa de acerto possam ser comparados entre provedores depois.
    let modelo = MODEL;
    // Custo real da chamada, quando o provedor informa. Null no caminho
    // Anthropic (que devolve tokens, não custo) — ali gw_ai_cost_usd calcula.
    let custoUsd: number | null = null;
    try {
      const out = await this.extrair(bytes, mime, args.fileRef);
      extracted = out.extracted;
      usage = out.usage;
      modelo = (out as any).modelo ?? MODEL;
      custoUsd = (out as any).custoUsd ?? null;
    } catch (e: any) {
      // ⚠️ Falha do modelo NUNCA aprova e NUNCA rejeita.
      // Rejeitar por indisponibilidade puniria o comprador por um problema
      // nosso; aprovar seria liberar produto sem ler nada. Vai para a fila.
      console.error('[SpeiReceipt] extração falhou:', e?.message);
      return this.registrarRecusa(args, reserva, sha256, mime, null, {
        verdict: 'review',
        confidence: 0,
        checks: {},
        reasons: [`Não foi possível analisar o comprovante automaticamente: ${e?.message ?? 'erro'}`],
      });
    }

    const avaliacao = this.avaliar(extracted, reserva);

    if (avaliacao.verdict !== 'approved') {
      return this.registrarRecusa(args, reserva, sha256, mime, extracted, avaliacao, usage);
    }

    // ── UMA TRANSFERÊNCIA, UM PEDIDO ────────────────────────────────────────
    // O valor cobrado é o do pedido, sem centavo único (migration
    // 20261010120000): dois pedidos de $601 na mesma conta são iguais para as
    // três portas, e duas capturas DIFERENTES do mesmo comprovante passam pelo
    // dedupe de arquivo. Se esta transferência já aprovou outro pedido, quem
    // decide é uma pessoa — nunca aprovação automática, nunca recusa (a leitura
    // da clave varia, e duas pessoas podem pagar o mesmo valor no mesmo minuto).
    const repetida = await this.transferenciaJaUsada(extracted, reserva.account_id, args.reservationId);
    if (repetida) {
      return this.registrarRecusa(args, reserva, sha256, mime, extracted, {
        verdict: 'review',
        confidence: avaliacao.confidence,
        checks: { ...avaliacao.checks, transferencia_unica: false },
        reasons: [`Esta transferência parece já ter aprovado outro pedido (${repetida}). Confira no extrato antes de aprovar.`],
      }, usage);
    }

    // Aprovação e captura numa transação só — ver gw_spei_confirm_receipt.
    const { data, error } = await supabase.rpc('gw_spei_confirm_receipt', {
      p_reservation_id: args.reservationId,
      p_file_url: args.fileRef,
      p_file_sha256: sha256,
      p_file_type: mime,
      p_extracted: extracted,
      p_confidence: avaliacao.confidence,
      p_checks: avaliacao.checks,
      p_reasons: avaliacao.reasons,
      p_model: modelo,
      p_input_tokens: usage.input,
      p_output_tokens: usage.output,
      p_cost_usd: custoUsd,
      p_decided_by: 'ai',
    });

    if (error) {
      // Conflito de índice = corrida perdida: o mesmo arquivo (ou a mesma clave
      // de rastreo) aprovou outro pedido entre a checagem e a gravação. É
      // exatamente o caso que o índice parcial existe para pegar.
      if (/duplicate key|unique constraint/i.test(error.message)) {
        return this.registrarRecusa(args, reserva, sha256, mime, extracted, {
          verdict: 'rejected',
          confidence: 1,
          checks: { ...avaliacao.checks, nao_duplicado: false },
          reasons: ['Este comprovante já foi usado para aprovar outro pedido.'],
        }, usage);
      }
      console.error('[SpeiReceipt] gw_spei_confirm_receipt error:', error.message);
      throw new BadRequestException('Não foi possível registrar o comprovante. Tente novamente.');
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      ...avaliacao,
      extracted,
      receiptId: row?.receipt_id,
      captured: row?.captured ?? false,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // AS REGRAS — determinísticas, auditáveis, e a parte que não pode ser do modelo
  //
  // Cada linha de `checks` vira uma coluna de auditoria no banco. Se algum dia
  // alguém perguntar "por que este pedido foi liberado?", a resposta está aqui.
  // ───────────────────────────────────────────────────────────────────────────

  private avaliar(e: ExtractedReceipt, reserva: any): Omit<ReceiptVerdict, 'extracted'> {
    const checks: Record<string, boolean> = {};
    const reasons: string[] = [];

    // ── Duras: qualquer uma falhando impede aprovação automática ────────────

    checks.e_comprovante = e.es_comprobante === true
      && !/captura_de_saldo|orden_no_ejecutada/i.test(e.tipo_documento ?? '');
    if (!checks.e_comprovante) {
      reasons.push(`Documento não é comprovante de transferência executada (${e.tipo_documento ?? 'indefinido'}).`);
    }

    // ⚠️ O CHEQUE MAIS FORTE QUE TEMOS: valor EXATO, centavos inclusive.
    // Os centavos são únicos por pedido (ver gw_hold_spei). Sem eles, dois
    // pedidos do mesmo valor seriam indistinguíveis e este cheque não valeria
    // nada. Comparação em centavos inteiros — comparar float com float aqui
    // faria 1247.63 !== 1247.63 num dia ruim de arredondamento.
    const montoMinor = e.monto == null ? null : Math.round(e.monto * 100);
    const esperado = Number(reserva.charge_minor);
    checks.valor_exato = montoMinor === esperado;

    // ⚠️ CASO REAL: o Mercado Pago exibe "$ 99 MXN", sem os centavos, quando eles
    // são zero. Se algum app truncar os centavos de um valor que TEM centavos, o
    // comprovante legítimo bateria só nos pesos. Isso não é recusa — é dúvida:
    // vai para revisão em vez de queimar a venda. O peso inteiro tem que bater.
    const soPesosBate = montoMinor != null
      && montoMinor % 100 === 0
      && esperado % 100 !== 0
      && Math.floor(montoMinor / 100) === Math.floor(esperado / 100);
    checks.valor_sem_centavos = soPesosBate;

    if (!checks.valor_exato) {
      reasons.push(
        `Valor não confere: comprovante ${this.fmt(montoMinor)} vs. esperado ${this.fmt(esperado)}`
        + (soPesosBate ? ' (pesos batem; centavos ausentes no documento).' : '.'),
      );
    }

    // ⚠️ "MN" (moneda nacional) é como o app do Banorte escreve peso mexicano, e
    // muitos comprovantes não trazem código nenhum — só o símbolo $. Exigir
    // literalmente "MXN" reprovava comprovante legítimo de banco grande.
    checks.moeda_ok = this.moedaConfere(e.moneda, reserva.currency);
    if (!checks.moeda_ok) reasons.push(`Moeda diferente: ${e.moneda}.`);

    // CLABE costuma vir mascarada no app do banco. Exigir os 18 dígitos
    // rejeitaria comprovante legítimo; os últimos 4 são o que sempre aparece.
    checks.clabe_confere = this.clabeConfere(e.clabe_destino, reserva.clabe);
    if (!checks.clabe_confere) {
      reasons.push(`CLABE destino não confere com a conta da reserva.`);
    }

    checks.data_na_janela = this.dataNaJanela(e.fecha_hora);
    if (!checks.data_na_janela) {
      reasons.push(`Data fora das últimas 24h (${e.fecha_hora_texto ?? e.fecha_hora ?? 'sem data'}).`);
    }

    checks.sem_sinais_de_edicao = (e.senales_de_edicion?.length ?? 0) === 0;
    if (!checks.sem_sinais_de_edicao) {
      reasons.push(`Indícios de edição: ${e.senales_de_edicion.join('; ')}.`);
    }

    checks.leitura_confiavel = (e.confianza_lectura ?? 0) >= CONFIANCA_MINIMA;
    if (!checks.leitura_confiavel) {
      reasons.push(`Leitura do documento pouco confiável (${e.confianza_lectura}).`);
    }

    // ── Brandas: não bloqueiam sozinhas, mas entram no registro ─────────────

    // ⚠️ INFORMATIVO, NUNCA PORTA — E ISSO FOI APRENDIDO NA MARRA.
    // Rodando as regras contra 8 comprovantes reais, este cheque reprovou 7.
    // O motivo: o nome que aparece é o APELIDO que o remetente salvou na agenda
    // dele — "Breah", "Tik Tok Shop", "tiktok", "CLIP" — e não o titular da
    // conta. O próprio Banorte imprime no comprovante: "El nombre del
    // beneficiario de esta operación es un dato no verificado por la
    // institución". Ou seja, o banco avisa que o campo não vale como prova, e
    // nós estávamos usando ele como se valesse.
    // Fica registrado porque ajuda o humano na revisão. Não decide nada.
    checks.beneficiario_confere = this.nomeConfere(e.beneficiario, reserva.beneficiario);

    // O que de fato corrobora: o DESTINO ser Clip. Aparece em quase todo
    // comprovante ("Cuenta CLIP", "Clip • TIKTOK SHOP", "Clip - CLABE").
    const alvo = `${e.banco_destino ?? ''} ${e.beneficiario ?? ''}`;
    checks.destino_clip = /clip/i.test(alvo);
    if (!checks.destino_clip) {
      reasons.push(`Destino não identificado como Clip (banco: "${e.banco_destino ?? '—'}", beneficiário: "${e.beneficiario ?? '—'}").`);
    }

    // Registrada, nunca usada para decidir nem para deduplicar: a leitura de 24
    // dígitos varia entre chamadas do modelo, e valor instável em regra dura
    // recusa pagamento bom. Serve ao revisor humano e a uma futura consulta CEP.
    checks.tem_clave_rastreo = !!e.clave_rastreo;

    checks.estado_completado = !e.estado_declarado
      || /complet|exitos|aplicad|realizad|liquidad/i.test(e.estado_declarado);
    if (!checks.estado_completado) {
      reasons.push(`Estado declarado no comprovante: "${e.estado_declarado}".`);
    }

    // ── Veredito ────────────────────────────────────────────────────────────
    //
    // Rejeição é reservada para o que CONTRADIZ a reserva de forma dura: não é
    // comprovante, ou o valor não bate. Todo o resto vai para revisão humana.
    //
    // A assimetria é deliberada: rejeitar um pagamento verdadeiro custa a venda
    // E o cliente; mandar para revisão custa alguns minutos de alguém. Quando
    // as duas opções são incertas, a fila é sempre a mais barata.
    // ── AS PORTAS ───────────────────────────────────────────────────────────
    //
    // Três critérios definidos pelo dono da operação: VALOR exato, ÚLTIMOS
    // DÍGITOS da conta destino, e DATA dentro das últimas 24h. Tudo o mais
    // continua sendo lido e gravado, mas não decide nada.
    //
    // Dois cheques que ficaram junto, e o motivo de cada um:
    //
    //   leitura_confiavel — não é um quarto critério; é a confiança do modelo
    //     nos três acima. Se ele diz que não conseguiu ler bem, o valor que ele
    //     reportou não sustenta o cheque de valor.
    //   moeda_ok — só dispara quando o documento DECLARA outra moeda. SPEI é
    //     peso, então nunca dispara em tráfego legítimo (MN e ausência de código
    //     passam), mas um comprovante de 399 USD aprovando um pedido de 399 MXN
    //     é perda de ~20x. Custo zero, proteção real.
    //
    // O que SAIU das portas e por quê:
    //   e_comprovante        — coberto: documento que não é comprovante não tem
    //                          valor a extrair, e cai no cheque de valor.
    //                          Agendamento cai na janela de 24h (data futura).
    //   sem_sinais_de_edicao — falso positivo demais (frame de WhatsApp, barra
    //                          de status) e um falsificador competente não deixa
    //                          artefato visível de qualquer forma.
    //   beneficiario_confere — o banco imprime que o campo não é verificado.
    //   destino_clip         — redundante: quem carrega a identificação da conta
    //                          é o cheque dos últimos dígitos.
    const duras = [
      'valor_exato', 'clabe_confere', 'data_na_janela',
      'leitura_confiavel', 'moeda_ok',
    ];
    const brandas: string[] = [];

    const todasDuras = duras.every(k => checks[k]);
    const todasBrandas = brandas.every(k => checks[k]);

    let verdict: ReceiptVerdict['verdict'];
    if (!checks.e_comprovante || (!checks.valor_exato && !checks.valor_sem_centavos)) {
      verdict = 'rejected';
    } else if (todasDuras && todasBrandas) {
      verdict = 'approved';
    } else {
      verdict = 'review';
    }

    return { verdict, confidence: e.confianza_lectura ?? 0, checks, reasons };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Chamada ao modelo
  // ───────────────────────────────────────────────────────────────────────────

  // Despacha para o provedor configurado. A assinatura é a mesma nos dois
  // caminhos, então validarExtracao() e avaliar() não sabem qual rodou — e a
  // decisão continua idêntica, seja quem for que leu a imagem.
  private async extrair(bytes: Buffer, mime: string, ref: string) {
    return PROVIDER === 'fal'
      ? this.extrairViaFal(ref, mime)
      : this.extrairViaOpenAi(bytes, mime);
  }

  // ── fal.ai ────────────────────────────────────────────────────────────────
  //
  // O any-llm não impõe schema, então o schema vai NO PROMPT e a garantia passa
  // a ser nossa. Uma tentativa extra em caso de JSON inválido — mais que isso é
  // pagar duas vezes por um modelo que não está colaborando.
  private async extrairViaFal(ref: string, mime: string) {
    const apiKey = process.env.FAL_KEY;
    if (!apiKey) throw new Error('FAL_KEY ausente');

    // ⚠️ URL ASSINADA E CURTA. O bucket é privado e o arquivo vai para um
    // terceiro; 5 min é o suficiente para o fal buscar e não deixa um link
    // vivo circulando depois.
    const imageUrl = /^https?:\/\//i.test(ref)
      ? ref
      : await this.storage.getSignedSpeiReceiptUrl(ref.replace(/^spei-receipts\//, ''), 300);
    if (!imageUrl) throw new Error('não foi possível assinar a URL do comprovante');

    // Sem schema imposto pela API, o schema vai no prompt. O system_prompt vai
    // separado, como no caminho Anthropic — mantém os dois provedores lendo a
    // mesma instrução, o que é o que torna a comparação entre eles honesta.
    const instrucao = `Lee este documento y reporta los campos.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto antes ni después, sin bloques de código.
El objeto debe tener EXACTAMENTE estas claves:
${JSON.stringify(EXTRACTION_SCHEMA.properties, null, 1)}`;

    // PDF vai em pdf_urls; imagem em image_urls. Mandar PDF como imagem faz o
    // router recusar, e é o caso do comprovante que o banco gera para download.
    const anexo = mime === 'application/pdf'
      ? { pdf_urls: [imageUrl] }
      : { image_urls: [imageUrl] };

    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const res = await fetch(FAL_URL, {
        method: 'POST',
        headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: FAL_MODEL, prompt: instrucao, system_prompt: SYSTEM_PROMPT, ...anexo,
        }),
      });

      const payload: any = await res.json().catch(() => null);
      if (!res.ok || payload?.error) {
        throw new Error(`fal HTTP ${res.status}: ${payload?.error ?? 'sem detalhe'}`);
      }

      // Modelos costumam devolver o JSON dentro de ```json … ```.
      const bruto = String(payload?.output ?? '').trim()
        .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      try {
        const obj = JSON.parse(bruto);
        return {
          extracted: this.validarExtracao(obj),
          usage: {
            input: payload?.usage?.prompt_tokens ?? null,
            output: payload?.usage?.completion_tokens ?? null,
          },
          // Custo REAL cobrado pelo fal nesta requisição, já com o markup deles.
          // Melhor que derivar de tokens: a tabela de preços é do fornecedor e
          // muda sem avisar, o número que ele devolve não.
          custoUsd: typeof payload?.usage?.cost === 'number' ? payload.usage.cost : null,
          modelo: `fal:${FAL_MODEL}`,
        };
      } catch (e: any) {
        if (tentativa === 2) throw new Error(`fal devolveu JSON inválido: ${e?.message}`);
      }
    }
    throw new Error('fal: extração falhou');
  }

  // ⚠️ SEM O SCHEMA DA API, ESTA FUNÇÃO É A ÚNICA GARANTIA DE FORMA.
  // Campo ausente vira null (não undefined, que sumiria do JSONB gravado);
  // tipo errado vira null em vez de propagar. Um `monto` que chegou como
  // string "1,247.63" e virasse NaN silenciosamente aprovaria o valor errado.
  private validarExtracao(o: any): ExtractedReceipt {
    const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    // ⚠️ DINHEIRO EM TEXTO LIVRE, DUAS CONVENÇÕES OPOSTAS.
    // "1,247.63" (vírgula = milhar) e "1.247,63" (ponto = milhar) são o MESMO
    // valor escrito de dois jeitos, e comprovantes mexicanos trazem os dois.
    // A regra que desempata: olha o ÚLTIMO separador e conta os dígitos depois
    // dele. Exatamente 3 → é separador de milhar. 1 ou 2 → é decimal. Dinheiro
    // não tem 3 casas decimais, então isso não é heurística, é a gramática.
    const num = (v: any): number | null => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : null;
      if (typeof v !== 'string') return null;

      const limpo = v.replace(/[^\d.,-]/g, '');
      // Sem nenhum dígito não é "zero", é ilegível. Devolver 0 gravaria no
      // registro que lemos $0,00 — uma afirmação falsa sobre um comprovante
      // que ninguém conseguiu ler. Null manda para revisão, que é a verdade.
      if (!/\d/.test(limpo)) return null;

      const iVirgula = limpo.lastIndexOf(',');
      const iPonto = limpo.lastIndexOf('.');
      const iUltimo = Math.max(iVirgula, iPonto);

      let normalizado: string;
      if (iUltimo === -1) {
        normalizado = limpo;
      } else if (limpo.length - iUltimo - 1 === 3) {
        // 3 dígitos depois → milhar. Some com todos os separadores.
        normalizado = limpo.replace(/[.,]/g, '');
      } else {
        // Decimal: apaga o outro separador e padroniza em ponto.
        normalizado = iVirgula > iPonto
          ? limpo.replace(/\./g, '').replace(',', '.')
          : limpo.replace(/,/g, '');
      }

      const n = Number(normalizado);
      return Number.isFinite(n) ? n : null;
    };
    return {
      es_comprobante: o?.es_comprobante === true,
      tipo_documento: str(o?.tipo_documento) ?? 'otro',
      monto: num(o?.monto),
      moneda: str(o?.moneda),
      clabe_destino: str(o?.clabe_destino),
      beneficiario: str(o?.beneficiario),
      banco_destino: str(o?.banco_destino),
      banco_emisor: str(o?.banco_emisor),
      fecha_hora: str(o?.fecha_hora),
      fecha_hora_texto: str(o?.fecha_hora_texto),
      clave_rastreo: str(o?.clave_rastreo),
      referencia: str(o?.referencia),
      estado_declarado: str(o?.estado_declarado),
      senales_de_edicion: Array.isArray(o?.senales_de_edicion)
        ? o.senales_de_edicion.filter((x: any) => typeof x === 'string') : [],
      // Sem confiança declarada, assume BAIXA: manda para revisão em vez de
      // aprovar por omissão. É o default que erra para o lado recuperável.
      confianza_lectura: typeof o?.confianza_lectura === 'number' ? o.confianza_lectura : 0,
      observaciones: str(o?.observaciones),
    };
  }

  private async extrairViaOpenAi(bytes: Buffer, mime: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY ausente');
    const b64 = bytes.toString('base64');
    const attachment = mime === 'application/pdf'
      ? { type: 'input_file', filename: 'comprobante.pdf', file_data: `data:application/pdf;base64,${b64}` }
      : { type: 'input_image', image_url: `data:${mime};base64,${b64}`, detail: 'high' };
    const http = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        instructions: SYSTEM_PROMPT,
        input: [{ role: 'user', content: [attachment, { type: 'input_text', text: 'Lee este documento y reporta los campos del esquema.' }] }],
        reasoning: { effort: EFFORT },
        max_output_tokens: 4096,
        store: false,
        text: { format: { type: 'json_schema', name: 'spei_receipt', strict: true, schema: EXTRACTION_SCHEMA } },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const response: any = await http.json().catch(() => null);
    if (!http.ok) throw new Error(`OpenAI HTTP ${http.status}: ${response?.error?.message ?? 'sem detalhe'}`);
    const texto = String(response?.output_text ?? response?.output?.flatMap((item: any) => item.content ?? [])
      .filter((item: any) => item.type === 'output_text').map((item: any) => item.text ?? '').join('') ?? '');

    if (!texto.trim()) throw new Error('resposta vazia do modelo');

    return {
      // Passa pelo MESMO validador do caminho fal. A API já garante o schema
      // aqui, mas normalizar nos dois lados significa que avaliar() recebe
      // exatamente a mesma forma venha de onde vier — e que trocar de provedor
      // não muda a decisão por um detalhe de tipo.
      extracted: this.validarExtracao(JSON.parse(texto)),
      usage: {
        input: response?.usage?.input_tokens ?? null,
        output: response?.usage?.output_tokens ?? null,
      },
      modelo: MODEL,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Auxiliares
  // ───────────────────────────────────────────────────────────────────────────

  private async carregarReserva(reservationId: string) {
    const { data: r, error } = await supabase
      .from('gw_reservations')
      .select('id, method, account_id, state, charge_minor, currency, created_at, expires_at')
      .eq('id', reservationId)
      .maybeSingle();

    if (error) throw new BadRequestException(`Reserva inacessível: ${error.message}`);
    if (!r) throw new BadRequestException('Reserva de pagamento não encontrada.');
    if (r.method !== 'spei') throw new BadRequestException('Esta reserva não é de transferência SPEI.');

    const { data: acc } = await supabase
      .from('gw_spei_accounts')
      .select('clabe, banco, beneficiario')
      .eq('id', r.account_id)
      .maybeSingle();

    return { ...r, ...(acc ?? {}) };
  }

  /**
   * A mesma transferência já aprovou outro pedido desta conta? Devolve o motivo
   * ("mesma clave de rastreo" / "mesma data, hora e valor") ou null.
   *
   * Só olha comprovantes APROVADOS dos últimos 7 dias, de OUTRA reserva. Falha
   * de leitura do banco devolve null: a checagem é uma trava a mais, e travar a
   * fila inteira por indisponibilidade seria pior que seguir com as três portas.
   */
  private async transferenciaJaUsada(e: ExtractedReceipt, accountId: string, exceptReservation: string): Promise<string | null> {
    const clave = normalizarClave(e.clave_rastreo);
    const quando = e.fecha_hora ? String(e.fecha_hora).trim() : '';
    if (!clave && !(quando && e.monto != null)) return null;

    const { data, error } = await supabase
      .from('gw_spei_receipts')
      .select('reservation_id, extracted')
      .eq('account_id', accountId)
      .eq('verdict', 'approved')
      .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) {
      console.error('[SpeiReceipt] checagem de transferência repetida:', error.message);
      return null;
    }

    for (const row of (data ?? []) as { reservation_id: string; extracted: any }[]) {
      if (row.reservation_id === exceptReservation) continue;
      const outro = row.extracted ?? {};
      if (clave && normalizarClave(outro.clave_rastreo) === clave) return 'mesma clave de rastreo';
      if (quando && e.monto != null
        && String(outro.fecha_hora ?? '').trim() === quando
        && Number(outro.monto) === Number(e.monto)) return 'mesma data, hora e valor';
    }
    return null;
  }

  private async arquivoJaAprovado(sha256: string, exceptReservation: string) {
    const { data } = await supabase
      .from('gw_spei_receipts')
      .select('id, reservation_id')
      .eq('file_sha256', sha256)
      .eq('verdict', 'approved')
      .limit(1);
    return (data ?? []).some(r => r.reservation_id !== exceptReservation);
  }

  // ⚠️ RECEBE O CAMINHO NO STORAGE, NÃO UMA URL ASSINADA.
  // O bucket `spei-receipts` é privado. Uma URL assinada até funcionaria aqui,
  // mas ela EXPIRA — e é justamente ela que ficaria gravada em
  // gw_spei_receipts.file_url. No dia em que alguém abrisse a fila de revisão,
  // o link estaria morto e o comprovante que justificou a aprovação seria
  // impossível de recuperar. Guardamos o caminho; o CRM assina na hora de olhar.
  //
  // Uma URL http(s) completa ainda é aceita, para comprovantes que venham de
  // fora deste bucket (o fluxo antigo do tkt-page grava em `comprobantes`).
  private async baixar(ref: string, declaredType?: string) {
    const buf = /^https?:\/\//i.test(ref)
      ? await this.baixarPorUrl(ref)
      : await this.baixarDoStorage(ref);
    if (buf.length === 0) throw new BadRequestException('Arquivo de comprovante vazio.');
    if (buf.length > MAX_BYTES) throw new BadRequestException('Comprovante maior que 10MB.');

    // ⚠️ O tipo vem do CONTEÚDO, não do Content-Type nem da extensão. Os dois
    // últimos são declarados por quem enviou o arquivo — e mandar um binário
    // arbitrário rotulado como image/png é a forma mais direta de empurrar algo
    // inesperado para dentro do pipeline.
    const mime = this.sniff(buf) ?? (MIME_ACEITOS.has(declaredType ?? '') ? declaredType! : null);
    if (!mime || !MIME_ACEITOS.has(mime)) {
      throw new BadRequestException('Formato não aceito. Envie JPG, PNG, WEBP ou PDF.');
    }
    return { bytes: buf, mime };
  }

  private async baixarDoStorage(ref: string): Promise<Buffer> {
    // "spei-receipts/2026/08/abc.jpg" → bucket + caminho relativo.
    const i = ref.indexOf('/');
    const bucket = i === -1 ? RECEIPT_BUCKET : ref.slice(0, i);
    const caminho = i === -1 ? ref : ref.slice(i + 1);

    const { data, error } = await supabase.storage.from(bucket).download(caminho);
    if (error || !data) {
      throw new BadRequestException(`Comprovante inacessível no storage: ${error?.message ?? 'não encontrado'}`);
    }
    return Buffer.from(await data.arrayBuffer());
  }

  private async baixarPorUrl(url: string): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e: any) {
      throw new BadRequestException(`Não foi possível baixar o comprovante: ${e?.message}`);
    }
    if (!res.ok) throw new BadRequestException(`Comprovante inacessível (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  private sniff(b: Buffer): string | null {
    if (b.length < 12) return null;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (b.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    if (b.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
    return null;
  }

  // MXN, MN (moneda nacional) e ausência de código são todos aceitáveis para
  // peso mexicano. Só rejeita quando o documento declara OUTRA moeda.
  private moedaConfere(lida: string | null, esperada: string): boolean {
    if (!lida) return true;
    const a = lida.toUpperCase().replace(/[^A-Z]/g, '');
    // ⚠️ "$" NÃO É CÓDIGO DE MOEDA — é símbolo, e não diz nada.
    // Um modelo devolveu literalmente '$' neste campo, e a versão anterior
    // reprovava por "moeda diferente", mandando para revisão um comprovante
    // que apenas não declarava moeda nenhuma (o caso mais comum: metade dos
    // comprovantes reais só mostra o cifrão). Sobrou zero letra = não declarou.
    if (!a) return true;
    const b = String(esperada).toUpperCase();
    if (a === b) return true;
    return b === 'MXN' && (a === 'MN' || a === 'MXP' || a === 'PESOS');
  }

  private clabeConfere(lida: string | null, esperada: string | undefined): boolean {
    if (!lida || !esperada) return false;
    const a = lida.replace(/\D/g, '');
    const b = String(esperada).replace(/\D/g, '');
    if (!a || !b) return false;
    if (a === b) return true;
    // ⚠️ 3 DÍGITOS, NÃO 4. O Banamex mascara a conta destino como "**869" —
    // três dígitos apenas. Exigir quatro reprovava um banco inteiro. Com três,
    // a colisão é 1/1000, o que só importa se houver muitas contas Clip; o
    // valor exato e a janela de data carregam o peso da identificação.
    return a.length >= 3 && b.endsWith(a);
  }

  private nomeConfere(lido: string | null, esperado: string | undefined): boolean {
    if (!lido || !esperado) return false;
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/[^A-Z\s]/g, '').trim().split(/\s+/).filter(Boolean);
    const a = norm(lido), b = norm(esperado);
    if (!a.length || !b.length) return false;
    // O banco costuma truncar ou abreviar o nome. Dois sobrenomes em comum é o
    // sinal utilizável; exigir igualdade de string reprovaria quase todo
    // comprovante verdadeiro.
    const comuns = a.filter(p => p.length > 2 && b.includes(p));
    return comuns.length >= Math.min(2, b.filter(p => p.length > 2).length);
  }

  // ⚠️ NENHUM COMPROVANTE MEXICANO TRAZ FUSO HORÁRIO.
  // Todos os 8 comprovantes reais mostram só "19 ago 2026, 23:35 h". Sem
  // offset, Date.parse usa o fuso do PROCESSO — que em produção é UTC. Isso
  // desloca a leitura em 6 horas e joga comprovante legítimo para fora da
  // janela (ou, pior, aceita um que está fora). Falta de offset significa hora
  // local de Cidade do México, que é UTC-6 o ano inteiro desde 2022.
  private dataNaJanela(iso: string | null): boolean {
    if (!iso) return false;
    const temFuso = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
    const t = Date.parse(temFuso ? iso : `${iso.trim()}${FUSO_PADRAO}`);
    if (Number.isNaN(t)) return false;
    const agora = Date.now();
    return t <= agora + SKEW_FUTURO_MS && t >= agora - JANELA_MS;
  }

  private fmt(minor: number | null): string {
    if (minor == null) return 'ilegível';
    return `$${(minor / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })}`;
  }

  private async registrarRecusa(
    args: { reservationId: string; fileRef: string },
    _reserva: any,
    sha256: string,
    mime: string,
    extracted: ExtractedReceipt | null,
    avaliacao: Omit<ReceiptVerdict, 'extracted'>,
    usage?: { input: number | null; output: number | null },
    custoUsd?: number | null,
  ): Promise<ReceiptVerdict> {
    const { data, error } = await supabase.rpc('gw_spei_log_receipt', {
      p_reservation_id: args.reservationId,
      p_file_url: args.fileRef,
      p_file_sha256: sha256,
      p_file_type: mime,
      p_extracted: extracted ?? {},
      p_verdict: avaliacao.verdict,
      p_confidence: avaliacao.confidence,
      p_checks: avaliacao.checks,
      p_reasons: avaliacao.reasons,
      p_model: MODEL,
      p_input_tokens: usage?.input ?? null,
      p_output_tokens: usage?.output ?? null,
      p_cost_usd: custoUsd,
    });

    if (error) console.error('[SpeiReceipt] gw_spei_log_receipt error:', error.message);

    return { ...avaliacao, extracted, receiptId: (data as any) ?? undefined, captured: false };
  }
}
