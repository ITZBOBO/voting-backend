import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function upsertRole(name, data) {
  return prisma.role.upsert({
    where: { name },
    update: {},
    create: { name, ...data },
  });
}

async function main() {
  const superAdminRole = await upsertRole('super_admin', {
    description: 'Main admin with full control',
    isSystemRole: true,
    isAdminRole: true,
    canVote: false,
  });

  await upsertRole('admin', {
    description: 'Admin with limited permissions',
    isSystemRole: true,
    isAdminRole: true,
    canVote: false,
  });

  await upsertRole('student', { description: 'Regular voter', canVote: true });
  await upsertRole('executive', { description: 'RUNSA executive', canVote: true });
  await upsertRole('pro', { description: 'RUNSA PRO', canVote: true });

  await prisma.electionType.upsert({ where: { name: 'departmental' }, update: {}, create: { name: 'departmental' } });
  await prisma.electionType.upsert({ where: { name: 'RUNSA' }, update: {}, create: { name: 'RUNSA' } });

  // NUC-accredited departments — Redeemer's University (RUN), Ede, Osun State
  const departments = [
    // College of Natural Sciences
    { name: 'Computer Science', code: 'CSC' },
    { name: 'Mathematics', code: 'MTH' },
    { name: 'Chemistry', code: 'CHM' },
    { name: 'Physics', code: 'PHY' },
    { name: 'Biochemistry', code: 'BCH' },
    { name: 'Microbiology', code: 'MCB' },
    // College of Management Sciences
    { name: 'Accounting', code: 'ACC' },
    { name: 'Business Administration', code: 'BUS' },
    { name: 'Economics', code: 'ECO' },
    { name: 'Mass Communication', code: 'MCS' },
    // College of Humanities, Law and Governance
    { name: 'Law', code: 'LAW' },
    { name: 'Political Science and International Relations', code: 'POL' },
    { name: 'English and Literary Studies', code: 'ELS' },
    { name: 'History and International Studies', code: 'HIS' },
    // College of Engineering and Technology
    { name: 'Chemical Engineering', code: 'CHE' },
    { name: 'Electrical and Electronics Engineering', code: 'EEE' },
    { name: 'Petroleum Engineering', code: 'PET' },
    // College of Social Sciences
    { name: 'Sociology', code: 'SOC' },
    { name: 'Psychology', code: 'PSY' },
  ];

  for (const d of departments) {
    await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name },
      create: d,
    });
  }

  const superAdminMatric = 'RUN/ADMIN/0001';
  const existing = await prisma.user.findUnique({ where: { matricNo: superAdminMatric } });

  if (!existing) {
    const passwordHash = await bcrypt.hash('Admin@12345', 12);
    const superAdmin = await prisma.user.create({
      data: { matricNo: superAdminMatric, fullName: 'Super Admin', passwordHash },
    });
    await prisma.userRole.create({ data: { userId: superAdmin.id, roleId: superAdminRole.id } });
    console.log('✅ Seeded Super Admin:', superAdminMatric, 'password: Admin@12345');
  } else {
    console.log('ℹ️ Super Admin already exists:', superAdminMatric);
  }

  console.log('✅ Seed complete.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(async () => {
  await prisma.$disconnect();
});
