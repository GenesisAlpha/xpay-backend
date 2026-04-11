import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export class UserController {
  
  static async getMe(req: Request, res: Response) {
    try {
      const user_id = (req as any).user.id;
      const user = await prisma.user.findUnique({
        where: { id: user_id },
        // Removido o notification_prefs daqui
        select: { id: true, username: true, email: true, role: true, kyc_level: true, webhook_url: true, webhook_secret: true }
      });
      res.json({ data: user });
    } catch (e: any) { res.status(500).json({ error: "Erro ao procurar perfil" }); }
  }

  static async updateMe(req: Request, res: Response) {
    try {
      const user_id = (req as any).user.id;
      // Removido o notification_prefs daqui
      const { email, webhook_url } = req.body; 
      
      const currentUser = await prisma.user.findUnique({ where: { id: user_id } });
      
      let newSecret = currentUser?.webhook_secret;
      if (webhook_url && !newSecret) {
         newSecret = "whsec_" + crypto.randomBytes(32).toString('hex');
      }

      const updated = await prisma.user.update({
        where: { id: user_id },
        data: {
          ...(email !== undefined && { email }),
          ...(webhook_url !== undefined && { webhook_url }),
          ...(newSecret !== undefined && { webhook_secret: newSecret })
        },
        // Removido o notification_prefs daqui
        select: { id: true, email: true, webhook_url: true, webhook_secret: true }
      });
      
      res.json({ success: true, data: updated, message: "Perfil atualizado com sucesso." });
    } catch (e: any) { res.status(500).json({ error: "Erro ao atualizar perfil" }); }
  }

  static async updatePassword(req: Request, res: Response) {
    try {
      const user_id = (req as any).user.id;
      const { old_password, new_password } = req.body;
      
      const user = await prisma.user.findUnique({ where: { id: user_id } });
      if (!user || user.password_hash !== old_password) {
        return res.status(400).json({ error: "Senha atual incorreta." });
      }

      await prisma.user.update({ where: { id: user_id }, data: { password_hash: new_password } });
      res.json({ success: true, message: "Senha alterada com sucesso." });
    } catch (e: any) { res.status(500).json({ error: "Erro ao alterar senha" }); }
  }
}
