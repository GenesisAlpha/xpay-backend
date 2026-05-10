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
  // 🔥 WEBHOOK STRIPE (RAW BODY)
  // =========================================
  app.use(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' })
  );

  // =========================================
  // 🔥 REST NORMAL (JSON)
  // =========================================
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // =========================================
  // 🔐 CORS (ajuste depois)
  // =========================================
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
  });

  // =========================================
  // 🚀 START
  // =========================================
  const port = process.env.PORT || 3005
  await app.listen(port, '0.0.0.0');

  console.log('🚀 Server running on http://localhost:3005');
}

bootstrap();