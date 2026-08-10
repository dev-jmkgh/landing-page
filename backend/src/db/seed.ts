import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { closePool, execute, queryOne, type RowDataPacket } from './pool';
import { describeError, logger } from '../utils/logger';
import { createReference } from '../utils/text';

/**
 * Seeds the first administrator, and — outside production only — a couple of sample
 * enquiries so the admin screen can be exercised locally.
 *
 * Usage:
 *   ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='StrongPassword' npm run db:seed
 *
 * The password is read from `SEED_ADMIN_PASSWORD` or an existing `ADMIN_PASSWORD_HASH`.
 * No password is ever hard-coded in this file.
 */

interface CountRow extends RowDataPacket {
  total: number;
}

async function seedAdmin(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? config.admin.email).trim().toLowerCase();
  const plainPassword = process.env.SEED_ADMIN_PASSWORD ?? '';
  const existingHash = config.admin.passwordHash;

  if (!email) {
    logger.warn('Skipping admin seed: set ADMIN_EMAIL (or SEED_ADMIN_EMAIL) first.');
    return;
  }

  if (!plainPassword && !existingHash) {
    logger.warn(
      'Skipping admin seed: provide SEED_ADMIN_PASSWORD, or generate ADMIN_PASSWORD_HASH with `npm run hash:password -- "YourPassword"`.',
    );
    return;
  }

  if (plainPassword && plainPassword.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters.');
  }

  const passwordHash = plainPassword ? await bcrypt.hash(plainPassword, 12) : existingHash;

  await execute(
    `INSERT INTO admin_users (email, password_hash, name, is_active)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1`,
    [email, passwordHash, 'JMK Administrator'],
  );

  logger.info('Admin user seeded', { email });
}

async function seedSampleEnquiries(): Promise<void> {
  if (config.isProduction) {
    logger.info('Production environment — skipping sample data.');
    return;
  }

  const existing = await queryOne<CountRow>('SELECT COUNT(*) AS total FROM enquiries');
  if ((existing?.total ?? 0) > 0) {
    logger.info('Enquiries table already has rows — skipping sample data.');
    return;
  }

  const samples = [
    {
      name: 'Sample Enquiry (development)',
      email: 'sample.enquiry@example.com',
      phone: '+91 90000 00001',
      company: 'Example Manufacturing',
      interestedIn: 'JMK Design Studio',
      message:
        'Development sample row created by `npm run db:seed`. Safe to delete. Enquiring about 3D modelling capacity.',
      source: 'contact-page',
      status: 'new',
    },
    {
      name: 'Sample Enquiry Two (development)',
      email: 'sample.two@example.com',
      phone: '+91 90000 00002',
      company: null,
      interestedIn: 'JMK Academy',
      message: 'Development sample row created by `npm run db:seed`. Safe to delete.',
      source: 'floating-widget',
      status: 'contacted',
    },
  ];

  for (const sample of samples) {
    await execute(
      `INSERT INTO enquiries
         (reference, name, email, phone, company, interested_in, message, source, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        createReference('ENQ'),
        sample.name,
        sample.email,
        sample.phone,
        sample.company,
        sample.interestedIn,
        sample.message,
        sample.source,
        sample.status,
      ],
    );
  }

  logger.info(`Inserted ${samples.length} sample enquiries (development only)`);
}

async function main(): Promise<void> {
  await seedAdmin();
  await seedSampleEnquiries();
}

if (require.main === module) {
  main()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(async (error) => {
      logger.error('Seed failed', describeError(error));
      await closePool().catch(() => undefined);
      process.exit(1);
    });
}
