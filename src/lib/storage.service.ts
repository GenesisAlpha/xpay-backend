import { Injectable, BadRequestException } from '@nestjs/common';
import { supabase } from '../lib/supabase.client';

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 3 * 1024 * 1024; // 3 MB
const BUCKET = 'avatars';

@Injectable()
export class StorageService {
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
}