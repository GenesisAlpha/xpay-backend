// Códigos da Clip vistos em produção → texto para o painel. O código fica cru
// em failure_code; a mensagem explica em português.
const CLIP_FAILURE_TEXT: Record<string, string> = {
    'CA-AUT01': '3DS não concluído: o comprador não terminou a verificação do banco e a Clip cancelou',
    'RE-3DS01': 'O banco reprovou a verificação 3DS',
    'RE-ISS02': 'Recusado pelo banco emissor (do not honor)',
}

export function clipFailureReason(code?: string | null, message?: string | null) {
    const c = typeof code === 'string' && code.trim() ? code.trim().slice(0, 40) : null
    const m = typeof message === 'string' && message.trim() ? message.trim() : null
    if (!c && !m) return null
    const text = (c && CLIP_FAILURE_TEXT[c]) || m || c
    return {
        failure_code: c ?? 'clip_failed',
        failure_message: `Clip ${c ?? ''}${m && m !== text ? ` (${m})` : ''}: ${text}`.replace(/\s+:/, ':').slice(0, 500),
    }
}
