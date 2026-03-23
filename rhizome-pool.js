// Shared PostgreSQL pool for rhizome-alkahest
const { Pool } = require('pg');
module.exports = new Pool({ database: 'rhizome-alkahest' });
