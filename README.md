# GIRA'S BEACH

Plataforma inicial para reservas de quadras de beach tennis, com cadastro/login, área administrativa, horários e integração de checkout Mercado Pago.

## Requisitos
- Node.js 22.13 ou superior (o projeto foi preparado para Node 24).
- Não precisa instalar PostgreSQL nem outro servidor de banco de dados.

## Instalação no Windows
1. Extraia o ZIP para uma pasta simples, por exemplo `C:\Projetos\GIRAS-BEACH`.
2. Abra essa pasta no VS Code.
3. No terminal, execute `npm install`.
4. Copie `.env.example` e renomeie a cópia para `.env`.
5. No `.env`, altere `SESSION_SECRET`, `ADMIN_EMAIL` e `ADMIN_PASSWORD` por valores seus. Use uma senha forte para o administrador. Não compartilhe o `.env`.
6. Execute `npm run db:init` para criar o banco e a conta de administrador.
7. Execute `npm run dev` e abra `http://localhost:3000`.

## Banco de dados
O SQLite é criado automaticamente em `data/giras-beach.sqlite`. As sessões ficam em `data/sessions.sqlite`. Faça backup desses arquivos. Para mudar a pasta, configure `DATA_DIR` no `.env`.

## Verificação
Abra `http://localhost:3000/api/health`. A resposta esperada inclui `"ok":true` e `"database":"connected"`.

## Mercado Pago
Preencha `MP_ACCESS_TOKEN` no `.env` com credenciais de teste antes de experimentar o checkout. PIX e cartão dependem da conta e credenciais do Mercado Pago. Não use credenciais reais em testes locais. Antes de produção, implemente e valide a assinatura criptográfica `x-signature` do webhook, configure HTTPS, `SESSION_SECRET` forte, backups e armazenamento persistente.

## Publicação
SQLite pode funcionar em hospedagem desde que o serviço ofereça disco/volume persistente e que `DATA_DIR` aponte para esse volume. Não use um filesystem temporário/efêmero para guardar reservas e usuários: os dados podem ser perdidos em reinicializações ou novos deploys. Para múltiplas instâncias simultâneas, prefira um banco gerenciado como PostgreSQL.

## Segurança importante
- Senhas são armazenadas com hash bcrypt.
- Rotas administrativas exigem sessão com papel `admin`.
- O cadastro público sempre cria usuário `customer`; não há campo público para escolher administrador.
- A confirmação de pagamento deve depender da notificação verificada do provedor, não apenas do retorno do navegador. A validação de assinatura do webhook ainda precisa ser concluída antes de receber pagamentos reais.
