import { Injectable, BadRequestException } from '@nestjs/common';
import { supabase } from '../lib/supabase.client';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB
const BUCKET = 'avatars';

// ─── Documentos do onboarding (bucket PRIVADO) ────────────────────────────────
const DOC_BUCKET = 'seller-documents';
const DOC_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const DOC_MAX_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
const DOC_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};
const SPEI_RECEIPT_BUCKET = 'spei-receipts';

@Injectable()
export class StorageService {
  async uploadSpeiReceipt({ sellerId, transactionId, base64, mime }: {
    sellerId: string; transactionId: string; base64: string; mime: string;
  }): Promise<string> {
    if (!DOC_ALLOWED_MIME.includes(mime)) {
      throw new BadRequestException('Comprovante inválido. Use JPEG, PNG, WebP ou PDF.');
    }
    const cleanBase64 = base64.includes(',') ? base64.split(',').pop()! : base64;
    const buffer = Buffer.from(cleanBase64, 'base64');
    if (!buffer.length || buffer.byteLength > DOC_MAX_SIZE_BYTES) {
      throw new BadRequestException('Comprovante vazio ou maior que 8 MB.');
    }
    const path = `${sellerId}/${transactionId}/comprovante.${DOC_EXT[mime]}`;
    const { error } = await supabase.storage.from(SPEI_RECEIPT_BUCKET).upload(path, buffer, {
      contentType: mime, upsert: true,
    });
    if (error) throw new BadRequestException('Erro ao salvar comprovante: ' + error.message);
    return path;
  }

  async getSignedSpeiReceiptUrl(path: string | null | undefined, expiresIn = 3600) {
    if (!path) return null;
    const { data, error } = await supabase.storage.from(SPEI_RECEIPT_BUCKET).createSignedUrl(path, expiresIn);
    return error || !data ? null : data.signedUrl;
  }

  async uploadAvatar({
    userId,
    base64,
    mime,
  }: {
    userId: string;
    base64: string;
    mime: string;
  }): Promise<string> {
    if (!ALLOWED_MIME.includes(mime)) {
      throw new BadRequestException('Formato de imagem não suportado. Use JPEG, PNG ou WebP.');
    }

    const buffer = Buffer.from(base64, 'base64');

    if (buffer.byteLength > MAX_SIZE_BYTES) {
      throw new BadRequestException('Imagem muito grande. Máximo 3 MB.');
    }

    const ext = mime.split('/')[1];
    const path = `${userId}/avatar.${ext}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType: mime,
        upsert: true, // sobrescreve se já existir
      });

    if (error) {
      throw new BadRequestException('Erro ao fazer upload da imagem: ' + error.message);
    }

    const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);

    return data.publicUrl;
  }

  // =========================================
  // DOCUMENTOS DO ONBOARDING (bucket privado)
  // =========================================
  /**
   * Faz upload de um documento no bucket PRIVADO e retorna o PATH (não a URL).
   * Path: `${userId}/${field}.${ext}` — upsert sobrescreve se reenviar.
   */
  async uploadDocument({
    userId,
    field,
    base64,
    mime,
  }: {
    userId: string;
    field: string;
    base64: string;
    mime: string;
  }): Promise<string> {
    if (!DOC_ALLOWED_MIME.includes(mime)) {
      throw new BadRequestException('Formato não suportado. Use JPEG, PNG, WebP ou PDF.');
    }

    const buffer = Buffer.from(base64, 'base64');

    if (buffer.byteLength > DOC_MAX_SIZE_BYTES) {
      throw new BadRequestException('Arquivo muito grande. Máximo 8 MB.');
    }

    const ext = DOC_EXT[mime];
    const path = `${userId}/${field}.${ext}`;

    const { error } = await supabase.storage
      .from(DOC_BUCKET)
      .upload(path, buffer, {
        contentType: mime,
        upsert: true,
      });

    if (error) {
      throw new BadRequestException('Erro ao fazer upload do documento: ' + error.message);
    }

    return path;
  }

  /**
   * Gera uma signed URL temporária para um documento do bucket privado.
   * Retorna null se o path for vazio ou se o Supabase falhar.
   */
  async getSignedDocumentUrl(path: string | null | undefined, expiresIn = 3600): Promise<string | null> {
    if (!path) return null;

    const { data, error } = await supabase.storage
      .from(DOC_BUCKET)
      .createSignedUrl(path, expiresIn);

    if (error || !data) return null;
    return data.signedUrl;
  }

  /**
   * Baixa um documento do bucket privado. Usado para mandar documento e selfie
   * à verificação da Whop — o arquivo nunca sai por URL, nem assinada.
   * Retorna null se o path for vazio ou se o Supabase falhar.
   */
  async downloadDocument(
    path: string | null | undefined,
  ): Promise<{ base64: string; mime: string; byteLength: number } | null> {
    if (!path) return null;

    const { data, error } = await supabase.storage.from(DOC_BUCKET).download(path);
    if (error || !data) return null;

    const buffer = Buffer.from(await data.arrayBuffer());
    return {
      base64: buffer.toString('base64'),
      mime: data.type || 'application/octet-stream',
      byteLength: buffer.byteLength,
    };
  }
}
