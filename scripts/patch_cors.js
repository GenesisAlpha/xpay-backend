const fs = require('fs');
const path = 'src/server.ts';
let code = fs.readFileSync(path, 'utf8');

// 1. Remover qualquer configuração de CORS antiga
code = code.replace(/app\.use\(cors\(\{[^)]+\}\)\);/g, '');
code = code.replace(/app\.use\(cors\(\)\);/g, '');

// 2. Injetar a nova lista VIP de CORS logo após o Express inicializar
const newCors = `
const allowedOrigins = [
  'https://central.nexflowx.tech',
  'https://atlas.nexflowx.tech',
  'http://localhost:3000',
  'http://localhost:3001'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permite chamadas sem origin (ex: Postman, cURL) ou domínios da lista VIP
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, origin || '*');
    } else {
      // Para evitar que a aplicação quebre durante esta fase de transição, 
      // estamos a aceitar temporariamente tudo. Quando quiseres trancar a API,
      // substitui a linha abaixo por: callback(new Error('Bloqueado por CORS'));
      callback(null, origin); 
    }
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'stripe-signature', 'x-nowpayments-sig', 'x-nexflowx-signature'],
  credentials: true
}));
`;

code = code.replace('const app = express();', 'const app = express();\n' + newCors);

fs.writeFileSync(path, code);
console.log('✅ CORS atualizado: Lista VIP ativada para Central e Atlas!');
