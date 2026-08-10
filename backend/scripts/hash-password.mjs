#!/usr/bin/env node
/**
 * Generates a bcrypt hash for the admin password.
 *
 *   npm run hash:password -- "YourStrongPassword"
 *
 * Copy the printed hash into ADMIN_PASSWORD_HASH in your .env file, or use
 * `npm run db:seed` to store it in the admin_users table. The plaintext password is
 * never written to disk or logged anywhere else.
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];

if (!password) {
  console.error('Usage: npm run hash:password -- "YourStrongPassword"');
  process.exit(1);
}

if (password.length < 12) {
  console.error('Refusing to hash: use a password of at least 12 characters.');
  process.exit(1);
}

const hash = await bcrypt.hash(password, 12);

console.log('\nAdd this to your .env file (keep the quotes off, keep the file private):\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
