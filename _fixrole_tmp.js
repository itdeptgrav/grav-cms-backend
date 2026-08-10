require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/grav_clothing';
  await mongoose.connect(uri);
  const DepartmentRole = require('./models/Access/DepartmentRole');
  const before = await DepartmentRole.find({ departmentSlug: 'sales' }).lean();
  console.log('SALES_ROLES_BEFORE', JSON.stringify(before.map(r => ({ email:r.email, role:r.role, active:r.isActive })), null, 2));
  console.log('DB', mongoose.connection.name);
  await mongoose.disconnect();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
