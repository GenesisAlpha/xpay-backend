import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import * as express from 'express';


async function bootstrap() {

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // =========================================
  // 🔐 CORS (PRIMEIRO — garante o header até em respostas de erro,
  //    ex.: 413 Payload Too Large antes do bodyParser)
  // =========================================
  app.enableCors({
    origin: true,          // reflete a origem (compatível com credentials, ao contrário de '*')
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization,Idempotency-Key,X-Sentinel-Signature',
  });

  // 🐞 DEBUG TEMPORÁRIO — timestamp de chegada da requisição, ANTES de
  // qualquer parsing/guard (remover depois).
  app.use((req: any, res: any, next: any) => {
    if (req.path === '/payments/create') {
      (req as any).__debugT0 = Date.now();
      console.log(`[timing][express] requisição chegou: 0ms (${req.method} ${req.path})`);
      res.on('finish', () => {
        console.log(`[timing][express] resposta ENVIADA: ${Date.now() - (req as any).__debugT0}ms`);
      });
    }
    next();
  });

  // =========================================
  // 🔥 WEBHOOK STRIPE (RAW BODY)
  //
  // ⚠️ O prefixo é /webhook (SINGULAR) — é o que o WebhookController registra.
  // Estava /webhooks aqui e por isso não casava com rota nenhuma: o body
  // chegava já parseado pelo bodyParser.json e a verificação de assinatura
  // falharia em TODO evento. Mesmo erro apontado no bloco da Whop abaixo.
  //
  // O path inclui :accountId (um endpoint por titular do pool), e express.use
  // casa por prefixo — /webhook/stripe cobre /webhook/stripe/stripe_br_01.
  // =========================================
  app.use(
    '/webhook/stripe',
    express.raw({ type: '*/*' })
  );

  // =========================================
  // 🔥 WEBHOOK SENTINEL (RAW BODY p/ verificar a assinatura HMAC)
  // =========================================
  app.use(
    '/webhooks/sentinel',
    express.raw({ type: '*/*' })
  );

  // =========================================
  // 🔥 WEBHOOK COINFLOW (RAW BODY p/ verificar a assinatura HMAC)
  // =========================================
  app.use(
    '/webhooks/coinflow',
    express.raw({ type: '*/*' })
  );

  // =========================================
  // 🔥 WEBHOOK WHOP (RAW BODY p/ verificar a assinatura Standard Webhooks)
  //
  // ⚠️ O prefixo é /webhook (singular) — é o que o WebhookController registra.
  // As três linhas acima usam /webhooks (plural) e por isso NÃO casam com rota
  // nenhuma; é provavelmente por isso que a verificação de assinatura do
  // Sentinel está comentada no webhook.service. Não repetir o erro aqui.
  // =========================================
  app.use(
    '/webhook/whop',
    express.raw({ type: '*/*' })
  );

  // =========================================
  // 🔥 WEBHOOK KONTINO CONNECT (RAW BODY p/ verificar a Kontino-Signature)
  // =========================================
  app.use(
    '/webhook/kontino',
    express.raw({ type: '*/*' })
  );

  // =========================================
  // 🔥 WEBHOOK SLASH (RAW BODY p/ verificar a assinatura RSA)
  // Prefixo /webhook (singular), o mesmo do WebhookController.
  // =========================================
  app.use(
    '/webhook/slash',
    express.raw({ type: '*/*' })
  );

  // =========================================
  // 🔥 REST NORMAL (JSON)
  //    Limite alto p/ uploads de documentos do onboarding (base64, vários
  //    arquivos de até 8MB → ~43MB no pior caso).
  // =========================================
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

  // =========================================
  // 🚀 START
  // =========================================
  const port = process.env.PORT || 3007
  await app.listen(port, '0.0.0.0');

  console.log('🚀 Server running on http://localhost:3007');
}

bootstrap();