
require('dotenv').config();

const bcrypt = require('bcryptjs');
const { db, initialize, dbPath } = require('../src/database/db');

async function main() {
  try {
    initialize();

    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    const name = process.env.ADMIN_NAME || "Administrador Gira's Beach";

    if (!email || !password) {
      throw new Error('Configure ADMIN_EMAIL e ADMIN_PASSWORD no arquivo .env');
    }

    const hash = await bcrypt.hash(password, 12);

    // Procura uma conta que já tenha o e-mail configurado.
    const existingUser = db.prepare(
      'SELECT id FROM users WHERE email = ?'
    ).get(email);

    if (existingUser) {
      // Transforma a conta existente em administradora.
      db.prepare(`
        UPDATE users
        SET name = ?, password_hash = ?, role = 'admin'
        WHERE id = ?
      `).run(name, hash, existingUser.id);

      console.log('Conta existente atualizada para administradora!');
    } else {
      // Se já houver um administrador, atualiza essa conta.
      const existingAdmin = db.prepare(
        "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
      ).get();

      if (existingAdmin) {
        db.prepare(`
          UPDATE users
          SET email = ?, name = ?, password_hash = ?
          WHERE id = ?
        `).run(email, name, hash, existingAdmin.id);

        console.log('Acesso administrativo atualizado!');
      } else {
        // Caso contrário, cria uma nova conta administrativa.
        db.prepare(`
          INSERT INTO users (name, email, phone, password_hash, role)
          VALUES (?, ?, '', ?, 'admin')
        `).run(name, email, hash);

        console.log('Conta administrativa criada!');
      }
    }

    console.log(`Banco inicializado: ${dbPath}`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('Erro ao configurar administrador:', err);
  process.exit(1);
});
